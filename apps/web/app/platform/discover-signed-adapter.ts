import { importSealedConnect, myPrincipal, sealConnectBundle, SignedDirectoryClient, type DirectoryRead } from "@veil/features";
import type { UnlockedVault } from "@veil/vault";
import type { DirectoryAdapter } from "./discover-controller";

// Real signing/protocol client, with an injected transport only. No default/live endpoint.
// Connect bundles are sealed to the target's key on request, and imported only when the target accepts.
// A pending request grants nothing: no connection, no chat, no message until that explicit step.
const CONNECT_CLOCK = () => new Date();
const newId = () => globalThis.crypto.randomUUID();

function connectMarker(vault: UnlockedVault, from: string, to: string) { return `discover-connect:${from}:${to}`; }

export function signedDirectoryAdapter(client: SignedDirectoryClient, vault: UnlockedVault): DirectoryAdapter {
  // A sealed connect is imported once, then marked in the vault so reloads do not re-import it.
  async function importIfNew(from: string, to: string, sealed: string, senderPubkey: string) {
    const marker = connectMarker(vault, from, to);
    if (await vault.getJson(marker) === true) return;
    await importSealedConnect(vault, sealed, senderPubkey, { newId, now: CONNECT_CLOCK() });
    await vault.putJson("settings", marker, true);
  }
  async function fetchRaw(): Promise<DirectoryRead> { return client.execute({ action: "read" }); }
  return {
    read: async () => {
      const data = await fetchRaw();
      const me = await myPrincipal(vault);
      // Accepted connects I requested: import the bundle the target sent back.
      for (const request of data.requests) {
        if (request.from === me && request.status === "accepted" && request.acceptSealed) {
          await importIfNew(request.from, request.to, request.acceptSealed, request.toPubkey);
        }
      }
      return {
        cards: data.cards.map(({ id, name, handle, bio }) => ({ id, name, handle, bio })),
        ownCard: data.ownCard ? { id: data.ownCard.id, name: data.ownCard.name, handle: data.ownCard.handle, bio: data.ownCard.bio } : null,
        incoming: data.requests.filter((r) => r.to === me && r.status === "pending").map((r) => r.from),
      };
    },
    publish: async (card) => {
      const data = await client.execute({ action: "publish", card });
      if (!data.ownCard) throw new Error("Listing was not confirmed.");
      return { id: data.ownCard.id, name: data.ownCard.name, handle: data.ownCard.handle, bio: data.ownCard.bio };
    },
    hide: async () => {
      const data = await client.execute({ action: "hide" });
      if (data.ownCard) throw new Error("Hiding was not confirmed.");
    },
    request: async (target) => {
      const data = await fetchRaw();
      const card = data.cards.find((c) => c.id === target);
      if (!card) throw new Error("That card is no longer listed.");
      const sealed = await sealConnectBundle(vault, target, card.pubkey, CONNECT_CLOCK());
      const confirmed = await client.execute({ action: "request", target, sealed });
      const me = await myPrincipal(vault);
      const request = confirmed.requests.find((r) => r.from === me && r.to === target);
      if (!request || request.status === "declined") throw new Error("No pending request was confirmed.");
    },
    accept: async (requester) => {
      const data = await fetchRaw();
      const me = await myPrincipal(vault);
      const request = data.requests.find((r) => r.from === requester && r.to === me && r.status === "pending");
      if (!request || !request.requestSealed) throw new Error("No incoming request from that person.");
      // Import the requester's bundle first, then send mine back, sealed to them.
      await importIfNew(requester, me, request.requestSealed, request.fromPubkey);
      const sealed = await sealConnectBundle(vault, requester, request.fromPubkey, CONNECT_CLOCK());
      await client.execute({ action: "accept", target: requester, sealed });
    },
    decline: async (requester) => {
      await client.execute({ action: "decline", target: requester });
    },
  };
}

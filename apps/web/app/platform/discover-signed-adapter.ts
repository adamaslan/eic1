import { blockDiscoverPerson, importSealedConnect, listDiscoverBlocks, myPrincipal, sealConnectBundle, SignedDirectoryClient, unblockDiscoverPerson, type DirectoryRead } from "@veil/features";
import type { UnlockedVault } from "@veil/vault";
import type { DirectoryAdapter } from "./discover-controller";

// Real signing/protocol client, with an injected transport only. No default/live endpoint.
// Connect bundles are sealed to the target's key on request, and imported only when the target accepts.
// A pending request grants nothing: no connection, no chat, no message until that explicit step.
const CONNECT_CLOCK = () => new Date();
const newId = () => globalThis.crypto.randomUUID();

function connectMarker(vault: UnlockedVault, from: string, to: string) { return `discover-connect:${from}:${to}`; }

/**
 * `prepareFeed` runs before any connect is sealed. A bundle sealed before this vault has a relay feed carries no
 * feed URL, so the friend imports a connection with nothing to pull from and chat can never receive. It must throw
 * rather than let a feedless connect go out.
 */
export function signedDirectoryAdapter(client: SignedDirectoryClient, vault: UnlockedVault, prepareFeed: () => Promise<void> = async () => {}): DirectoryAdapter {
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
      const blocked = await listDiscoverBlocks(vault);
      const isBlocked = (id: string) => blocked.some((person) => person.id === id);
      // Accepted connects I requested: import the bundle the target sent back. Never from someone I blocked,
      // even if I asked them before blocking.
      for (const request of data.requests) {
        if (request.from === me && request.status === "accepted" && request.acceptSealed && !isBlocked(request.to)) {
          await importIfNew(request.from, request.to, request.acceptSealed, request.toPubkey);
        }
      }
      // A blocked person's pending request is declined, so it keeps no sealed material and cannot come back.
      const pending = data.requests.filter((r) => r.to === me && r.status === "pending");
      // A failed decline is retried on the next read; their request stays hidden either way.
      for (const request of pending.filter((r) => isBlocked(r.from))) await client.execute({ action: "decline", target: request.from }).catch(() => undefined);
      return {
        cards: data.cards.filter((card) => !isBlocked(card.id)).map(({ id, name, handle, bio }) => ({ id, name, handle, bio })),
        ownCard: data.ownCard ? { id: data.ownCard.id, name: data.ownCard.name, handle: data.ownCard.handle, bio: data.ownCard.bio } : null,
        incoming: pending.filter((r) => !isBlocked(r.from)).map((r) => r.from),
        blocked,
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
      await prepareFeed();
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
      await prepareFeed();
      const sealed = await sealConnectBundle(vault, requester, request.fromPubkey, CONNECT_CLOCK());
      await client.execute({ action: "accept", target: requester, sealed });
    },
    decline: async (requester) => {
      await client.execute({ action: "decline", target: requester });
    },
    // Saved locally first, so a failed decline still hides them. The next read retries the decline.
    block: async (person) => {
      const blocked = await blockDiscoverPerson(vault, person);
      try {
        const data = await fetchRaw();
        const me = await myPrincipal(vault);
        if (data.requests.some((r) => r.from === person.id && r.to === me && r.status === "pending")) await client.execute({ action: "decline", target: person.id });
      } catch {
        // Left for the next read.
      }
      return blocked;
    },
    unblock: (id) => unblockDiscoverPerson(vault, id),
  };
}

import { AppError, decodeBase64, encodeBase64 } from "@veil/core";
import { openSyncEnvelope, sealSyncEnvelope, type SyncEnvelope } from "@veil/crypto";
import type { UnlockedVault } from "@veil/vault";
import { publisherPath } from "./chat-relay";
import { buildShareBundle, importShareBundle, loadOrCreateShareIdentity } from "./sharing";
import { loadSettings } from "./social";

// Discover connect: a request carries my signed connect bundle, sealed so only the target can open it.
// The target's acceptance returns its bundle, sealed to me. Both sides import only on that explicit step,
// and the import is the normal signed share-bundle path, so the connection is verified like a connect link.
// Envelopes are addressed to principals (feed hashes), which each side can derive from the keys it already
// holds. The bundles inside carry the real author ids.

const Payload = { v: 1 as const };

/** My feed-hash principal. The directory admits a key only as the principal it owns. */
export async function principalOf(pubkeyBase64: string): Promise<string> {
  return (await publisherPath(pubkeyBase64)).slice("feeds/".length);
}

export async function myPrincipal(vault: UnlockedVault): Promise<string> {
  const identity = await loadOrCreateShareIdentity(vault);
  return principalOf(encodeBase64(identity.publicKey));
}

export async function sealConnectBundle(vault: UnlockedVault, recipientPrincipal: string, recipientPubkey: string, now: Date): Promise<string> {
  const settings = await loadSettings(vault);
  if (!settings.authorId || !settings.handle) throw new AppError("Choose your handle in Settings first.");
  const identity = await loadOrCreateShareIdentity(vault);
  const bundle = await buildShareBundle(vault, settings, [], now);
  const envelope = await sealSyncEnvelope({
    secretKey: identity.secretKey,
    authorId: await myPrincipal(vault),
    recipientAuthorId: recipientPrincipal,
    recipientPublicKey: decodeBase64(recipientPubkey),
    kind: "chat",
    plaintext: new TextEncoder().encode(JSON.stringify({ ...Payload, bundle: bundle.text })),
  });
  return JSON.stringify(envelope);
}

/** Opens a sealed connect and imports the bundle it carries. Throws if it is not addressed to me or not signed by the sender key. */
export async function importSealedConnect(
  vault: UnlockedVault,
  sealed: string,
  senderPubkey: string,
  deps: { newId: () => string; now: Date },
): Promise<void> {
  const settings = await loadSettings(vault);
  if (!settings.authorId) throw new AppError("This vault has no author id yet.");
  const identity = await loadOrCreateShareIdentity(vault);
  let envelope: SyncEnvelope;
  try { envelope = JSON.parse(sealed) as SyncEnvelope; } catch { throw new AppError("The connect is damaged."); }
  const opened = await openSyncEnvelope({
    secretKey: identity.secretKey,
    authorId: await myPrincipal(vault),
    authorPublicKey: decodeBase64(senderPubkey),
    envelope,
  });
  if (opened.kind !== "chat") throw new AppError("The connect is damaged.");
  let payload: { v?: unknown; bundle?: unknown };
  try { payload = JSON.parse(new TextDecoder().decode(opened.plaintext)); } catch { throw new AppError("The connect is damaged."); }
  if (payload.v !== 1 || typeof payload.bundle !== "string") throw new AppError("The connect is damaged.");
  await importShareBundle(vault, payload.bundle, { settings, newId: deps.newId, now: deps.now });
}

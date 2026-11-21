import type { UnlockedVault } from "@veil/vault";
import { loadSettings } from "./social";
import { loadOrCreateShareIdentity } from "./sharing";
import { SignedDirectoryClient, type DirectoryRead, type SignedDirectoryCommand } from "./discover-directory";
import { publisherPath } from "./chat-relay";
import { encodeBase64 } from "@veil/core";

// Independent vault record: changing visibility never edits chat/connections/settings fields.
export async function nextDirectorySequence(vault: UnlockedVault): Promise<number> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const raw = await vault.getJson("directory-sequence");
    if (raw !== null && (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0)) throw new Error("Directory sequence record is damaged.");
    const next = (raw as number | null ?? 0) + 1;
    if (!Number.isSafeInteger(next)) throw new Error("Directory sequence exhausted.");
    try { await vault.putJsonIfUnchanged("settings", "directory-sequence", next, raw); return next; }
    catch { /* Retry only the bounded CAS operation. Never reset a damaged counter. */ }
  }
  throw new Error("Directory sequence is busy. Try again.");
}

export async function vaultDirectoryClient(vault: UnlockedVault, transport: (envelope: SignedDirectoryCommand) => Promise<DirectoryRead>, now: () => number): Promise<SignedDirectoryClient> {
  const settings = await loadSettings(vault);
  if (!settings.authorId) throw new Error("Set up your connection identity first.");
  // No profile, contacts, posts or connection records are read by this adapter.
  const identity = await loadOrCreateShareIdentity(vault);
  // The principal is the publisher's feed hash: the relay admits a key only as the principal it owns.
  const principal = (await publisherPath(encodeBase64(identity.publicKey))).slice("feeds/".length);
  return new SignedDirectoryClient(principal, identity, () => nextDirectorySequence(vault), transport, now);
}

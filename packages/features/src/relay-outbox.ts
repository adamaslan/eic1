import { z } from "zod";
import { AppError, encodeBase64 } from "@veil/core";
import type { UnlockedVault } from "@veil/vault";
import { buildChatFeedSnapshot, publisherPath, verifyRelayPublish, type RelayPublishRequest } from "./chat-relay";
import { parseFeedManifest, verifyFeedManifest } from "./feed";
import { signRelayRead, type RelayReadRequest } from "./relay-adapter";
import { loadOrCreateShareIdentity } from "./sharing";
import { loadSettings } from "./social";

const SnapshotSchema = z.object({ manifest: z.string(), files: z.array(z.object({ path: z.string(), text: z.string() })).max(100) });
const OutboxSchema = z.object({ version: z.literal(1), authorId: z.string(), feedUrl: z.string(), seq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), pending: SnapshotSchema.nullable() });
const idFor = (authorId: string) => `relay-outbox:${authorId}`;
export interface RelayOutboxTransport {
  /** A success response is NOT delivery confirmation. Readback is always required. */
  publish(request: RelayPublishRequest): Promise<void>;
  read(request: RelayReadRequest): Promise<{ manifest: string }>;
}
export type RelayOutboxResult = { status: "confirmed" | "pending"; seq: number };

async function context(vault: UnlockedVault) {
  const settings = await loadSettings(vault);
  if (!settings.authorId || !settings.handle || !settings.feedUrl) throw new AppError("Save your handle and relay feed URL first.");
  const identity = await loadOrCreateShareIdentity(vault);
  const pubkey = encodeBase64(identity.publicKey);
  return { settings, identity, pubkey, id: idFor(settings.authorId), path: await publisherPath(pubkey) };
}
async function stateFor(vault: UnlockedVault, ctx: Awaited<ReturnType<typeof context>>) {
  const raw = await vault.getJson(ctx.id);
  const state = raw === null ? { version: 1 as const, authorId: ctx.settings.authorId!, feedUrl: ctx.settings.feedUrl!, seq: 0, pending: null } : OutboxSchema.parse(raw);
  if (state.authorId !== ctx.settings.authorId || state.feedUrl !== ctx.settings.feedUrl) throw new AppError("The relay identity or destination changed. Keep the saved outbox and review it before sending.");
  return { raw, state };
}

/** Explicit local preparation only. Encrypts the exact signed snapshot before any transport call.
 * Pending retries reuse those same bytes/sequence, including after reload or ambiguous success.
 * Concurrent tabs use vault CAS. No timers, background work, secrets, URL fetch or UI wiring.
 */
export async function prepareRelayOutbox(vault: UnlockedVault, now: Date): Promise<{ seq: number; reusedPending: boolean }> {
  const ctx = await context(vault); const { raw, state } = await stateFor(vault, ctx);
  if (state.pending) return { seq: state.seq, reusedPending: true };
  if (state.seq === Number.MAX_SAFE_INTEGER) throw new AppError("Relay sequence limit reached.");
  const seq = state.seq + 1;
  const pending = await buildChatFeedSnapshot(vault, ctx.settings, { now, seq });
  // HTTP candidate is deliberately stricter than the older feed's maximum backlog.
  if (new TextEncoder().encode(JSON.stringify(pending)).byteLength > 2 * 1024 * 1024) throw new AppError("The sealed chat backlog is too large for this relay. Nothing was sent.");
  await vault.putJsonIfUnchanged("settings", ctx.id, { ...state, seq, pending }, raw);
  return { seq, reusedPending: false };
}

/** Explicit retry of an already saved snapshot. Never clears on HTTP success alone.
 * A lost response / failed read / stale or mismatched signed head keeps pending bytes intact.
 * Confirmation means committed on relay, NOT received by another person or safe to delete.
 */
export async function attemptRelayOutbox(vault: UnlockedVault, transport: RelayOutboxTransport, now: Date): Promise<RelayOutboxResult> {
  const ctx = await context(vault); const { raw, state } = await stateFor(vault, ctx);
  if (!state.pending) throw new AppError("Prepare a sealed relay snapshot before sending.");
  const verified = await verifyRelayPublish(state.pending, { allowlist: [ctx.pubkey] });
  const ownManifest = parseFeedManifest(state.pending.manifest);
  await verifyFeedManifest(ownManifest, state.authorId, ctx.pubkey);
  if (verified.seq !== state.seq || verified.publisherPath !== ctx.path || ownManifest.feedUrl !== state.feedUrl) throw new AppError("The saved relay snapshot does not match this vault. Nothing was sent.");
  // Check the vault is still unlocked immediately before handing off sealed bytes.
  if (JSON.stringify(await vault.getJson(ctx.id)) !== JSON.stringify(raw)) throw new AppError("The saved outbox changed. Retry from the latest saved state.");
  try { await transport.publish(state.pending); } catch { /* Ambiguous: it may have committed. Read back. */ }
  const nonce = encodeBase64(globalThis.crypto.getRandomValues(new Uint8Array(24)));
  const read = { pubkey: ctx.pubkey, feedPath: ctx.path, ts: now.getTime(), nonce,
    signature: await signRelayRead(ctx.identity.secretKey, { feedPath: ctx.path, ts: now.getTime(), nonce }) };
  try {
    const response = await transport.read(read);
    const committed = parseFeedManifest(response.manifest);
    await verifyFeedManifest(committed, state.authorId, ctx.pubkey);
    if (response.manifest !== state.pending.manifest) return { status: "pending", seq: state.seq };
    // A concurrent tab/new state or lock makes this fail closed, not erase newer pending work.
    await vault.putJsonIfUnchanged("settings", ctx.id, { ...state, pending: null }, raw);
    return { status: "confirmed", seq: state.seq };
  } catch { return { status: "pending", seq: state.seq }; }
}

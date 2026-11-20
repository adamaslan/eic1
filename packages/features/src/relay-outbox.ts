import { z } from "zod";
import { AppError, encodeBase64 } from "@veil/core";
import type { UnlockedVault } from "@veil/vault";
import { buildChatFeedSnapshotWithMembers, publisherPath, verifyRelayPublish, type RelayPublishRequest } from "./chat-relay";
import { parseFeedManifest, verifyFeedManifest } from "./feed";
import { signRelayRead, type RelayReadRequest } from "./relay-adapter";
import { loadOrCreateShareIdentity } from "./sharing";
import { countUnreceiptedInbound, listOutboundMessages, markSnapshotConfirmed } from "./chat";
import { loadSettings } from "./social";

const SnapshotSchema = z.object({ manifest: z.string(), files: z.array(z.object({ path: z.string(), text: z.string() })).max(100) });
// pendingMembers: the exact envelope signatures inside the pending snapshot (outbound messages, and inbound messages its
// receipts cover). Stored with the pending bytes so retries, reloads and ambiguous responses keep the same membership.
// autoFailures: consecutive failed automatic receipt-only publications; bounds the retry loop (reset on any confirmation).
const MembersSchema = z.object({ outbound: z.array(z.string()).max(100000), receipted: z.array(z.string()).max(100000) });
const OutboxSchema = z.object({ version: z.literal(1), authorId: z.string(), feedUrl: z.string(), seq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), pending: SnapshotSchema.nullable(), pendingMembers: MembersSchema.nullish(), autoFailures: z.number().int().nonnegative().nullish() });
const idFor = (authorId: string) => `relay-outbox:${authorId}`;
export interface RelayOutboxTransport {
  /** A success response is NOT delivery confirmation. Readback is always required. */
  publish(request: RelayPublishRequest): Promise<void>;
  read(request: RelayReadRequest): Promise<{ manifest: string }>;
}
/** deferred: the saved snapshot is over the connection's byte budget, so nothing was sent; it waits intact for Wi-Fi or opt-in. */
export type RelayOutboxResult = { status: "confirmed" | "pending" | "deferred"; seq: number };
export interface RelayOutboxOptions { /** Largest snapshot to send now (network byte budget). Null/absent: unrestricted. */ maxBytes?: number | null }

async function context(vault: UnlockedVault) {
  const settings = await loadSettings(vault);
  if (!settings.authorId || !settings.handle || !settings.feedUrl) throw new AppError("Save your handle and relay feed URL first.");
  const identity = await loadOrCreateShareIdentity(vault);
  const pubkey = encodeBase64(identity.publicKey);
  return { settings, identity, pubkey, id: idFor(settings.authorId), path: await publisherPath(pubkey) };
}
async function stateFor(vault: UnlockedVault, ctx: Awaited<ReturnType<typeof context>>) {
  const raw = await vault.getJson(ctx.id);
  const state = raw === null ? { version: 1 as const, authorId: ctx.settings.authorId!, feedUrl: ctx.settings.feedUrl!, seq: 0, pending: null, pendingMembers: null, autoFailures: 0 } : OutboxSchema.parse(raw);
  if (state.authorId !== ctx.settings.authorId || state.feedUrl !== ctx.settings.feedUrl) throw new AppError("The relay identity or destination changed. Keep the saved outbox and review it before sending.");
  return { raw, state };
}

/** Automatic receipt-only publication stops after this many consecutive failures, until a manual retry confirms. */
export const RECEIPT_AUTO_RETRY_MAX = 5;

/** True while any sent message is still neither accepted by the relay nor delivered. Drives automatic retry. */
export async function hasUnacceptedOutbound(vault: UnlockedVault): Promise<boolean> {
  return (await listOutboundMessages(vault)).some((m) => m.envelope && !m.deliveredAt && !m.acceptedAt);
}

/** Why an automatic pass should publish. "messages" always retries. "receipts" (receive-only: saved messages whose
 * receipt no confirmed snapshot has carried) is bounded by RECEIPT_AUTO_RETRY_MAX so a dead relay cannot loop. */
export async function relayPublishReason(vault: UnlockedVault): Promise<"messages" | "receipts" | null> {
  if (await hasUnacceptedOutbound(vault)) return "messages";
  if ((await countUnreceiptedInbound(vault)) === 0) return null;
  const settings = await loadSettings(vault);
  const raw = settings.authorId ? await vault.getJson(idFor(settings.authorId)) : null;
  const failures = raw === null ? 0 : (OutboxSchema.parse(raw).autoFailures ?? 0);
  return failures >= RECEIPT_AUTO_RETRY_MAX ? null : "receipts";
}

/** Records one automatic receipt-only publication failure. Best effort: a concurrent write just skips the count. */
export async function noteReceiptPublishFailure(vault: UnlockedVault): Promise<void> {
  try {
    const ctx = await context(vault); const { raw, state } = await stateFor(vault, ctx);
    await vault.putJsonIfUnchanged("settings", ctx.id, { ...state, autoFailures: (state.autoFailures ?? 0) + 1 }, raw);
  } catch { /* counting is advisory */ }
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
  // Membership comes from the same single read that built the snapshot, so a message saved afterwards is never
  // marked accepted by it, even with an identical sentAt.
  const { snapshot: pending, members: pendingMembers } = await buildChatFeedSnapshotWithMembers(vault, ctx.settings, { now, seq });
  // HTTP candidate is deliberately stricter than the older feed's maximum backlog.
  if (new TextEncoder().encode(JSON.stringify(pending)).byteLength > 2 * 1024 * 1024) throw new AppError("The sealed chat backlog is too large for this relay. Nothing was sent.");
  await vault.putJsonIfUnchanged("settings", ctx.id, { ...state, seq, pending, pendingMembers }, raw);
  return { seq, reusedPending: false };
}

/** Explicit retry of an already saved snapshot. Never clears on HTTP success alone.
 * A lost response / failed read / stale or mismatched signed head keeps pending bytes intact.
 * Confirmation means committed on relay, NOT received by another person or safe to delete.
 */
export async function attemptRelayOutbox(vault: UnlockedVault, transport: RelayOutboxTransport, now: Date, opts: RelayOutboxOptions = {}): Promise<RelayOutboxResult> {
  const ctx = await context(vault); const { raw, state } = await stateFor(vault, ctx);
  if (!state.pending) throw new AppError("Prepare a sealed relay snapshot before sending.");
  const verified = await verifyRelayPublish(state.pending, { allowlist: [ctx.pubkey] });
  const ownManifest = parseFeedManifest(state.pending.manifest);
  await verifyFeedManifest(ownManifest, state.authorId, ctx.pubkey);
  if (verified.seq !== state.seq || verified.publisherPath !== ctx.path || ownManifest.feedUrl !== state.feedUrl) throw new AppError("The saved relay snapshot does not match this vault. Nothing was sent.");
  if (opts.maxBytes != null && new TextEncoder().encode(JSON.stringify(state.pending)).byteLength > opts.maxBytes) return { status: "deferred", seq: state.seq };
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
    // The relay committed exactly these bytes. Mark only the members first (idempotent), then clear pending; if the
    // clear loses a CAS race the next attempt re-verifies and re-marks harmlessly.
    await markSnapshotConfirmed(vault, state.pendingMembers ?? { outbound: [], receipted: [] }, now.toISOString());
    await vault.putJsonIfUnchanged("settings", ctx.id, { ...state, pending: null, pendingMembers: null, autoFailures: 0 }, raw);
    return { status: "confirmed", seq: state.seq };
  } catch { return { status: "pending", seq: state.seq }; }
}

/** Send/Retry entry point: seal-or-reuse, attempt, and make sure the newest messages go out.
 * Messages saved while an older snapshot is still pending (offline sends) are not in that older
 * snapshot, so confirming it alone would report success while they never reach the relay. When a
 * reused pending snapshot confirms, immediately seal and send a fresh one. A failure of the second
 * attempt leaves it pending for the next explicit retry; nothing is cleared early. */
export async function publishRelaySnapshot(vault: UnlockedVault, transport: RelayOutboxTransport, now: () => Date, opts: RelayOutboxOptions = {}): Promise<RelayOutboxResult> {
  const prepared = await prepareRelayOutbox(vault, now());
  const result = await attemptRelayOutbox(vault, transport, now(), opts);
  if (!prepared.reusedPending || result.status !== "confirmed") return result;
  await prepareRelayOutbox(vault, now());
  return attemptRelayOutbox(vault, transport, now(), opts);
}

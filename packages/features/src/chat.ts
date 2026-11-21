import { z } from "zod";
import { AppError, decodeBase64, encodeBase64, type Bytes } from "@veil/core";
import { openSyncEnvelope, sealSyncEnvelope, sha256Hex, type SyncEnvelope } from "@veil/crypto";
import type { UnlockedVault } from "@veil/vault";
import { loadOrCreateShareIdentity } from "./sharing";
import { listConnections, loadSettings } from "./social";

// Chat over the pull model (spec section 3): outbound messages are sealed eic-sync v1
// envelopes addressed to the connection's verified identity and stored in MY vault; the
// feed publish (#16) ships them, their app pulls and applies inbound. Rendering is always
// from local records - the network is only a catch-up layer.

export const CHAT_KIND = "chat";
export const CHAT_BODY_MAX = 2000;

/**
 * User-facing copy for a failed send. AppError messages are written for users and pass
 * through; anything else (crypto, IndexedDB, etc.) gets a generic line that stays honest:
 * the route only clears the draft on success, so the unsent text is still in the box.
 */
export function describeSendError(caught: unknown): string {
  if (caught instanceof AppError) return caught.message;
  return "That did not send. Your message is still in the box - please try again.";
}

export const ChatMessageSchema = z.object({
  v: z.literal(1),
  id: z.string().min(1),
  threadAuthorId: z.string().min(1),
  direction: z.enum(["in", "out"]),
  body: z.string().min(1).max(CHAT_BODY_MAX),
  sentAt: z.string().min(1),
  readAt: z.string().nullable(),
  // Outbound: the sealed envelope to publish into my feed. Inbound: the envelope it arrived in.
  envelope: z.unknown().nullable(),
  // Inbound idempotency key: the sender's envelope signature.
  envelopeSignature: z.string().nullable(),
  // Outbound only: set when the recipient's signed receipt says they saved this message.
  deliveredAt: z.string().nullish(),
  // Outbound only: set when a relay snapshot that exactly contained this envelope was read back and confirmed.
  acceptedAt: z.string().nullish(),
  // Inbound only: set when a confirmed relay snapshot carried a receipt covering this message.
  receiptPublishedAt: z.string().nullish(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

const ChatPayloadSchema = z.object({
  v: z.literal(1),
  body: z.string().min(1).max(CHAT_BODY_MAX),
  sentAt: z.string().min(1),
});

// A receipt is a chat envelope whose sealed payload is an ack, not a message. The recipient
// sends the signatures of the envelopes it has saved, newest first, capped so the chunk stays small.
// Receipts cover the newest RECEIPT_MAX inbound messages per friend. Older unacknowledged ones remain a known limit.
export const RECEIPT_MAX = 500;
const ReceiptPayloadSchema = z.object({
  v: z.literal(1),
  ack: z.object({ ids: z.array(z.string().min(1).max(256)).max(RECEIPT_MAX) }),
});

export type OutboundStatus = "queued" | "accepted" | "delivered";

/** queued: saved on this device only. accepted: a relay snapshot that contained this exact envelope was
 * read back and confirmed (acceptedAt). delivered: the recipient's signed receipt arrived.
 * Accepted is NOT delivery: only the recipient's own receipt sets delivered. */
export function outboundStatus(message: ChatMessage): OutboundStatus {
  if (message.direction !== "out") throw new AppError("Only sent messages have a delivery status.");
  if (message.deliveredAt) return "delivered";
  if (message.acceptedAt) return "accepted";
  return "queued";
}

export async function listOutboundMessages(vault: UnlockedVault): Promise<ChatMessage[]> {
  return (await listAllMessages(vault)).filter((m) => m.direction === "out");
}

export interface ChatDeps {
  newId: () => string;
  now: () => Date;
}

function recordIdFor(messageId: string): string {
  return `chat:${messageId}`;
}

// Cross-tab idempotency key: two tabs can both pass the check-then-act scan below (each
// saw no existing row before either wrote) and would duplicate the message under fresh
// ids. Deriving the inbound id from the envelope signature makes both write the SAME
// record, so the loser overwrites an identical row instead of duplicating. markThreadRead
// addresses records via recordIdFor(message.id), so the message id itself must be this one.
function inboundMessageId(signature: string): string {
  return `in-${sha256Hex(`eic-chat-inbound:${signature}`)}`;
}

async function listAllMessages(vault: UnlockedVault): Promise<ChatMessage[]> {
  const raw = await vault.listJson(CHAT_KIND as never, { skipUndecryptable: true });
  const out: ChatMessage[] = [];
  for (const value of raw) {
    const parsed = ChatMessageSchema.safeParse(value);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

export async function listChatThread(vault: UnlockedVault, threadAuthorId: string): Promise<ChatMessage[]> {
  const messages = (await listAllMessages(vault)).filter((m) => m.threadAuthorId === threadAuthorId);
  return messages.sort((a, b) => (a.sentAt === b.sentAt ? a.id.localeCompare(b.id) : a.sentAt.localeCompare(b.sentAt)));
}

export async function unreadCounts(vault: UnlockedVault): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const m of await listAllMessages(vault)) {
    if (m.direction === "in" && m.readAt === null) counts[m.threadAuthorId] = (counts[m.threadAuthorId] ?? 0) + 1;
  }
  return counts;
}

export async function markThreadRead(vault: UnlockedVault, threadAuthorId: string, now: Date): Promise<number> {
  const unread = (await listAllMessages(vault)).filter((m) => m.threadAuthorId === threadAuthorId && m.direction === "in" && m.readAt === null);
  const stamp = now.toISOString();
  for (const m of unread) {
    await vault.putJson(CHAT_KIND as never, recordIdFor(m.id), { ...m, readAt: stamp });
  }
  return unread.length;
}

export async function sendChatMessage(
  vault: UnlockedVault,
  connection: { id: string; pubkey: string | null },
  body: string,
  deps: ChatDeps,
): Promise<ChatMessage> {
  const text = body.trim();
  if (!text) throw new AppError("Write something first.");
  if (text.length > CHAT_BODY_MAX) throw new AppError(`Keep messages under ${CHAT_BODY_MAX} characters.`);
  if (!connection.pubkey) {
    throw new AppError("This connection came from an unsigned share file. Chat needs a verified connection.");
  }
  const [settings, identity] = await Promise.all([loadSettings(vault), loadOrCreateShareIdentity(vault)]);
  if (!settings.authorId) throw new AppError("Save a handle before chatting.");
  const sentAt = deps.now().toISOString();
  const envelope = await sealSyncEnvelope({
    secretKey: identity.secretKey,
    authorId: settings.authorId,
    recipientAuthorId: connection.id,
    recipientPublicKey: decodeBase64(connection.pubkey),
    kind: "chat",
    plaintext: new TextEncoder().encode(JSON.stringify({ v: 1, body: text, sentAt })),
  });
  const message: ChatMessage = {
    v: 1,
    id: deps.newId(),
    threadAuthorId: connection.id,
    direction: "out",
    body: text,
    sentAt,
    readAt: null,
    envelope,
    envelopeSignature: null,
  };
  await vault.putJson(CHAT_KIND as never, recordIdFor(message.id), message);
  return message;
}

export async function applyInboundChatEnvelope(
  vault: UnlockedVault,
  envelope: unknown,
  deps: ChatDeps,
): Promise<{ applied: boolean; message: ChatMessage | null; delivered?: number }> {
  const e = envelope as Partial<SyncEnvelope> | null;
  if (!e || typeof e.authorId !== "string" || typeof e.signature !== "string") {
    throw new AppError("The chat envelope is damaged.");
  }
  // Idempotent: a feed re-pull must not duplicate the message.
  const existing = (await listAllMessages(vault)).find((m) => m.envelopeSignature === e.signature);
  if (existing) return { applied: false, message: existing };
  const connections = await listConnections(vault);
  const sender = connections.find((c) => c.id === e.authorId);
  if (!sender) throw new AppError("This chat envelope is from an unknown connection.");
  if (!sender.pubkey) throw new AppError("This connection has no verified key.");
  const identity = await loadOrCreateShareIdentity(vault);
  const settings = await loadSettings(vault);
  if (!settings.authorId) throw new AppError("This vault has no author id yet.");
  const opened = await openSyncEnvelope({
    secretKey: identity.secretKey,
    authorId: settings.authorId,
    authorPublicKey: decodeBase64(sender.pubkey),
    envelope,
  });
  if (opened.kind !== "chat") throw new AppError("That envelope is not a chat message.");
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder().decode(opened.plaintext));
  } catch {
    throw new AppError("The chat message is damaged.");
  }
  const receipt = ReceiptPayloadSchema.safeParse(decoded);
  if (receipt.success) {
    // Receipts are not messages: they only mark my sent messages as delivered. Idempotent.
    const delivered = await markDelivered(vault, sender.id, receipt.data.ack.ids, deps.now().toISOString());
    return { applied: false, message: null, delivered };
  }
  let payload: z.infer<typeof ChatPayloadSchema>;
  try {
    payload = ChatPayloadSchema.parse(decoded);
  } catch {
    throw new AppError("The chat message is damaged.");
  }
  const message: ChatMessage = {
    v: 1,
    id: inboundMessageId(e.signature),
    threadAuthorId: sender.id,
    direction: "in",
    body: payload.body,
    sentAt: payload.sentAt,
    readAt: null,
    envelope,
    envelopeSignature: e.signature,
  };
  const recordId = recordIdFor(message.id);
  try {
    // Atomic insert-if-absent: two racing receivers can both pass the absent scan above.
    // The loser must not overwrite the winner's record - that would reset a readAt the
    // winner (or the user) already stamped. The vault CAS enforces expected=null inside
    // the same store transaction, so this check-and-write cannot interleave.
    await vault.putJsonIfUnchanged(CHAT_KIND as never, recordId, message, null);
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    // Conflict: the other receiver won. Return its record as-is so readAt survives.
    const winner = (await vault.getJson(recordId)) as ChatMessage | null;
    if (winner && winner.envelopeSignature === e.signature) {
      return { applied: false, message: winner };
    }
    throw error;
  }
  return { applied: true, message };
}

/** Returns how many sent messages this receipt newly marked, so a view can tell a receipt changed something. */
async function markDelivered(vault: UnlockedVault, threadAuthorId: string, ids: string[], at: string): Promise<number> {
  const wanted = new Set(ids);
  let marked = 0;
  for (const message of await listOutboundMessages(vault)) {
    if (message.threadAuthorId !== threadAuthorId || message.deliveredAt) continue;
    const signature = (message.envelope as Partial<SyncEnvelope> | null)?.signature;
    if (signature && wanted.has(signature)) {
      await vault.putJson(CHAT_KIND as never, recordIdFor(message.id), { ...message, deliveredAt: at });
      marked += 1;
    }
  }
  return marked;
}

/** Marks exactly the messages whose envelopes were in a confirmed snapshot (outbound -> acceptedAt) and the
 * inbound messages covered by a receipt in it (receiptPublishedAt). Membership is by envelope signature, never
 * by time, so a message saved after the snapshot was built stays queued even with an identical sentAt. */
export async function markSnapshotConfirmed(
  vault: UnlockedVault,
  members: { outbound: string[]; receipted: string[] },
  at: string,
): Promise<void> {
  const out = new Set(members.outbound);
  const rec = new Set(members.receipted);
  for (const message of await listAllMessages(vault)) {
    if (message.direction === "out") {
      const signature = (message.envelope as Partial<SyncEnvelope> | null)?.signature;
      if (signature && out.has(signature) && !message.acceptedAt) {
        await vault.putJson(CHAT_KIND as never, recordIdFor(message.id), { ...message, acceptedAt: at });
      }
    } else if (message.envelopeSignature && rec.has(message.envelopeSignature) && !message.receiptPublishedAt) {
      await vault.putJson(CHAT_KIND as never, recordIdFor(message.id), { ...message, receiptPublishedAt: at });
    }
  }
}

/** Inbound messages saved here whose receipt no confirmed snapshot has carried yet. */
export async function countUnreceiptedInbound(vault: UnlockedVault): Promise<number> {
  const settings = await loadSettings(vault);
  if (!settings.authorId) return 0;
  const known = new Set((await listConnections(vault)).filter((c) => c.pubkey).map((c) => c.id));
  return (await listAllMessages(vault)).filter(
    (m) => m.direction === "in" && m.envelopeSignature && !m.receiptPublishedAt && known.has(m.threadAuthorId),
  ).length;
}

/** One signed receipt per connection that has sent me messages: the newest RECEIPT_MAX signatures
 * I have saved from them. Sealed to the sender, so the relay sees only an opaque envelope. */
async function receiptEnvelopes(vault: UnlockedVault, all: ChatMessage[]): Promise<{ out: Map<string, SyncEnvelope[]>; receipted: string[] }> {
  const out = new Map<string, SyncEnvelope[]>();
  const receipted: string[] = [];
  const settings = await loadSettings(vault);
  if (!settings.authorId) return { out, receipted };
  const inbound = all.filter((m) => m.direction === "in" && m.envelopeSignature);
  const identity = await loadOrCreateShareIdentity(vault);
  for (const connection of await listConnections(vault)) {
    if (!connection.pubkey) continue;
    const ids = inbound
      .filter((m) => m.threadAuthorId === connection.id)
      .sort((a, b) => b.sentAt.localeCompare(a.sentAt))
      .slice(0, RECEIPT_MAX)
      .map((m) => m.envelopeSignature as string);
    if (ids.length === 0) continue;
    const envelope = await sealSyncEnvelope({
      secretKey: identity.secretKey,
      authorId: settings.authorId,
      recipientAuthorId: connection.id,
      recipientPublicKey: decodeBase64(connection.pubkey),
      kind: "chat",
      plaintext: new TextEncoder().encode(JSON.stringify({ v: 1, ack: { ids } })),
    });
    out.set(connection.id, [envelope]);
    receipted.push(...ids);
  }
  return { out, receipted };
}

export interface OutboundChatCollection {
  byRecipient: Map<string, SyncEnvelope[]>;
  /** Signatures of the outbound message envelopes in byRecipient: the exact membership of a snapshot built from it. */
  outbound: string[];
  /** Signatures of inbound messages covered by the receipts in byRecipient. */
  receipted: string[];
}

/** One consistent read of the thread store. A message saved after this read is in neither the envelopes nor the
 * membership lists, so it can never be marked accepted by a snapshot that omitted it. */
export async function collectOutboundChat(vault: UnlockedVault): Promise<OutboundChatCollection> {
  const all = await listAllMessages(vault);
  const byRecipient = new Map<string, SyncEnvelope[]>();
  const outbound: string[] = [];
  for (const message of all) {
    if (message.direction !== "out" || !message.envelope || message.deliveredAt) continue;
    const envelope = message.envelope as SyncEnvelope;
    const list = byRecipient.get(message.threadAuthorId) ?? [];
    list.push(envelope);
    byRecipient.set(message.threadAuthorId, list);
    outbound.push(envelope.signature);
  }
  const { out, receipted } = await receiptEnvelopes(vault, all);
  for (const [recipientId, receipts] of out) {
    byRecipient.set(recipientId, [...(byRecipient.get(recipientId) ?? []), ...receipts]);
  }
  return { byRecipient, outbound, receipted };
}

/** Outbound chat envelopes grouped by recipient, for the feed publish (#16). Envelopes only - bodies stay local.
 * Delivered messages are dropped (the recipient already has them), which bounds the feed. Each recipient's
 * receipt rides in the same chunk, so the existing pull path delivers it without a new route. */
export async function listOutboundChatEnvelopes(vault: UnlockedVault): Promise<Map<string, SyncEnvelope[]>> {
  return (await collectOutboundChat(vault)).byRecipient;
}

import { z } from "zod";
import { AppError, decodeBase64, encodeBase64, type Bytes } from "@veil/core";
import { openSyncEnvelope, sealSyncEnvelope, type SyncEnvelope } from "@veil/crypto";
import type { UnlockedVault } from "@veil/vault";
import { loadOrCreateShareIdentity } from "./sharing";
import { listConnections, loadSettings } from "./social";

// Chat over the pull model (spec section 3): outbound messages are sealed eic-sync v1
// envelopes addressed to the connection's verified identity and stored in MY vault; the
// feed publish (#16) ships them, their app pulls and applies inbound. Rendering is always
// from local records - the network is only a catch-up layer.

export const CHAT_KIND = "chat";
export const CHAT_BODY_MAX = 2000;

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
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

const ChatPayloadSchema = z.object({
  v: z.literal(1),
  body: z.string().min(1).max(CHAT_BODY_MAX),
  sentAt: z.string().min(1),
});

export interface ChatDeps {
  newId: () => string;
  now: () => Date;
}

function recordIdFor(messageId: string): string {
  return `chat:${messageId}`;
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
  connection: { authorId: string; pubkey: string | null },
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
): Promise<{ applied: boolean; message: ChatMessage | null }> {
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
  let payload: z.infer<typeof ChatPayloadSchema>;
  try {
    payload = ChatPayloadSchema.parse(JSON.parse(new TextDecoder().decode(opened.plaintext)));
  } catch {
    throw new AppError("The chat message is damaged.");
  }
  const message: ChatMessage = {
    v: 1,
    id: deps.newId(),
    threadAuthorId: sender.id,
    direction: "in",
    body: payload.body,
    sentAt: payload.sentAt,
    readAt: null,
    envelope,
    envelopeSignature: e.signature,
  };
  await vault.putJson(CHAT_KIND as never, recordIdFor(message.id), message);
  return { applied: true, message };
}

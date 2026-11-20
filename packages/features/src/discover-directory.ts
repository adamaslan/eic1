import { z } from "zod";
import { decodeBase64, encodeBase64 } from "@veil/core";
import { signPayload, verifySignature, type SigningKeyPair } from "@veil/crypto";
import { publisherPath } from "./chat-relay";

// Host-neutral directory protocol. No HTTP endpoint, storage binding or deployment is enabled.
// An admission function must bind an existing principal ID to its pinned signing key.
const Id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).refine((id) => !["__proto__", "prototype", "constructor"].includes(id));
const Card = z.object({ name: z.string().trim().min(1).max(40), handle: z.string().regex(/^[a-zA-Z0-9_.-]{1,30}$/), bio: z.string().max(160) }).strict();
const Base = { domain: z.literal("eic-directory-v1"), principal: Id, seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), at: z.number().int().nonnegative() };
const Command = z.discriminatedUnion("action", [
  z.object({ ...Base, action: z.literal("read") }).strict(),
  z.object({ ...Base, action: z.literal("publish"), card: Card }).strict(),
  z.object({ ...Base, action: z.literal("hide") }).strict(),
  z.object({ ...Base, action: z.literal("request"), target: Id }).strict(),
  z.object({ ...Base, action: z.literal("accept"), target: Id }).strict(),
  z.object({ ...Base, action: z.literal("decline"), target: Id }).strict(),
]);
export type DirectoryCommand = z.infer<typeof Command>;
export type DirectoryAction = { action: "read" | "hide" } | { action: "publish"; card: z.infer<typeof Card> } | { action: "request" | "accept" | "decline"; target: string };
export type SignedDirectoryCommand = { command: DirectoryCommand; pubkey: string; signature: string };
const Envelope = z.object({ command: Command, pubkey: z.string().max(64), signature: z.string().max(128) }).strict();
export type DirectoryListing = z.infer<typeof Card> & { id: string; expiresAt: number };
export type DirectoryRequest = { from: string; to: string; status: "pending" | "accepted" | "declined"; updatedAt: number };
export type DirectoryRead = { cards: DirectoryListing[]; ownCard: DirectoryListing | null; requests: DirectoryRequest[] };
export type DirectoryDatabase = { cards: Record<string, DirectoryListing>; requests: Record<string, DirectoryRequest>; actors: Record<string, { seq: number; minute: number; count: number }> };
export interface DirectoryAtomicStore {
  read(): Promise<{ generation: string; value: DirectoryDatabase }>;
  // Must be atomic across processes. The demo memory implementation is NOT a deployment binding.
  compareAndSet(generation: string, value: DirectoryDatabase): Promise<boolean>;
}
export const emptyDirectory = (): DirectoryDatabase => ({ cards: {}, requests: {}, actors: {} });
const encoded = (command: DirectoryCommand) => new TextEncoder().encode(JSON.stringify(command));

export async function signDirectoryCommand(command: DirectoryCommand, identity: SigningKeyPair): Promise<SignedDirectoryCommand> {
  const parsed = Command.parse(command);
  return { command: parsed, pubkey: encodeBase64(identity.publicKey), signature: encodeBase64(await signPayload(identity.secretKey, encoded(parsed))) };
}

/** A principal is the publisher's feed hash, so a key can only act as the principal it owns. */
export async function admitDirectoryPrincipal(isMember: (pubkey: string) => Promise<boolean>, principal: string, pubkey: string): Promise<boolean> {
  if (`feeds/${principal}` !== await publisherPath(pubkey)) return false;
  return isMember(pubkey);
}

export class DirectoryService {
  constructor(private store: DirectoryAtomicStore, private admit: (principal: string, pubkey: string) => Promise<boolean>, private now: () => number) {}
  async execute(raw: unknown): Promise<DirectoryRead> {
    // Bound before signature or storage work. Never persist unverified envelopes.
    if (JSON.stringify(raw).length > 4096) throw new Error("Directory command too large.");
    const envelope = Envelope.parse(raw); const c = envelope.command;
    if (!(await this.admit(c.principal, envelope.pubkey))) throw new Error("Directory identity is not admitted.");
    const keyBytes = decodeBase64(envelope.pubkey); const signature = decodeBase64(envelope.signature);
    if (keyBytes.length !== 32 || signature.length !== 64 || !await verifySignature(keyBytes, encoded(c), signature)) throw new Error("Invalid directory signature.");
    const now = this.now();
    if (Math.abs(now - c.at) > 300_000) throw new Error("Directory command expired.");
    for (let attempt = 0; attempt < 4; attempt++) {
      const snapshot = await this.store.read();
      const state = structuredClone(snapshot.value);
      const actor = state.actors[c.principal]; const minute = Math.floor(now / 60_000);
      if (actor && c.seq <= actor.seq) throw new Error("Replayed directory command.");
      const count = actor?.minute === minute ? actor.count + 1 : 1;
      if (count > 30) throw new Error("Directory rate limit.");
      const live = (id: string) => state.cards[id] && state.cards[id].expiresAt > now;
      if (c.action === "publish") {
        if (!state.cards[c.principal] && Object.keys(state.cards).length >= 10_000) throw new Error("Directory capacity reached.");
        state.cards[c.principal] = { id: c.principal, ...c.card, expiresAt: now + 7 * 86_400_000 };
      } else if (c.action === "hide") {
        // This affects only the caller's new directory card, never relay/vault data.
        delete state.cards[c.principal];
      } else if (c.action === "request") {
        if (c.target === c.principal || !live(c.target)) throw new Error("That directory card is unavailable.");
        const id = `${c.principal}:${c.target}`; const existing = state.requests[id];
        // Declined requests do not resurrect when the sender retries or changes seq.
        if (!existing) {
          if (Object.keys(state.requests).length >= 20_000) throw new Error("Directory request capacity reached.");
          state.requests[id] = { from: c.principal, to: c.target, status: "pending", updatedAt: now };
        }
      } else if (c.action === "accept" || c.action === "decline") {
        const id = `${c.target}:${c.principal}`; const request = state.requests[id];
        if (!request || request.to !== c.principal) throw new Error("No incoming request from that person.");
        if (request.status === "pending") state.requests[id] = { ...request, status: c.action === "accept" ? "accepted" : "declined", updatedAt: now };
      }
      state.actors[c.principal] = { seq: c.seq, minute, count };
      if (await this.store.compareAndSet(snapshot.generation, state)) {
        return {
          cards: Object.values(state.cards).filter((card) => card.expiresAt > now && card.id !== c.principal),
          ownCard: live(c.principal) ? state.cards[c.principal] : null,
          // Private inbox metadata is visible only to a request participant.
          requests: Object.values(state.requests).filter((request) => request.from === c.principal || request.to === c.principal),
        };
      }
    }
    throw new Error("Directory busy. Retry with a fresh signed command.");
  }
}

// Dependency-injected identity/sequence persistence makes device restart and cross-tab ordering
// the embedding app's explicit obligation, rather than silently resetting sequence to zero.
export class SignedDirectoryClient {
  constructor(private principal: string, private identity: SigningKeyPair, private nextSequence: () => Promise<number>, private transport: (envelope: SignedDirectoryCommand) => Promise<DirectoryRead>, private now: () => number) {}
  async execute(action: DirectoryAction): Promise<DirectoryRead> {
    const command = Command.parse({ domain: "eic-directory-v1", principal: this.principal, seq: await this.nextSequence(), at: this.now(), ...action });
    return this.transport(await signDirectoryCommand(command, this.identity));
  }
}

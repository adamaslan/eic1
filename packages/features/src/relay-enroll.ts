import { AppError, VaultCorruptError, decodeBase64, encodeBase64, type Bytes } from "@veil/core";
import { signPayload, verifySignature } from "@veil/crypto";
import { base32Lower } from "./chat-relay";
import { RELAY_MAX_NONCE_CHARS, RELAY_MAX_PUBKEY_CHARS, RELAY_READ_MAX_AGE_MS, countingStore, type RelayAtomicStore, type RelayOps } from "./relay-adapter";

// Vouched relay enrollment. A connect link carries an invite the inviter signed with
// their share identity. Whoever accepts it proves possession of their own key over a
// fresh, single-use nonce bound to that invite. The relay admits the new key only when
// the inviter is already a member and every quota holds. Open self-enrollment is
// deliberately absent: anyone could mint keys and fill the global relay cap.
//
// Signing domains never collide with feed manifests (JSON, starts with "{") or signed
// reads (starts with "feeds/"): invites start "eic-relay-invite:", enrollments "enroll:".

export const RELAY_INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
/** Clock-skew allowance on the invite expiry ceiling. */
export const RELAY_INVITE_SKEW_MS = 10 * 60 * 1000;
export const RELAY_INVITE_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

/** Proposed defaults, unconfirmed by the owner. The hosted copy lives in eic_relay.config. */
export const RELAY_ENROLL_LIMITS = { maxMembers: 1000, invitesPerMember: 10, usesPerInvite: 3 } as const;
export type RelayEnrollLimits = { maxMembers: number; invitesPerMember: number; usesPerInvite: number };

export interface RelayInvite {
  inviterPub: string;
  inviteId: string;
  /** Milliseconds since epoch. */
  expiresAt: number;
  signature: string;
}

export interface RelayEnrollRequest {
  pubkey: string;
  ts: number;
  nonce: string;
  /** Signature over `enroll:${ts}:${nonce}:${inviteId}` with the invitee's secret key. */
  signature: string;
  invite: RelayInvite;
}

export type RelayEnrollStatus = "enrolled" | "member";
export type RelayEnrollDenial = "inviter_not_member" | "invite_used" | "inviter_quota" | "capacity";

export class RelayEnrollDeniedError extends AppError {
  constructor(readonly reason: RelayEnrollDenial) {
    super("The relay did not accept that invite.");
  }
}

export interface RelayMembership {
  isMember(pubkey: string): Promise<boolean>;
  /**
   * Atomic admission: an existing member returns "member" without consuming the invite.
   * Otherwise the inviter must be a member, the invite and inviter must be under quota,
   * and the member cap must hold. Denials return their reason; outages throw.
   */
  enroll(input: { pubkey: string; inviterPub: string; inviteId: string }): Promise<RelayEnrollStatus | RelayEnrollDenial>;
}

const invitePayload = (inviteId: string, expiresAt: number) => new TextEncoder().encode(`eic-relay-invite:v1:${inviteId}:${expiresAt}`);
const enrollPayload = (ts: number, nonce: string, inviteId: string) => new TextEncoder().encode(`enroll:${ts}:${nonce}:${inviteId}`);

function randomId(): string {
  return encodeBase64(globalThis.crypto.getRandomValues(new Uint8Array(18))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function signRelayInvite(identity: { publicKey: Bytes; secretKey: Bytes }, now: Date): Promise<RelayInvite> {
  const inviteId = randomId();
  const expiresAt = now.getTime() + RELAY_INVITE_TTL_MS;
  const signature = encodeBase64(await signPayload(identity.secretKey, invitePayload(inviteId, expiresAt)));
  return { inviterPub: encodeBase64(identity.publicKey), inviteId, expiresAt, signature };
}

export async function signRelayEnroll(identity: { publicKey: Bytes; secretKey: Bytes }, invite: RelayInvite, now: Date): Promise<RelayEnrollRequest> {
  const ts = now.getTime();
  const nonce = encodeBase64(globalThis.crypto.getRandomValues(new Uint8Array(24)));
  const signature = encodeBase64(await signPayload(identity.secretKey, enrollPayload(ts, nonce, invite.inviteId)));
  return { pubkey: encodeBase64(identity.publicKey), ts, nonce, signature, invite };
}

function short(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

export function isRelayEnrollRequest(value: unknown): value is RelayEnrollRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  const invite = body.invite as Record<string, unknown> | null | undefined;
  return short(body.pubkey, RELAY_MAX_PUBKEY_CHARS) && short(body.signature, 128) && short(body.nonce, RELAY_MAX_NONCE_CHARS)
    && typeof body.ts === "number" && Number.isFinite(body.ts)
    && typeof invite === "object" && invite !== null && !Array.isArray(invite)
    && short(invite.inviterPub, RELAY_MAX_PUBKEY_CHARS) && short(invite.signature, 128)
    && typeof invite.inviteId === "string" && RELAY_INVITE_ID_PATTERN.test(invite.inviteId)
    && typeof invite.expiresAt === "number" && Number.isSafeInteger(invite.expiresAt);
}

async function verifies(pubkey: string, payload: Bytes, signature: string): Promise<boolean> {
  try { return await verifySignature(decodeBase64(pubkey), payload, decodeBase64(signature)); } catch { return false; }
}

/**
 * Enrollment gate. Pure checks first (shape, both signatures, freshness, invite expiry),
 * so a forged or stale request costs zero store operations. Then one create-only nonce in
 * the invitee's replay/ namespace (shared with reads, so the per-reader SQL rate applies),
 * then the atomic membership admission.
 */
export async function admitRelayEnroll(
  rawStore: RelayAtomicStore,
  membership: RelayMembership,
  request: RelayEnrollRequest,
  opts: { now: Date },
): Promise<{ status: RelayEnrollStatus; ops: RelayOps }> {
  if (!isRelayEnrollRequest(request)) throw new VaultCorruptError("That enroll request is damaged.");
  const { invite } = request;
  const nowMs = opts.now.getTime();
  if (!(await verifies(request.pubkey, enrollPayload(request.ts, request.nonce, invite.inviteId), request.signature))) {
    throw new VaultCorruptError("That enroll request's signature does not check out.");
  }
  if (!(await verifies(invite.inviterPub, invitePayload(invite.inviteId, invite.expiresAt), invite.signature))) {
    throw new VaultCorruptError("That relay invite's signature does not check out.");
  }
  if (Math.abs(nowMs - request.ts) > RELAY_READ_MAX_AGE_MS) throw new AppError("That enroll request is too old.");
  if (invite.expiresAt <= nowMs) throw new AppError("That relay invite has expired. Ask your friend for a fresh connect link.");
  // An invite can never outlive the TTL, whatever its signer claimed.
  if (invite.expiresAt > nowMs + RELAY_INVITE_TTL_MS + RELAY_INVITE_SKEW_MS) throw new AppError("That relay invite is not valid.");
  const { store, ops } = countingStore(rawStore);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", decodeBase64(request.pubkey));
  const nonceKey = `replay/${base32Lower(new Uint8Array(digest))}/enroll/${request.nonce}`;
  if ((await store.compareAndSet(nonceKey, String(request.ts), { createOnly: true })) === null) {
    throw new AppError("That enroll request has already been used.");
  }
  const result = await membership.enroll({ pubkey: request.pubkey, inviterPub: invite.inviterPub, inviteId: invite.inviteId });
  if (result !== "enrolled" && result !== "member") throw new RelayEnrollDeniedError(result);
  return { status: result, ops };
}

/** Static allowlist adapter: the pre-enrollment behavior, with enrollment always denied. */
export function staticRelayMembership(keys: readonly string[]): RelayMembership {
  const set = new Set(keys);
  return {
    async isMember(pubkey) { return set.has(pubkey); },
    async enroll({ pubkey }) { return set.has(pubkey) ? "member" : "inviter_not_member"; },
  };
}

/** In-memory membership for tests and the local fixture. Single-threaded JS keeps it atomic. */
export function createMemoryRelayMembership(roots: readonly string[], limits: RelayEnrollLimits = RELAY_ENROLL_LIMITS): RelayMembership & { members: Map<string, { inviter: string | null; inviteId: string | null }> } {
  const members = new Map<string, { inviter: string | null; inviteId: string | null }>(roots.map((key) => [key, { inviter: null, inviteId: null }]));
  return {
    members,
    async isMember(pubkey) { return members.has(pubkey); },
    async enroll({ pubkey, inviterPub, inviteId }) {
      if (members.has(pubkey)) return "member";
      if (!members.has(inviterPub)) return "inviter_not_member";
      const vouched = [...members.values()].filter((m) => m.inviter === inviterPub);
      if (vouched.filter((m) => m.inviteId === inviteId).length >= limits.usesPerInvite) return "invite_used";
      if (vouched.length >= limits.invitesPerMember) return "inviter_quota";
      if (members.size >= limits.maxMembers) return "capacity";
      members.set(pubkey, { inviter: inviterPub, inviteId });
      return "enrolled";
    },
  };
}

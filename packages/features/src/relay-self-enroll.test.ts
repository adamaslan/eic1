import { describe, expect, it } from "vitest";
import { encodeBase64 } from "@veil/core";
import { generateSigningKeyPair, signPayload } from "@veil/crypto";
import { countingStore, type RelayAtomicStore, type StoreEntry } from "./relay-adapter";
import { admitRelayEnroll, admitRelaySelfEnroll, createMemoryRelayMembership, RelayEnrollDeniedError, signRelayEnroll, signRelayInvite, signRelaySelfEnroll, verifyTurnstileToken, type RelaySelfEnrollRequest } from "./relay-enroll";
import { createRelayHttpHandler } from "./relay-http";
import { staticRelayMembership } from "./relay-enroll";

const NOW = new Date("2026-11-20T12:00:00Z");
function memStore(): RelayAtomicStore {
  const data = new Map<string, StoreEntry>(); let gen = 0;
  return {
    async get(path) { return data.get(path) ?? null; },
    async compareAndSet(path, text, cond) {
      const cur = data.get(path);
      if ("createOnly" in cond ? cur : !cur || cur.generation !== cond.generation) return null;
      const generation = String(++gen); data.set(path, { data: text, generation }); return generation;
    },
    async list() { return { keys: [], next: null }; },
  } as unknown as RelayAtomicStore;
}
const allow = (overrides: { turnstile?: boolean; slot?: boolean } = {}) => ({
  verifyTurnstile: async () => overrides.turnstile ?? true,
  claimDailySlot: async () => overrides.slot ?? true,
});
const applicant = async () => { const id = await generateSigningKeyPair(); return { id, pubkey: encodeBase64(id.publicKey) }; };

describe("self-enrollment gate", () => {
  it("admits a new key that proves possession and passes the human check", async () => {
    const { id, pubkey } = await applicant();
    const membership = createMemoryRelayMembership([]);
    const request = await signRelaySelfEnroll(id, "token-ok", NOW);
    const { status } = await admitRelaySelfEnroll(memStore(), membership, request, { now: NOW, policy: allow() });
    expect(status).toBe("enrolled");
    expect(await membership.isMember(pubkey)).toBe(true);
  });

  it("an existing member gets member back without spending the human check or a daily slot", async () => {
    const { id, pubkey } = await applicant();
    const membership = createMemoryRelayMembership([pubkey]);
    let checked = false; let claimed = false;
    const policy = { verifyTurnstile: async () => { checked = true; return true; }, claimDailySlot: async () => { claimed = true; return true; } };
    const { status } = await admitRelaySelfEnroll(memStore(), membership, await signRelaySelfEnroll(id, "t", NOW), { now: NOW, policy });
    expect(status).toBe("member");
    expect(checked || claimed).toBe(false);
  });

  it("a failed human check denies enrollment and admits nothing", async () => {
    const { id, pubkey } = await applicant();
    const membership = createMemoryRelayMembership([]);
    await expect(admitRelaySelfEnroll(memStore(), membership, await signRelaySelfEnroll(id, "bad", NOW), { now: NOW, policy: allow({ turnstile: false }) }))
      .rejects.toThrow(RelayEnrollDeniedError);
    expect(await membership.isMember(pubkey)).toBe(false);
  });

  it("an exhausted daily budget denies enrollment with daily_limit", async () => {
    const { id, pubkey } = await applicant();
    const membership = createMemoryRelayMembership([]);
    const error = await admitRelaySelfEnroll(memStore(), membership, await signRelaySelfEnroll(id, "t", NOW), { now: NOW, policy: allow({ slot: false }) }).catch((e) => e);
    expect(error).toBeInstanceOf(RelayEnrollDeniedError);
    expect((error as RelayEnrollDeniedError).reason).toBe("daily_limit");
    expect(await membership.isMember(pubkey)).toBe(false);
  });

  it("a replayed request changes nothing: an enrolled key reports member, and a new key cannot reuse a nonce", async () => {
    const { id, pubkey } = await applicant();
    const membership = createMemoryRelayMembership([]);
    const store = memStore();
    const request = await signRelaySelfEnroll(id, "t", NOW);
    await admitRelaySelfEnroll(store, membership, request, { now: NOW, policy: allow() });
    expect((await admitRelaySelfEnroll(store, membership, request, { now: NOW, policy: allow() })).status).toBe("member");
    expect(await membership.isMember(pubkey)).toBe(true);
    // The nonce is spent only by the first real admission. A forged reuse under another key fails the signature check.
    const reused = { ...request, pubkey: (await applicant()).pubkey };
    await expect(admitRelaySelfEnroll(store, membership, reused, { now: NOW, policy: allow() })).rejects.toThrow("does not check out");
  });

  it("a request signed by a different key is refused before any policy runs", async () => {
    const { pubkey } = await applicant();
    const other = await generateSigningKeyPair();
    const forged: RelaySelfEnrollRequest = {
      pubkey, ts: NOW.getTime(), nonce: encodeBase64(new Uint8Array(24).fill(7)), turnstile: "t",
      signature: encodeBase64(await signPayload(other.secretKey, new TextEncoder().encode(`enroll-self:${NOW.getTime()}:${encodeBase64(new Uint8Array(24).fill(7))}`))),
    };
    let ran = false;
    await expect(admitRelaySelfEnroll(memStore(), createMemoryRelayMembership([]), forged, { now: NOW, policy: { verifyTurnstile: async () => { ran = true; return true; }, claimDailySlot: async () => true } }))
      .rejects.toThrow("does not check out");
    expect(ran).toBe(false);
  });

  it("a request older than the freshness window is refused", async () => {
    const { id } = await applicant();
    const old = await signRelaySelfEnroll(id, "t", new Date(NOW.getTime() - 60 * 60 * 1000));
    await expect(admitRelaySelfEnroll(memStore(), createMemoryRelayMembership([]), old, { now: NOW, policy: allow() })).rejects.toThrow("too old");
  });

  it("a membership without self-enrollment denies it", async () => {
    const { id } = await applicant();
    const membership = staticRelayMembership([]);
    const error = await admitRelaySelfEnroll(memStore(), membership, await signRelaySelfEnroll(id, "t", NOW), { now: NOW, policy: allow() }).catch((e) => e);
    expect((error as RelayEnrollDeniedError).reason).toBe("self_enroll_disabled");
  });

  it("the member cap still holds for self-enrollment", async () => {
    const { id } = await applicant();
    const membership = createMemoryRelayMembership([await encodeBase64((await generateSigningKeyPair()).publicKey)], { maxMembers: 1, invitesPerMember: 10, usesPerInvite: 3 });
    const error = await admitRelaySelfEnroll(memStore(), membership, await signRelaySelfEnroll(id, "t", NOW), { now: NOW, policy: allow() }).catch((e) => e);
    expect((error as RelayEnrollDeniedError).reason).toBe("capacity");
  });
});

describe("Turnstile server verification", () => {
  const fetchReturning = (body: unknown, ok = true): typeof fetch => (async () => new Response(JSON.stringify(body), { status: ok ? 200 : 500 })) as typeof fetch;
  it("accepts only a success:true answer from the siteverify endpoint", async () => {
    expect(await verifyTurnstileToken("secret", "tok", fetchReturning({ success: true }))).toBe(true);
    expect(await verifyTurnstileToken("secret", "tok", fetchReturning({ success: false }))).toBe(false);
    expect(await verifyTurnstileToken("secret", "tok", fetchReturning({ success: true }, false))).toBe(false);
  });
  it("fails closed on an empty secret or token without calling out", async () => {
    let called = false;
    const spy = (async () => { called = true; return new Response("{}"); }) as typeof fetch;
    expect(await verifyTurnstileToken("", "tok", spy)).toBe(false);
    expect(await verifyTurnstileToken("secret", "", spy)).toBe(false);
    expect(called).toBe(false);
  });
});

describe("self-enroll over the relay handler", () => {
  const post = (handler: (r: Request) => Promise<Response>, body: unknown) =>
    handler(new Request("https://relay.example/enroll", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  const handlerWith = (selfEnroll: ReturnType<typeof allow> | undefined, membership = createMemoryRelayMembership([])) =>
    createRelayHttpHandler(memStore() as never, {
      enabled: true, origins: [], membership, maxPublishesPerWindow: 10, windowMs: 60_000, now: () => NOW, selfEnroll,
    });

  it("enrolls with a valid request and reports daily-limit as 429", async () => {
    const { id } = await applicant();
    const ok = await post(handlerWith(allow()), await signRelaySelfEnroll(id, "t", NOW));
    expect(ok.status).toBe(200);
    const { id: second } = await applicant();
    const limited = await post(handlerWith(allow({ slot: false })), await signRelaySelfEnroll(second, "t", NOW));
    expect(limited.status).toBe(429);
  });

  it("reports a failed human check as 403", async () => {
    const { id } = await applicant();
    expect((await post(handlerWith(allow({ turnstile: false })), await signRelaySelfEnroll(id, "t", NOW))).status).toBe(403);
  });

  it("serves no self-enrollment when no policy is configured", async () => {
    const { id } = await applicant();
    expect((await post(handlerWith(undefined), await signRelaySelfEnroll(id, "t", NOW))).status).toBe(404);
  });
});

describe("admission order and vouching rules (review fixes)", () => {
  it("an invite from a non-member is denied before any relay row is written", async () => {
    const { id, pubkey } = await applicant();
    const inviter = await applicant();
    const store = memStore();
    let writes = 0;
    const spy: RelayAtomicStore = { ...store, async compareAndSet(...args) { writes += 1; return store.compareAndSet(...args); } } as RelayAtomicStore;
    const invite = await signRelayInvite(inviter.id, new Date(NOW.getTime() + 60_000));
    const request = await signRelayEnroll(id, invite, NOW);
    const error = await admitRelayEnroll(spy, createMemoryRelayMembership([]), request, { now: NOW }).catch((e) => e);
    expect((error as RelayEnrollDeniedError).reason).toBe("inviter_not_member");
    expect(writes).toBe(0);
    expect(pubkey).toBeTruthy();
  });

  it("a failed human check writes no relay row", async () => {
    const { id } = await applicant();
    let writes = 0;
    const store = memStore();
    const spy = { ...store, async compareAndSet(...args: Parameters<RelayAtomicStore["compareAndSet"]>) { writes += 1; return store.compareAndSet(...args); } } as RelayAtomicStore;
    const error = await admitRelaySelfEnroll(spy, createMemoryRelayMembership([]), await signRelaySelfEnroll(id, "bad", NOW), { now: NOW, policy: allow({ turnstile: false }) }).catch((e) => e);
    expect((error as RelayEnrollDeniedError).reason).toBe("turnstile_failed");
    expect(writes).toBe(0);
  });

  it("a self-enrolled key cannot vouch for anyone", async () => {
    const self = await applicant();
    const newcomer = await applicant();
    const membership = createMemoryRelayMembership([]);
    await membership.admitSelf!(self.pubkey);
    const invite = await signRelayInvite(self.id, new Date(NOW.getTime() + 60_000));
    const error = await admitRelayEnroll(memStore(), membership, await signRelayEnroll(newcomer.id, invite, NOW), { now: NOW }).catch((e) => e);
    expect((error as RelayEnrollDeniedError).reason).toBe("inviter_quota");
  });
});

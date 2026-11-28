import { describe, expect, it, vi } from "vitest";
import { BACKUP_FORMAT, BACKUP_RETENTION_DAYS, MAX_BACKUP_BYTES, MAX_BACKUP_COUNT, WRITE_RATE_LIMIT, BackupError, deleteBackup, getBackup, putBackup, sweepExpiredBackups } from "./backup-core.ts";
import type { ShareStore } from "./share-core.ts";

function memoryStore(): ShareStore & { data: Map<string, { body: string; meta: Record<string, string>; etag: string }> } {
  const data = new Map<string, { body: string; meta: Record<string, string>; etag: string }>();
  let n = 0;
  return {
    data,
    async put(key, body, meta, condition) {
      const existing = data.get(key);
      if (condition?.onlyIfNew && existing) return { modified: false };
      if (condition?.onlyIfMatch && existing?.etag !== condition.onlyIfMatch) return { modified: false };
      data.set(key, { body, meta, etag: `e${(n += 1)}` });
      return { modified: true };
    },
    async get(key) { return data.get(key) ?? null; },
    async delete(key) { data.delete(key); },
    async list() { return [...data.keys()]; },
  };
}
const secret = (c: string) => c.repeat(43).slice(0, 43);
const NOW = new Date("2026-11-27T12:00:00Z");
const body = JSON.stringify({ format: BACKUP_FORMAT, version: 1, records: [] });
const code = async (p: Promise<unknown>) => p.then(() => 0, (e: unknown) => (e instanceof BackupError ? e.status : -1));

describe("backup core", () => {
  it("stores, returns and deletes by secret, keeping only a hash of the secret", async () => {
    const store = memoryStore();
    const receipt = await putBackup(store, secret("a"), body, NOW, "1.1.1.1");
    expect(receipt.replaced).toBe(false);
    expect([...store.data.keys()].filter((k) => k.startsWith("backups/"))[0]).toMatch(/^backups\/[0-9a-f]{64}$/);
    expect(JSON.stringify([...store.data.entries()])).not.toContain(secret("a"));
    expect(await getBackup(store, secret("a"), NOW)).toBe(body);
    expect(await getBackup(store, secret("b"), NOW)).toBeNull();
    expect(await deleteBackup(store, secret("b"))).toBe("missing");
    expect(await deleteBackup(store, secret("a"))).toBe("deleted");
    expect(await getBackup(store, secret("a"), NOW)).toBeNull();
  });
  it("rejects bad secrets, non-backups and oversize bodies", async () => {
    const store = memoryStore();
    expect(await code(putBackup(store, "short", body, NOW, "c"))).toBe(401);
    expect(await code(putBackup(store, null, body, NOW, "c"))).toBe(401);
    expect(await code(putBackup(store, secret("a"), "{nope", NOW, "c"))).toBe(400);
    expect(await code(putBackup(store, secret("a"), JSON.stringify({ format: "other" }), NOW, "c"))).toBe(400);
    const big = JSON.stringify({ format: BACKUP_FORMAT, pad: "x".repeat(MAX_BACKUP_BYTES) });
    expect(await code(putBackup(store, secret("a"), big, NOW, "c"))).toBe(413);
    expect(store.data.size).toBe(0);
  });
  it("replaces the same backup and renews its expiry", async () => {
    const store = memoryStore();
    await putBackup(store, secret("a"), body, NOW, "ip");
    const later = new Date(NOW.getTime() + 10 * 86400000);
    const second = await putBackup(store, secret("a"), body, later, "ip");
    expect(second.replaced).toBe(true);
    expect(Date.parse(second.expiresAt)).toBe(later.getTime() + BACKUP_RETENTION_DAYS * 86400000);
  });
  it("expires after the retention window and removes the expired entry on read", async () => {
    const store = memoryStore();
    await putBackup(store, secret("a"), body, NOW, "ip");
    const after = new Date(NOW.getTime() + (BACKUP_RETENTION_DAYS + 1) * 86400000);
    expect(await getBackup(store, secret("a"), after)).toBeNull();
    expect([...store.data.keys()].filter((k) => k.startsWith("backups/"))).toHaveLength(0);
  });
  it("rate limits writes per client and does not limit other clients", async () => {
    const store = memoryStore();
    for (let i = 0; i < WRITE_RATE_LIMIT; i += 1) await putBackup(store, secret("a"), body, NOW, "same");
    expect(await code(putBackup(store, secret("a"), body, NOW, "same"))).toBe(429);
    expect(await code(putBackup(store, secret("a"), body, NOW, "other"))).toBe(0);
  });
  it("stops accepting new backups at the global count cap but still lets owners replace theirs", async () => {
    const store = memoryStore();
    vi.spyOn(Date, "now");
    for (let i = 0; i < MAX_BACKUP_COUNT; i += 1) {
      store.data.set(`backups/${String(i).padStart(64, "0")}`, { body, etag: "x", meta: { bytes: "10", expiresAt: new Date(NOW.getTime() + 86400000).toISOString(), secretHash: "00" } });
    }
    expect(await code(putBackup(store, secret("z"), body, NOW, "ip-new"))).toBe(507);
  });
  it("sweeps only expired backups", async () => {
    const store = memoryStore();
    await putBackup(store, secret("a"), body, NOW, "i1");
    await putBackup(store, secret("b"), body, new Date(NOW.getTime() + 20 * 86400000), "i2");
    const later = new Date(NOW.getTime() + 35 * 86400000);
    expect(await sweepExpiredBackups(store, later)).toBe(1);
    expect(await getBackup(store, secret("b"), later)).toBe(body);
  });
});

/**
 * Encrypted backup sync core (Cookie Jar P3). The server stores an opaque, already-encrypted
 * vault backup and nothing else: it never sees the passphrase or any plaintext. Access is by
 * a random recovery secret the owner holds; only its SHA-256 is stored, so a leaked blob store
 * cannot be read back by key. Free-tier shape: small per-backup cap, global caps, 30-day expiry.
 *
 * Pure of platform code: the blob store is injected, so this file is fully testable and the
 * function wrapper stays inert (and never resolves @netlify/blobs) while the gate is off.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { ShareStore } from "./share-core.ts";

export const MAX_BACKUP_BYTES = 2 * 1024 * 1024;
export const BACKUP_RETENTION_DAYS = 30;
export const MAX_BACKUP_COUNT = 200;
export const MAX_BACKUP_STORE_BYTES = 100 * 1024 * 1024;
export const WRITE_RATE_LIMIT = 6;
export const WRITE_RATE_WINDOW_MS = 60 * 60 * 1000;
export const BACKUP_FORMAT = "veil95-vault";

export class BackupError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

const DAY = 24 * 60 * 60 * 1000;
export const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/; // 32 random bytes, base64url

const hashOf = (secret: string) => createHash("sha256").update(secret).digest("hex");
const keyFor = (secret: string) => `backups/${hashOf(secret)}`;
const rateKey = (client: string) => `rl/${createHash("sha256").update(client).digest("hex").slice(0, 24)}`;

function requireSecret(secret: string | null | undefined): string {
  if (!secret || !SECRET_PATTERN.test(secret)) throw new BackupError("A valid recovery secret is required.", 401);
  return secret;
}

/** The body must be a vault export, but only its envelope is checked: contents are ciphertext. */
export function validateBackupBody(body: string): void {
  if (Buffer.byteLength(body, "utf8") > MAX_BACKUP_BYTES) throw new BackupError("That backup is too large for free storage.", 413);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new BackupError("That is not a vault backup.");
  }
  if (!parsed || typeof parsed !== "object" || (parsed as { format?: unknown }).format !== BACKUP_FORMAT) {
    throw new BackupError("That is not a vault backup.");
  }
}

/** Fixed-window per-client write limit using compare-and-swap, so concurrent writes cannot both pass. */
export async function checkWriteRate(store: ShareStore, client: string, now: Date): Promise<void> {
  const key = rateKey(client);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const entry = await store.get(key);
    let start = now.getTime();
    let count = 0;
    if (entry) {
      if (!entry.etag) throw new BackupError("Backup rate accounting is unavailable.", 503);
      try {
        const parsed = JSON.parse(entry.body) as { start?: unknown; count?: unknown };
        if (typeof parsed.start !== "number" || typeof parsed.count !== "number" || !Number.isInteger(parsed.count) || parsed.count < 0) throw new Error("bad");
        if (now.getTime() - parsed.start < WRITE_RATE_WINDOW_MS) {
          start = parsed.start;
          count = parsed.count;
        }
      } catch {
        throw new BackupError("Backup rate accounting is unavailable.", 503);
      }
    }
    if (count >= WRITE_RATE_LIMIT) throw new BackupError("Too many backups from this connection. Try again later.", 429);
    const result = await store.put(key, JSON.stringify({ start, count: count + 1 }), {}, entry ? { onlyIfMatch: entry.etag } : { onlyIfNew: true });
    if (result.modified) return;
  }
  throw new BackupError("Backup rate accounting is busy. Try again later.", 503);
}

interface Totals {
  count: number;
  bytes: number;
}

/** Sums live (unexpired) backups from metadata. Not one transaction with the write: see the README caveat. */
async function totals(store: ShareStore, now: Date, exceptKey: string): Promise<Totals> {
  const sum: Totals = { count: 0, bytes: 0 };
  for (const key of await store.list()) {
    if (!key.startsWith("backups/") || key === exceptKey) continue;
    const entry = await store.get(key);
    if (!entry) continue;
    if (Date.parse(entry.meta.expiresAt ?? "") <= now.getTime()) continue;
    sum.count += 1;
    sum.bytes += Number(entry.meta.bytes) || 0;
  }
  return sum;
}

export interface BackupReceipt {
  bytes: number;
  expiresAt: string;
  replaced: boolean;
}

export async function putBackup(store: ShareStore, secretInput: string | null, body: string, now: Date, client: string): Promise<BackupReceipt> {
  const secret = requireSecret(secretInput);
  validateBackupBody(body);
  await checkWriteRate(store, client, now);
  const key = keyFor(secret);
  const bytes = Buffer.byteLength(body, "utf8");
  const others = await totals(store, now, key);
  const existing = await store.get(key);
  if (!existing && others.count >= MAX_BACKUP_COUNT) throw new BackupError("Backup storage is full right now.", 507);
  if (others.bytes + bytes > MAX_BACKUP_STORE_BYTES) throw new BackupError("Backup storage is full right now.", 507);
  const expiresAt = new Date(now.getTime() + BACKUP_RETENTION_DAYS * DAY).toISOString();
  const result = await store.put(key, body, { bytes: String(bytes), expiresAt, secretHash: hashOf(secret) }, existing?.etag ? { onlyIfMatch: existing.etag } : { onlyIfNew: true });
  if (!result.modified) throw new BackupError("That backup changed while saving. Try again.", 409);
  return { bytes, expiresAt, replaced: Boolean(existing) };
}

function secretMatches(entry: { meta: Record<string, string> }, secret: string): boolean {
  const stored = Buffer.from(entry.meta.secretHash ?? "", "hex");
  const given = Buffer.from(hashOf(secret), "hex");
  return stored.length === given.length && timingSafeEqual(stored, given);
}

/** Returns the stored ciphertext, or null if it is missing or expired (expired entries are removed). */
export async function getBackup(store: ShareStore, secretInput: string | null, now: Date): Promise<string | null> {
  const secret = requireSecret(secretInput);
  const key = keyFor(secret);
  const entry = await store.get(key);
  if (!entry || !secretMatches(entry, secret)) return null;
  if (Date.parse(entry.meta.expiresAt ?? "") <= now.getTime()) {
    await store.delete(key);
    return null;
  }
  return entry.body;
}

export async function deleteBackup(store: ShareStore, secretInput: string | null): Promise<"deleted" | "missing"> {
  const secret = requireSecret(secretInput);
  const key = keyFor(secret);
  const entry = await store.get(key);
  if (!entry || !secretMatches(entry, secret)) return "missing";
  await store.delete(key);
  return "deleted";
}

/** Removes expired backups. Bounded: touches only keys under backups/. */
export async function sweepExpiredBackups(store: ShareStore, now: Date): Promise<number> {
  let removed = 0;
  for (const key of await store.list()) {
    if (!key.startsWith("backups/")) continue;
    const entry = await store.get(key);
    if (entry && Date.parse(entry.meta.expiresAt ?? "") <= now.getTime()) {
      await store.delete(key);
      removed += 1;
    }
  }
  return removed;
}

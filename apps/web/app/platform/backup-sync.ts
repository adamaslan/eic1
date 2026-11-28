import type { Choices } from "./cookie-jar-store";
import { purposeEnabled } from "./cookie-jar-store";

// Encrypted backup sync client (Cookie Jar P3). Explicit, per-click: there is no background
// sync. The body is the existing passphrase-encrypted vault export, so the host only ever holds
// ciphertext. The recovery code is shown once and NEVER stored in the browser (I-4): the person
// keeps it, and it is the only way to find the backup again.

export const SYNC_PURPOSE = "backup-sync";
export const API_PATH = "/api/backup";

/** Build-time flag, matching the share relay's pattern. Off unless the owner sets it. */
export function syncAvailable(env: { VITE_EIC_BACKUP_SYNC?: string } = import.meta.env as { VITE_EIC_BACKUP_SYNC?: string }): boolean {
  return env.VITE_EIC_BACKUP_SYNC === "on";
}

export function syncAllowed(choices: Choices, available = syncAvailable()): boolean {
  return available && purposeEnabled(choices, SYNC_PURPOSE);
}

/** 32 random bytes as base64url (43 chars), generated in the browser. */
export function generateRecoveryCode(random: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array = (bytes) => crypto.getRandomValues(bytes)): string {
  const bytes = random(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const isRecoveryCode = (value: string): boolean => /^[A-Za-z0-9_-]{43}$/.test(value);

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export type SyncResult = { ok: true; detail?: string } | { ok: false; message: string };

async function failure(response: Response): Promise<SyncResult> {
  if (response.status === 404) return { ok: false, message: "Backup sync is not switched on for this site, or no backup matches that code." };
  if (response.status === 429) return { ok: false, message: "Too many backups from this connection. Try again in an hour." };
  if (response.status === 413 || response.status === 507) return { ok: false, message: "This backup is too big for free storage. Download it as a file instead." };
  return { ok: false, message: "The backup service could not finish. Your local vault is unchanged." };
}

export async function uploadBackup(code: string, encryptedExport: string, fetcher: Fetcher = fetch): Promise<SyncResult> {
  if (!isRecoveryCode(code)) return { ok: false, message: "That recovery code is not valid." };
  try {
    const response = await fetcher(API_PATH, { method: "PUT", headers: { "x-backup-secret": code, "content-type": "application/json" }, body: encryptedExport });
    if (!response.ok) return failure(response);
    const receipt = (await response.json()) as { expiresAt?: string };
    return { ok: true, detail: receipt.expiresAt };
  } catch {
    return { ok: false, message: "Could not reach the backup service. Your local vault is unchanged." };
  }
}

export async function downloadBackup(code: string, fetcher: Fetcher = fetch): Promise<{ ok: true; text: string } | { ok: false; message: string }> {
  if (!isRecoveryCode(code)) return { ok: false, message: "That recovery code is not valid." };
  try {
    const response = await fetcher(API_PATH, { method: "GET", headers: { "x-backup-secret": code } });
    if (!response.ok) {
      const failed = await failure(response);
      return failed.ok ? { ok: false, message: "Unexpected response." } : failed;
    }
    return { ok: true, text: await response.text() };
  } catch {
    return { ok: false, message: "Could not reach the backup service." };
  }
}

export async function deleteRemoteBackup(code: string, fetcher: Fetcher = fetch): Promise<SyncResult> {
  if (!isRecoveryCode(code)) return { ok: false, message: "That recovery code is not valid." };
  try {
    const response = await fetcher(API_PATH, { method: "DELETE", headers: { "x-backup-secret": code } });
    return response.ok ? { ok: true } : failure(response);
  } catch {
    return { ok: false, message: "Could not reach the backup service." };
  }
}

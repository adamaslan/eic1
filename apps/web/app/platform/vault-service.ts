import { SubtleCryptoPort } from "@veil/crypto";
import { VaultLockedError } from "@veil/core";
import {
  createVaultKeyed,
  exportBackup,
  importBackup,
  newRecordId,
  resumeVault,
  unlockVaultKeyed,
  type UnlockedVault,
  type VaultDeps,
} from "@veil/vault";
import { IndexedDbVaultStore } from "./indexeddb-store";
import { clearSession, currentLockMarker, loadSession, saveSession } from "./session-persist";
import { DEFAULT_SESSION_POLICY, newSessionTiming, sessionDuration, sessionIdleRemaining, validPolicy, type SessionPolicy } from "./session-policy";

// One app-wide set of platform adapters. Shared packages receive these by
// argument and never import browser globals themselves.
const cryptoPort = new SubtleCryptoPort();
const deps: VaultDeps = {
  store: new IndexedDbVaultStore(),
  crypto: cryptoPort,
  now: () => new Date(),
};

// Keeping the session is a convenience. If storage refuses, the vault still opens and just locks on reload.
async function remember(key: Parameters<typeof saveSession>[0], policy: SessionPolicy, lockMarker: string | null) {
  if (currentLockMarker() !== lockMarker) throw new VaultLockedError("The vault was locked in another tab.");
  const now = Date.now();
  const timing = newSessionTiming(policy, now);
  let expiresAt = now + sessionDuration(policy);
  try { expiresAt = await saveSession(key, now, timing); }
  catch { /* Memory stays bounded; storage refusal never extends its fixed deadline. */ }
  if (currentLockMarker() !== lockMarker) throw new VaultLockedError("The vault was locked in another tab.");
  return { expiresAt, timing, lockMarker };
}

async function openRemembered(passphrase: string, policy: SessionPolicy, create: boolean) {
  if (!validPolicy(policy)) throw new Error("Invalid session policy.");
  const marker = currentLockMarker();
  if (marker === "storage-unavailable") throw new VaultLockedError("Session storage is unavailable.");
  const { vault, key } = await (create ? createVaultKeyed(deps, passphrase) : unlockVaultKeyed(deps, passphrase));
  try { return { vault, ...await remember(key, policy, marker) }; }
  catch (error) { vault.lock(); throw error; }
}
export function vaultCreate(passphrase: string, policy: SessionPolicy = DEFAULT_SESSION_POLICY) {
  return openRemembered(passphrase, policy, true);
}
export function vaultUnlock(passphrase: string, policy: SessionPolicy = DEFAULT_SESSION_POLICY) {
  return openRemembered(passphrase, policy, false);
}

/** Reopens only an unexpired, non-idle, unrevoked remembered session. */
export async function vaultResume() {
  try {
    const saved = await loadSession(Date.now());
    if (!saved) return null;
    const vault = await resumeVault(deps, saved.key);
    const lockMarker = currentLockMarker();
    if (saved.expiresAt <= Date.now() || sessionIdleRemaining(saved.timing, Date.now()) <= 0 || (saved.lockMarker ?? null) !== lockMarker) {
      vault.lock();
      await clearSession();
      return null;
    }
    return { vault, expiresAt: saved.expiresAt, lockMarker: saved.lockMarker ?? null, timing: saved.timing };
  } catch {
    await clearSession();
    return null;
  }
}

export async function vaultExists(): Promise<boolean> {
  return (await deps.store.getMeta()) !== null;
}

export function newItemId(): string {
  return newRecordId(cryptoPort);
}

export function vaultExport(): Promise<string> {
  return exportBackup(deps.store, deps.now());
}

export async function vaultImport(text: string): Promise<{ records: number }> {
  const result = await importBackup(deps, text);
  await clearSession();
  return result;
}

export function vaultWipe(vault: UnlockedVault): Promise<void> {
  return vault.wipe();
}

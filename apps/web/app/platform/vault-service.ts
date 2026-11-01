import { SubtleCryptoPort } from "@veil/crypto";
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
import { SESSION_MS, clearSession, loadSession, saveSession } from "./session-persist";

// One app-wide set of platform adapters. Shared packages receive these by
// argument and never import browser globals themselves.
const cryptoPort = new SubtleCryptoPort();
const deps: VaultDeps = {
  store: new IndexedDbVaultStore(),
  crypto: cryptoPort,
  now: () => new Date(),
};

// Keeping the session is a convenience. If storage refuses, the vault still opens and just locks on reload.
async function remember(key: Parameters<typeof saveSession>[0]): Promise<number> {
  const now = Date.now();
  try {
    return await saveSession(key, now);
  } catch {
    // Storage may refuse persistence. The in-memory session still has the same deadline.
    return now + SESSION_MS;
  }
}

export async function vaultCreate(passphrase: string): Promise<{ vault: UnlockedVault; expiresAt: number }> {
  const { vault, key } = await createVaultKeyed(deps, passphrase);
  return { vault, expiresAt: await remember(key) };
}

export async function vaultUnlock(passphrase: string): Promise<{ vault: UnlockedVault; expiresAt: number }> {
  const { vault, key } = await unlockVaultKeyed(deps, passphrase);
  return { vault, expiresAt: await remember(key) };
}

/** Reopens the vault from a session saved in the last eight hours, or returns null. */
export async function vaultResume(): Promise<{ vault: UnlockedVault; expiresAt: number } | null> {
  try {
    const saved = await loadSession(Date.now());
    if (!saved) return null;
    const vault = await resumeVault(deps, saved.key);
    if (saved.expiresAt <= Date.now()) {
      vault.lock();
      await clearSession();
      return null;
    }
    return { vault, expiresAt: saved.expiresAt };
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

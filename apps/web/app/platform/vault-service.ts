import { SubtleCryptoPort } from "@veil/crypto";
import {
  createVault,
  exportBackup,
  importBackup,
  newRecordId,
  unlockVault,
  type UnlockedVault,
  type VaultDeps,
} from "@veil/vault";
import { IndexedDbVaultStore } from "./indexeddb-store";

// One app-wide set of platform adapters. Shared packages receive these by
// argument and never import browser globals themselves.
const cryptoPort = new SubtleCryptoPort();
const deps: VaultDeps = {
  store: new IndexedDbVaultStore(),
  crypto: cryptoPort,
  now: () => new Date(),
};

export function vaultCreate(passphrase: string): Promise<UnlockedVault> {
  return createVault(deps, passphrase);
}

export function vaultUnlock(passphrase: string): Promise<UnlockedVault> {
  return unlockVault(deps, passphrase);
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

export function vaultImport(text: string): Promise<{ records: number }> {
  return importBackup(deps, text);
}

export function vaultWipe(vault: UnlockedVault): Promise<void> {
  return vault.wipe();
}

import { SubtleCryptoPort } from "@veil/crypto";
import { createVault, newRecordId, unlockVault, type UnlockedVault, type VaultDeps } from "@veil/vault";
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

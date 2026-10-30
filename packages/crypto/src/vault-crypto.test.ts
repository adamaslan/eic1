import { describe, expect, it } from "vitest";
import { WrongPassphraseError } from "@veil/core";
import { SubtleCryptoPort } from "./subtle-crypto-port";
import {
  createVaultMeta,
  deriveVaultKey,
  openBytes,
  sealBytes,
} from "./vault-crypto";

const crypto = new SubtleCryptoPort();
const NOW = new Date("2026-10-21T00:00:00Z");

describe("vault crypto", () => {
  it("opens a vault with the right passphrase", async () => {
    const { meta } = await createVaultMeta(crypto, "correct horse battery", NOW);

    await expect(deriveVaultKey(crypto, meta, "correct horse battery")).resolves.toBeDefined();
  });

  it("rejects a wrong passphrase", async () => {
    const { meta } = await createVaultMeta(crypto, "correct horse battery", NOW);

    await expect(deriveVaultKey(crypto, meta, "wrong guess")).rejects.toBeInstanceOf(
      WrongPassphraseError,
    );
  });

  it("round-trips sealed bytes and uses a fresh IV each time", async () => {
    const { key } = await createVaultMeta(crypto, "pw", NOW);
    const plaintext = new TextEncoder().encode("hello vault");

    const first = await sealBytes(crypto, key, plaintext);
    const second = await sealBytes(crypto, key, plaintext);

    expect(await openBytes(crypto, key, first)).toEqual(plaintext);
    expect(first.iv).not.toEqual(second.iv);
    expect(first.ciphertext).not.toEqual(second.ciphertext);
  });
});

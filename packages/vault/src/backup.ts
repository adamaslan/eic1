import { z } from "zod";
import {
  EncryptedRecordSchema,
  RecordKindSchema,
  VaultCorruptError,
  VaultMetaSchema,
  decodeBase64,
  encodeBase64,
  type CryptoPort,
  type VaultStore,
} from "@veil/core";

export const BACKUP_FORMAT = "veil95-vault";
const BACKUP_VERSION = 1;

// Bytes travel as base64 strings; the shape below mirrors VaultMeta and EncryptedRecord.
const base64Field = z.string();

const BackupSchema = z.object({
  format: z.literal(BACKUP_FORMAT),
  version: z.literal(BACKUP_VERSION),
  exportedAt: z.string(),
  meta: z.object({
    v: z.literal(1),
    kdf: z.object({
      name: z.literal("PBKDF2"),
      hash: z.literal("SHA-256"),
      iterations: z.number().int().positive(),
      salt: base64Field,
    }),
    verifier: z.object({ iv: base64Field, ciphertext: base64Field }),
    createdAt: z.string(),
  }),
  records: z.array(
    z.object({
      v: z.literal(1),
      id: z.string().min(1),
      kind: RecordKindSchema,
      iv: base64Field,
      ciphertext: base64Field,
    }),
  ),
});

/**
 * Serializes the whole vault as it sits on disk. Everything in it is already
 * ciphertext, so exporting does not need the passphrase or an unlocked session.
 */
export async function exportBackup(store: VaultStore, now: Date): Promise<string> {
  const { meta, records } = await store.getBackupSnapshot();
  if (!meta) {
    throw new VaultCorruptError("There is no vault to export.");
  }
  const backup: z.infer<typeof BackupSchema> = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: now.toISOString(),
    meta: {
      v: meta.v,
      kdf: { ...meta.kdf, salt: encodeBase64(meta.kdf.salt) },
      verifier: { iv: encodeBase64(meta.verifier.iv), ciphertext: encodeBase64(meta.verifier.ciphertext) },
      createdAt: meta.createdAt,
    },
    records: records.map((record) => ({
      ...record,
      iv: encodeBase64(record.iv),
      ciphertext: encodeBase64(record.ciphertext),
    })),
  };
  return JSON.stringify(backup);
}

/**
 * Restores a backup into an empty store. Refuses to overwrite an existing
 * vault: wipe it first. The store initializes the header and records atomically
 * so a failed restore cannot leave partial data or clear another tab's vault.
 * The restored vault gets a new generation, so sessions opened before the
 * restore are locked out rather than writing into it.
 */
export async function importBackup(
  deps: { store: VaultStore; crypto: CryptoPort },
  text: string,
): Promise<{ records: number }> {
  const { meta, records } = parseBackup(text);
  await deps.store.initialize({ ...meta, generation: deps.crypto.randomBytes(16) }, records);
  return { records: records.length };
}

function parseBackup(text: string): {
  meta: z.infer<typeof VaultMetaSchema>;
  records: z.infer<typeof EncryptedRecordSchema>[];
} {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new VaultCorruptError("That file is not a Veil backup.");
  }
  const parsed = BackupSchema.safeParse(json);
  if (!parsed.success) {
    throw new VaultCorruptError("That file is not a Veil backup, or it is from a newer version.");
  }
  try {
    const meta = VaultMetaSchema.parse({
      ...parsed.data.meta,
      kdf: { ...parsed.data.meta.kdf, salt: decodeBase64(parsed.data.meta.kdf.salt) },
      verifier: {
        iv: decodeBase64(parsed.data.meta.verifier.iv),
        ciphertext: decodeBase64(parsed.data.meta.verifier.ciphertext),
      },
    });
    const records = parsed.data.records.map((record) =>
      EncryptedRecordSchema.parse({
        ...record,
        iv: decodeBase64(record.iv),
        ciphertext: decodeBase64(record.ciphertext),
      }),
    );
    if (new Set(records.map((record) => record.id)).size !== records.length) {
      throw new VaultCorruptError("That backup contains duplicate record identifiers.");
    }
    return { meta, records };
  } catch (error) {
    if (error instanceof VaultCorruptError) throw error;
    throw new VaultCorruptError("That backup contains invalid encrypted data.");
  }
}

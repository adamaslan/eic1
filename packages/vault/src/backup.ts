import { z } from "zod";
import {
  EncryptedRecordSchema,
  RecordKindSchema,
  VaultAlreadyExistsError,
  VaultCorruptError,
  VaultMetaSchema,
  decodeBase64,
  encodeBase64,
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
  const meta = await store.getMeta();
  if (!meta) {
    throw new VaultCorruptError("There is no vault to export.");
  }
  const records = await store.listAllRecords();
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
 * vault: wipe it first. Records are written before the meta, so a failure
 * midway leaves no meta behind and the partial records are cleared.
 */
export async function importBackup(store: VaultStore, text: string): Promise<{ records: number }> {
  if (await store.getMeta()) {
    throw new VaultAlreadyExistsError("This device already has a vault. Wipe it before restoring a backup.");
  }
  const backup = parseBackup(text);
  try {
    for (const record of backup.records) {
      await store.putRecord(
        EncryptedRecordSchema.parse({ ...record, iv: decodeBase64(record.iv), ciphertext: decodeBase64(record.ciphertext) }),
      );
    }
    await store.putMeta(
      VaultMetaSchema.parse({
        ...backup.meta,
        kdf: { ...backup.meta.kdf, salt: decodeBase64(backup.meta.kdf.salt) },
        verifier: {
          iv: decodeBase64(backup.meta.verifier.iv),
          ciphertext: decodeBase64(backup.meta.verifier.ciphertext),
        },
      }),
    );
  } catch (caught) {
    await store.clear();
    throw new VaultCorruptError(`The backup could not be restored: ${describe(caught)}`);
  }
  return { records: backup.records.length };
}

/** Deletes the vault header and every record. The data cannot be recovered afterwards. */
export function wipeVault(store: VaultStore): Promise<void> {
  return store.clear();
}

function parseBackup(text: string): z.infer<typeof BackupSchema> {
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
  return parsed.data;
}

function describe(caught: unknown): string {
  return caught instanceof Error ? caught.message : "unknown error";
}

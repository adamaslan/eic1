import { z } from "zod";

export const RecordKindSchema = z.enum(["item", "media", "thumb"]);
export type RecordKind = z.infer<typeof RecordKindSchema>;

export type Bytes = Uint8Array<ArrayBuffer>;

const bytesSchema = z.custom<Bytes>((value) => value instanceof Uint8Array);

export const VaultMetaSchema = z.object({
  v: z.literal(1),
  kdf: z.object({
    name: z.literal("PBKDF2"),
    hash: z.literal("SHA-256"),
    iterations: z.number().int().positive(),
    salt: bytesSchema,
  }),
  // Encrypts a known constant so a wrong passphrase is detected at unlock.
  verifier: z.object({
    iv: bytesSchema,
    ciphertext: bytesSchema,
  }),
  createdAt: z.string(),
});
export type VaultMeta = z.infer<typeof VaultMetaSchema>;

export const EncryptedRecordSchema = z.object({
  v: z.literal(1),
  id: z.string().min(1),
  kind: RecordKindSchema,
  iv: bytesSchema,
  ciphertext: bytesSchema,
});
export type EncryptedRecord = z.infer<typeof EncryptedRecordSchema>;

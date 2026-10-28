import { z } from "zod";

export const RecordKindSchema = z.enum(["item", "media", "thumb"]);
export type RecordKind = z.infer<typeof RecordKindSchema>;

export type Bytes = Uint8Array<ArrayBuffer>;

const bytesSchema = z.custom<Bytes>((value) => value instanceof Uint8Array);
const saltSchema = bytesSchema.refine((value) => value.byteLength === 16);
const ivSchema = bytesSchema.refine((value) => value.byteLength === 12);
const ciphertextSchema = bytesSchema.refine((value) => value.byteLength >= 16);
export const MAX_SUPPORTED_KDF_ITERATIONS = 1_200_000;

export const VaultMetaSchema = z.object({
  v: z.literal(1),
  kdf: z.object({
    name: z.literal("PBKDF2"),
    hash: z.literal("SHA-256"),
    iterations: z.number().int().positive().max(MAX_SUPPORTED_KDF_ITERATIONS),
    salt: saltSchema,
  }),
  // Encrypts a known constant so a wrong passphrase is detected at unlock.
  verifier: z.object({
    iv: ivSchema,
    ciphertext: ciphertextSchema,
  }),
  createdAt: z.string(),
});
export type VaultMeta = z.infer<typeof VaultMetaSchema>;

export const EncryptedRecordSchema = z.object({
  v: z.literal(1),
  id: z.string().min(1),
  kind: RecordKindSchema,
  iv: ivSchema,
  ciphertext: ciphertextSchema,
});
export type EncryptedRecord = z.infer<typeof EncryptedRecordSchema>;

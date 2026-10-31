import { z } from "zod";
import { CategorySchema } from "./item";

export const SLOT_IDS = ["feed", "picks", "messages", "more-feed"] as const;
export const SlotIdSchema = z.enum(SLOT_IDS);
export type SlotId = z.infer<typeof SlotIdSchema>;

export const MAX_KEYWORDS = 5;
export const HANDLE_MAX = 30;
export const DEFAULT_SLOTS: SlotId[] = ["feed", "picks", "messages"];

export const SettingsSchema = z.object({
  // What the marketplace picks box favours.
  categories: z.array(CategorySchema).default([]),
  keywords: z.array(z.string().min(1).max(40)).max(MAX_KEYWORDS).default([]),
  // Which box sits in each of the three landing positions: main, top side, bottom side.
  slots: z.tuple([SlotIdSchema, SlotIdSchema, SlotIdSchema]).default(["feed", "picks", "messages"]),
  // How other people see me in a share file. authorId is random and never derived from the passphrase.
  handle: z.string().trim().min(1).max(HANDLE_MAX).nullable().default(null),
  authorId: z.string().min(1).nullable().default(null),
  // Pull-sync policy (spec section 3): sync runs on wifi unless you opt into cellular.
  syncOnCellular: z.boolean().default(false),
  // Where this vault publishes its eic-feed (set once the publish target is chosen) and the
  // last manifest sequence number published there.
  feedUrl: z.string().min(1).nullable().default(null),
  feedSeq: z.number().int().nonnegative().default(0),
  schemaVersion: z.literal(1),
});
export type Settings = z.infer<typeof SettingsSchema>;

export const SETTINGS_RECORD_ID = "settings";

export const ConnectionSchema = z.object({
  id: z.string().min(1),
  handle: z.string().min(1).max(HANDLE_MAX),
  addedAt: z.iso.datetime(),
  // Local-only, never shared: your nickname for them, whether you hid them, and when you last imported their file.
  nickname: z.string().min(1).max(HANDLE_MAX).nullable().default(null),
  hidden: z.boolean().default(false),
  lastImportAt: z.iso.datetime().nullable().default(null),
  // From the author's eic-share v2 bundle: their Ed25519 public key and (once sync lands) the
  // feed URL their vault publishes to. Null for legacy v1 (unsigned) imports.
  pubkey: z.string().min(1).nullable().default(null),
  feedUrl: z.string().min(1).nullable().default(null),
  // Pull-sync cursors: last applied manifest sequence and HTTP etag, plus whether a chunk is
  // waiting on the cellular byte budget. Local-only, never shared.
  syncSeq: z.number().int().nonnegative().default(0),
  syncEtag: z.string().nullable().default(null),
  syncPending: z.boolean().default(false),
  // Consecutive pulls of the same manifest seq that still had unfetchable chunks. Bounded so
  // a permanently-missing chunk stops retrying instead of pending forever. Local-only.
  syncRetry: z.number().int().nonnegative().default(0),
  // True only when chunk fetches for the current manifest exhausted their retry budget:
  // the structured signal for the explicit "retry failed chunks" affordance (no string parsing).
  syncExhausted: z.boolean().default(false),
  // Last pull outcome and a short reason, for honest user-visible sync status. Local-only.
  syncStatus: z.string().default(""),
  syncDetail: z.string().default(""),
  schemaVersion: z.literal(1),
});
export type Connection = z.infer<typeof ConnectionSchema>;

export const NoteSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1).max(500),
  createdAt: z.iso.datetime(),
  schemaVersion: z.literal(1),
});
export type Note = z.infer<typeof NoteSchema>;

export const JOURNAL_ENTRY_MAX = 5000;

export const JournalEntrySchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1).max(JOURNAL_ENTRY_MAX),
  createdAt: z.iso.datetime(),
  schemaVersion: z.literal(1),
});
export type JournalEntry = z.infer<typeof JournalEntrySchema>;

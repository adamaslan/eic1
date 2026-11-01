import { z } from "zod";
import { AppError, ConnectionSchema, JOURNAL_ENTRY_MAX, JournalEntrySchema, type JournalEntry } from "@veil/core";
import type { UnlockedVault } from "@veil/vault";
import { SHARE_FORMAT, SHARE_VERSION } from "./sharing";
import { MAX_POST_LINK_CHARS, POST_LINK_PREFIX, toBase64Url } from "./share-link";

/**
 * Share ONE journal entry as a link. Sharing is always the owner's explicit per-entry choice:
 * entries stay out of every share file, and a shared entry remains a journal entry - it never
 * becomes a public post. The payload travels in the URL fragment, so it never reaches a server.
 *
 * Size honesty (measured, not assumed): a max-length ASCII entry fits the link cap (~7,018
 * chars), but max-length accented, CJK, or emoji entries run 13,700-27,000 chars. The cap is
 * checked on the FINAL encoded link, so oversized entries fail honestly instead of truncating.
 */
const JournalShareBundleSchema = z.object({
  format: z.literal(SHARE_FORMAT),
  version: z.literal(SHARE_VERSION),
  type: z.literal("journal-entry"),
  exportedAt: z.iso.datetime(),
  author: z.object({ id: z.string().min(1), handle: ConnectionSchema.shape.handle }),
  entry: z.object({
    text: z.string().min(1).max(JOURNAL_ENTRY_MAX),
    createdAt: z.iso.datetime(),
  }),
});
export type JournalShareBundle = z.infer<typeof JournalShareBundleSchema>;

export function buildJournalShareBundle(input: {
  authorId: string;
  authorHandle: string;
  text: string;
  createdAt: string;
  now: Date;
}): string {
  return JSON.stringify({
    format: SHARE_FORMAT,
    version: SHARE_VERSION,
    type: "journal-entry",
    exportedAt: input.now.toISOString(),
    author: { id: input.authorId, handle: input.authorHandle },
    entry: { text: input.text, createdAt: input.createdAt },
  } satisfies JournalShareBundle);
}

/** Throws AppError when the final link - Unicode, base64 overhead, and URL included - exceeds the cap. */
export function buildJournalShareLink(bundleText: string, baseUrl: string): string {
  const link = `${baseUrl}${POST_LINK_PREFIX}${toBase64Url(bundleText)}`;
  if (link.length > MAX_POST_LINK_CHARS) {
    throw new AppError("That entry is too big for a link. Nothing was shared.");
  }
  return link;
}

/** True when a decoded `#import=` payload is a journal entry, not a post bundle. */
export function isJournalShareBundle(text: string): boolean {
  try {
    const json: unknown = JSON.parse(text);
    return typeof json === "object" && json !== null && (json as { type?: string }).type === "journal-entry";
  } catch {
    return false;
  }
}

/** Parses and validates a journal-entry payload; throws AppError with an honest message otherwise. */
export function parseJournalShareBundle(text: string): JournalShareBundle {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new AppError("That shared entry is damaged. Ask your friend for a fresh link.");
  }
  const parsed = JournalShareBundleSchema.safeParse(json);
  if (!parsed.success) throw new AppError("That shared entry is damaged. Ask your friend for a fresh link.");
  return parsed.data;
}

/**
 * Saves a received entry as the recipient's own journal entry: new id, original text and date
 * preserved so the copy says when the author wrote it. Always the recipient's explicit click.
 */
export async function saveSharedJournalEntry(
  vault: UnlockedVault,
  bundle: JournalShareBundle,
  deps: { newId: () => string },
): Promise<JournalEntry> {
  const copy = JournalEntrySchema.parse({
    id: `journal:${deps.newId()}`,
    text: bundle.entry.text,
    createdAt: bundle.entry.createdAt,
    schemaVersion: 1,
  });
  await vault.putJson("journal", copy.id, copy);
  return copy;
}

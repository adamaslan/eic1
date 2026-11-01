import { z } from "zod";
import { ConnectionSchema, ItemSchema, JournalEntrySchema, type Connection, type Item, type JournalEntry } from "@veil/core";

/**
 * Export everything: a readable archive of the vault's own content - posts and listings
 * (including private ones), journal entries, and connections. Unlike the encrypted .vault
 * backup, this file is plain JSON anyone holding it can read, so the route only offers it
 * behind explicit category choices and a visible warning, and nothing is ever sent
 * anywhere: the file downloads to the user's own device, and that is the whole journey.
 *
 * Hidden connections stay in the export: hiding controls what the graph and feeds show,
 * not what the vault owns. Their entries are marked so a reader can tell.
 */

export const EXPORT_FORMAT = "eic-export";
export const EXPORT_VERSION = 1;

export const ExportBundleSchema = z.object({
  format: z.literal(EXPORT_FORMAT),
  version: z.literal(EXPORT_VERSION),
  exportedAt: z.iso.datetime(),
  handle: z.string().min(1).nullable(),
  items: z.array(ItemSchema),
  journal: z.array(JournalEntrySchema),
  connections: z.array(ConnectionSchema),
});
export type ExportBundle = z.infer<typeof ExportBundleSchema>;

export interface ExportSelection {
  items: boolean;
  journal: boolean;
  connections: boolean;
}

export const EXPORT_CATEGORY_LABELS: Record<keyof ExportSelection, string> = {
  items: "Posts and listings (including private ones)",
  journal: "Journal entries",
  connections: "Connections",
};

export function buildVaultExport(
  input: {
    handle: string | null;
    items: Item[];
    journal: JournalEntry[];
    connections: Connection[];
    selection: ExportSelection;
    now: Date;
  },
): ExportBundle {
  return ExportBundleSchema.parse({
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: input.now.toISOString(),
    handle: input.handle,
    items: input.selection.items ? input.items : [],
    journal: input.selection.journal ? input.journal : [],
    connections: input.selection.connections ? input.connections : [],
  });
}

/** Counts for honest confirmation copy: the user sees exactly what is about to leave the vault. */
export function describeExport(bundle: ExportBundle): string {
  const parts: string[] = [];
  if (bundle.items.length > 0) parts.push(`${bundle.items.length} ${bundle.items.length === 1 ? "post or listing" : "posts and listings"}`);
  if (bundle.journal.length > 0) parts.push(`${bundle.journal.length} journal ${bundle.journal.length === 1 ? "entry" : "entries"}`);
  if (bundle.connections.length > 0) parts.push(`${bundle.connections.length} ${bundle.connections.length === 1 ? "connection" : "connections"}`);
  return parts.length === 0 ? "nothing" : parts.join(", ");
}

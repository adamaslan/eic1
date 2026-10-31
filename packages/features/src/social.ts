import {
  AppError,
  DEFAULT_SLOTS,
  HANDLE_MAX,
  MAX_KEYWORDS,
  NoteSchema,
  SETTINGS_RECORD_ID,
  SettingsSchema,
  ConnectionSchema,
  type Connection,
  type Item,
  type Note,
  type Settings,
} from "@veil/core";
import type { UnlockedVault } from "@veil/vault";

export const PICKS_LIMIT = 3;

export function defaultSettings(): Settings {
  return SettingsSchema.parse({ slots: DEFAULT_SLOTS, schemaVersion: 1 });
}

/** A missing or unreadable settings record falls back to defaults; it is only rewritten on the next save. */
export async function loadSettings(vault: UnlockedVault): Promise<Settings> {
  const raw = await vault.getJson(SETTINGS_RECORD_ID);
  if (raw === null) return defaultSettings();
  const parsed = SettingsSchema.safeParse(raw);
  return parsed.success ? parsed.data : defaultSettings();
}

export async function saveSettings(vault: UnlockedVault, settings: Settings): Promise<Settings> {
  const clean = SettingsSchema.parse({
    ...settings,
    keywords: normalizeKeywords(settings.keywords),
  });
  await vault.putJson("settings", SETTINGS_RECORD_ID, clean);
  return clean;
}

/** Lowercases, trims, drops blanks and duplicates, and keeps at most MAX_KEYWORDS. */
export function normalizeKeywords(keywords: string[]): string[] {
  const seen = new Set<string>();
  for (const keyword of keywords) {
    const clean = keyword.trim().toLowerCase().slice(0, 40);
    if (clean) seen.add(clean);
  }
  return [...seen].slice(0, MAX_KEYWORDS);
}

/** Gives this vault a random author id the first time it needs one. */
export async function ensureAuthorId(vault: UnlockedVault, settings: Settings, newId: () => string): Promise<Settings> {
  if (settings.authorId) return settings;
  return saveSettings(vault, { ...settings, authorId: newId() });
}

/**
 * Picks the listings that best match the user's categories and keywords, newest first among equals.
 * With no preferences, or when nothing matches, it falls back to the newest listings so the box is never empty.
 */
export function selectPicks(items: Item[], settings: Pick<Settings, "categories" | "keywords">, limit = PICKS_LIMIT): Item[] {
  const listings = items.filter((item) => item.type === "listing");
  const keywords = settings.keywords.map((keyword) => keyword.toLowerCase());
  const score = (item: Item): number => {
    let total = settings.categories.includes(item.category) ? 2 : 0;
    const text = `${item.title} ${item.description}`.toLowerCase();
    for (const keyword of keywords) {
      if (text.includes(keyword)) total += 1;
    }
    return total;
  };
  const time = (item: Item) => new Date(item.createdAt).getTime();
  return listings
    .map((item) => ({ item, score: score(item) }))
    .sort((a, b) => b.score - a.score || time(b.item) - time(a.item))
    .slice(0, limit)
    .map((entry) => entry.item);
}

/** Flips my like on a post and keeps the count in step. Returns the updated item. */
export async function toggleLike(vault: UnlockedVault, item: Item): Promise<Item> {
  const likedByMe = !item.likedByMe;
  const updated: Item = { ...item, likedByMe, likes: Math.max(0, item.likes + (likedByMe ? 1 : -1)) };
  await vault.putItem(updated);
  return updated;
}

export async function addNote(vault: UnlockedVault, text: string, deps: { newId: () => string; now: Date }): Promise<Note> {
  const note = NoteSchema.parse({
    id: deps.newId(),
    text: text.trim(),
    createdAt: deps.now.toISOString(),
    schemaVersion: 1,
  });
  await vault.putJson("note", note.id, note);
  return note;
}

/** Newest first. Records that no longer parse are skipped rather than failing the whole list. */
export async function listNotes(vault: UnlockedVault): Promise<Note[]> {
  const raw = await vault.listJson("note");
  return raw
    .flatMap((value) => {
      const parsed = NoteSchema.safeParse(value);
      return parsed.success ? [parsed.data] : [];
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Connection values keep the author id; their vault record keys are `connection:${authorId}`. */
export async function listConnections(vault: UnlockedVault): Promise<Connection[]> {
  const raw = await vault.listJson("connection");
  const byId = new Map<string, Connection>();
  for (const value of raw) {
    const parsed = ConnectionSchema.safeParse(value);
    if (!parsed.success) continue;
    const connection = parsed.data;
    const existing = byId.get(connection.id);
    if (!existing || Date.parse(connection.addedAt) > Date.parse(existing.addedAt)) {
      byId.set(connection.id, connection);
    }
  }
  return [...byId.values()].sort((a, b) => a.handle.localeCompare(b.handle));
}

export interface ConnectionSummary {
  connection: Connection;
  postCount: number;
}

/** Per-connection stats for the management UI: how many of their posts live in this vault. */
export function summarizeConnections(connections: Connection[], items: Item[]): ConnectionSummary[] {
  return connections.map((connection) => ({
    connection,
    postCount: items.filter((item) => item.authorId === connection.id).length,
  }));
}

async function updateConnection(vault: UnlockedVault, connectionId: string, change: (connection: Connection) => Connection): Promise<Connection> {
  const recordId = `connection:${connectionId}`;
  const parsed = ConnectionSchema.safeParse(await vault.getJson(recordId));
  if (!parsed.success) throw new AppError("That connection does not exist.");
  const updated = ConnectionSchema.parse(change(parsed.data));
  await vault.putJson("connection", recordId, updated);
  return updated;
}

/** Sets or clears your local nickname for a connection (null clears). It never leaves this vault. */
export async function setConnectionNickname(vault: UnlockedVault, connectionId: string, nickname: string | null): Promise<Connection> {
  const clean = nickname === null ? null : nickname.trim().slice(0, HANDLE_MAX) || null;
  return updateConnection(vault, connectionId, (connection) => ({ ...connection, nickname: clean }));
}

/** Hides a connection from the list without deleting anything; their posts stay in the vault. */
export async function setConnectionHidden(vault: UnlockedVault, connectionId: string, hidden: boolean): Promise<Connection> {
  return updateConnection(vault, connectionId, (connection) => ({ ...connection, hidden }));
}

/**
 * Removes a connection. With dropPosts, their imported posts and photos are deleted too;
 * otherwise the posts stay in the vault. Likes they gave you are left as they were.
 */
export async function removeConnection(
  vault: UnlockedVault,
  connectionId: string,
  options: { dropPosts: boolean },
): Promise<{ droppedPosts: number }> {
  const recordId = `connection:${connectionId}`;
  const parsed = ConnectionSchema.safeParse(await vault.getJson(recordId));
  if (!parsed.success) throw new AppError("That connection does not exist.");
  const ids = [recordId];
  let droppedPosts = 0;
  if (options.dropPosts) {
    const theirs = (await vault.listItems()).filter((item) => item.authorId === connectionId);
    droppedPosts = theirs.length;
    for (const item of theirs) {
      ids.push(item.id, ...item.mediaIds);
      if (item.thumbId) ids.push(item.thumbId);
    }
  }
  await vault.deleteRecords(ids);
  return { droppedPosts };
}

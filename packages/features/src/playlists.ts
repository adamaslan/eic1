import { AppError } from "@veil/core";
import type { UnlockedVault } from "@veil/vault";
import {
  MAX_PLAYLIST_NAME,
  SavedPlaylistSchema,
  type SavedPlaylist,
} from "./music";

// Saved playlists live in the encrypted vault (record kind "playlist"): names, order,
// durations and stars only. Audio bytes are never written to the vault by the player.
// A second record (SESSION_ID) remembers where playback stopped so a playlist can resume.

export const MUSIC_SESSION_ID = "playlist:@session";

export interface MusicSession {
  format: "eic-music-session";
  version: 1;
  playlistName: string;
  trackName: string;
  positionSeconds: number;
  savedAt: string;
}

export async function listPlaylists(vault: UnlockedVault): Promise<SavedPlaylist[]> {
  const raw = await vault.listJson("playlist", { skipUndecryptable: true });
  const out: SavedPlaylist[] = [];
  for (const value of raw) {
    const parsed = SavedPlaylistSchema.safeParse(value);
    if (parsed.success) out.push(parsed.data);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}


/** Names starting with @ are reserved for the player's own internal records
    (the resume-session record lives at "playlist:@session"). A user playlist
    with such a name would silently overwrite them, so refuse it up front. */
export function assertPlaylistNameAllowed(name: string): void {
  if (name.startsWith("@")) {
    throw new AppError(`Playlist names starting with @ are reserved for the player itself. Pick another name.`);
  }
}

export async function savePlaylist(vault: UnlockedVault, playlist: SavedPlaylist): Promise<void> {
  const parsed = SavedPlaylistSchema.parse(playlist);
  assertPlaylistNameAllowed(parsed.name);
  const clash = (await listPlaylists(vault)).some(
    (p) => p.name.toLowerCase() === parsed.name.toLowerCase() && p.savedAt !== parsed.savedAt,
  );
  if (clash) {
    // Same-name save is an overwrite of that playlist, not a second copy.
    const existing = (await listPlaylists(vault)).find((p) => p.name.toLowerCase() === parsed.name.toLowerCase());
    if (existing && existing.name !== parsed.name) throw new AppError(`A playlist named "${existing.name}" already exists.`);
  }
  await vault.putJson("playlist", `playlist:${parsed.name}`, parsed);
}

export async function deletePlaylist(vault: UnlockedVault, name: string): Promise<void> {
  await vault.deleteRecords([`playlist:${name}`]);
}

export async function renamePlaylist(vault: UnlockedVault, from: string, to: string): Promise<void> {
  const clean = to.trim();
  if (!clean) throw new AppError("Give the playlist a name.");
  if (clean.length > MAX_PLAYLIST_NAME) throw new AppError(`Keep the name under ${MAX_PLAYLIST_NAME} characters.`);
  assertPlaylistNameAllowed(clean);
  if ((await listPlaylists(vault)).some((p) => p.name.toLowerCase() === clean.toLowerCase())) {
    throw new AppError(`A playlist named "${clean}" already exists.`);
  }
  const current = (await listPlaylists(vault)).find((p) => p.name === from);
  if (!current) throw new AppError(`No playlist named "${from}".`);
  await vault.putJson("playlist", `playlist:${clean}`, { ...current, name: clean });
  await vault.deleteRecords([`playlist:${from}`]);
}

export async function saveMusicSession(vault: UnlockedVault, session: MusicSession): Promise<void> {
  await vault.putJson("playlist", MUSIC_SESSION_ID, session);
}

export async function loadMusicSession(vault: UnlockedVault): Promise<MusicSession | null> {
  const raw = await vault.getJson(MUSIC_SESSION_ID);
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Partial<MusicSession>;
  if (s.format !== "eic-music-session" || s.version !== 1) return null;
  if (typeof s.playlistName !== "string" || typeof s.trackName !== "string") return null;
  if (typeof s.positionSeconds !== "number" || !Number.isFinite(s.positionSeconds) || s.positionSeconds < 0) return null;
  return s as MusicSession;
}

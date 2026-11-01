import { describe, expect, it } from "vitest";
import { SubtleCryptoPort } from "@veil/crypto";
import { createVault } from "@veil/vault";
import { MemoryStore } from "../../vault/src/memory-store";
import { SavedPlaylistSchema } from "./music";
import {
  MUSIC_SESSION_ID,
  deletePlaylist,
  listPlaylists,
  loadMusicSession,
  renamePlaylist,
  saveMusicSession,
  savePlaylist,
} from "./playlists";

async function freshVault() {
  return createVault({ store: new MemoryStore(), crypto: new SubtleCryptoPort(), now: () => new Date() }, "pw-test-passphrase");
}

const sample = (name: string) =>
  SavedPlaylistSchema.parse({
    format: "eic-playlist",
    version: 1,
    name,
    savedAt: new Date().toISOString(),
    tracks: [{ name: "1 a.mp3", path: "mix/1 a.mp3", durationSeconds: 61 }],
  });

describe("saved playlists in the vault", () => {
  it("saves, lists and deletes encrypted playlist metadata", async () => {
    const vault = await freshVault();
    await savePlaylist(vault, sample("Gym"));
    await savePlaylist(vault, sample("Calm"));
    const names = (await listPlaylists(vault)).map((p) => p.name);
    expect(names).toEqual(["Calm", "Gym"]);
    await deletePlaylist(vault, "Gym");
    expect((await listPlaylists(vault)).map((p) => p.name)).toEqual(["Calm"]);
  });

  it("overwrites the same name instead of duplicating", async () => {
    const vault = await freshVault();
    await savePlaylist(vault, sample("Gym"));
    await savePlaylist(vault, { ...sample("Gym"), tracks: [] });
    const all = await listPlaylists(vault);
    expect(all).toHaveLength(1);
    expect(all[0]!.tracks).toEqual([]);
  });

  it("renames and refuses clashes and blanks", async () => {
    const vault = await freshVault();
    await savePlaylist(vault, sample("Gym"));
    await savePlaylist(vault, sample("Calm"));
    await renamePlaylist(vault, "Gym", "Workout");
    expect((await listPlaylists(vault)).map((p) => p.name)).toEqual(["Calm", "Workout"]);
    await expect(renamePlaylist(vault, "Workout", "calm")).rejects.toThrow(/already exists/);
    await expect(renamePlaylist(vault, "Workout", "   ")).rejects.toThrow(/name/);
  });

  it("round-trips the resume session and ignores junk", async () => {
    const vault = await freshVault();
    expect(await loadMusicSession(vault)).toBeNull();
    await saveMusicSession(vault, {
      format: "eic-music-session",
      version: 1,
      playlistName: "Gym",
      trackName: "1 a.mp3",
      positionSeconds: 42.5,
      savedAt: new Date().toISOString(),
    });
    const s = await loadMusicSession(vault);
    expect(s?.positionSeconds).toBe(42.5);
    // The session record must not appear among named playlists.
    expect(await listPlaylists(vault)).toEqual([]);
    await vault.putJson("playlist", MUSIC_SESSION_ID, { garbage: true });
    expect(await loadMusicSession(vault)).toBeNull();
  });
});

describe("reserved playlist names", () => {
  it("refuses to save a playlist named @session and keeps the resume record intact", async () => {
    const vault = await freshVault();
    await saveMusicSession(vault, {
      format: "eic-music-session",
      version: 1,
      playlistName: "Gym",
      trackName: "1 a.mp3",
      positionSeconds: 42,
      savedAt: new Date().toISOString(),
    });
    await expect(savePlaylist(vault, sample("@session"))).rejects.toThrow(/reserved/);
    const session = await loadMusicSession(vault);
    expect(session?.playlistName).toBe("Gym");
    expect(session?.positionSeconds).toBe(42);
    expect(await listPlaylists(vault)).toEqual([]);
  });

  it("refuses any name starting with @, without touching existing playlists", async () => {
    const vault = await freshVault();
    await savePlaylist(vault, sample("Gym"));
    await expect(savePlaylist(vault, sample("@favorites"))).rejects.toThrow(/reserved/);
    expect((await listPlaylists(vault)).map((p) => p.name)).toEqual(["Gym"]);
  });

  it("refuses to rename onto a reserved name and keeps both the playlist and the resume record", async () => {
    const vault = await freshVault();
    await savePlaylist(vault, sample("Gym"));
    await saveMusicSession(vault, {
      format: "eic-music-session",
      version: 1,
      playlistName: "Gym",
      trackName: "1 a.mp3",
      positionSeconds: 7,
      savedAt: new Date().toISOString(),
    });
    await expect(renamePlaylist(vault, "Gym", "@session")).rejects.toThrow(/reserved/);
    expect((await listPlaylists(vault)).map((p) => p.name)).toEqual(["Gym"]);
    expect((await loadMusicSession(vault))?.positionSeconds).toBe(7);
  });

  it("negative control: ordinary names still save and rename next to the resume record", async () => {
    const vault = await freshVault();
    await saveMusicSession(vault, {
      format: "eic-music-session",
      version: 1,
      playlistName: "Gym",
      trackName: "1 a.mp3",
      positionSeconds: 3,
      savedAt: new Date().toISOString(),
    });
    await savePlaylist(vault, sample("Gym"));
    await renamePlaylist(vault, "Gym", "Gym 2");
    expect((await listPlaylists(vault)).map((p) => p.name)).toEqual(["Gym 2"]);
    expect((await loadMusicSession(vault))?.positionSeconds).toBe(3);
  });
});

describe("pre-fix reserved-name records", () => {
  it("an existing @-named playlist still lists, displays and deletes honestly - only re-save is blocked", async () => {
    const vault = await freshVault();
    // Simulate a record written before the reservation existed.
    await vault.putJson("playlist", "playlist:@odd", sample("@odd"));
    const listed = await listPlaylists(vault);
    expect(listed.map((p) => p.name)).toEqual(["@odd"]);
    await expect(savePlaylist(vault, sample("@odd"))).rejects.toThrow(/reserved/);
    await renamePlaylist(vault, "@odd", "Rescued");
    expect((await listPlaylists(vault)).map((p) => p.name)).toEqual(["Rescued"]);
    await vault.putJson("playlist", "playlist:@odd", sample("@odd"));
    await deletePlaylist(vault, "@odd");
    expect((await listPlaylists(vault)).map((p) => p.name)).toEqual(["Rescued"]);
  });
});

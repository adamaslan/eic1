import { describe, expect, it } from "vitest";
import { createVault } from "@veil/vault";
import { SubtleCryptoPort } from "@veil/crypto";
import { MemoryStore } from "../../vault/src/memory-store";
import { defaultProfile, getProfile, ProfileSchema } from "./profile";
import { newProfileDraft, reviewLatestFeedProfile, loadProfileDraft, saveProfileDraft, selectedProfile, updateFeedProfile } from "./profile-studio";
import { defaultSettings, saveSettings } from "./social";
import { buildFeedSnapshot } from "./feed";
const now = new Date("2026-11-01T16:00:00Z");
async function setup() {
  const vault = await createVault({ store: new MemoryStore(), crypto: new SubtleCryptoPort(), now: () => now }, "private-profile-passphrase");
  const settings = { ...defaultSettings(), authorId: "alice", handle: "alice", feedUrl: "https://example.com/feed" };
  await saveSettings(vault, settings);
  return { vault, settings };
}
describe("private profile studio", () => {
  it("private saves never become feed chunks, even with all selectors on", async () => {
    const { vault, settings } = await setup();
    const draft = await loadProfileDraft(vault);
    draft.profile.bio = "PRIVATE BIO"; draft.song = "PRIVATE SONG";
    draft.selected.bio = true; draft.selected.song = true;
    await saveProfileDraft(vault, draft);
    expect((await loadProfileDraft(vault)).song).toBe("PRIVATE SONG");
    expect(await getProfile(vault, "alice")).toBe(null);
    const snapshot = await buildFeedSnapshot(vault, settings, [], { now, seq: 1 });
    expect(snapshot.files.find(f => f.path === "chunks/profile.json")).toBeUndefined();
    expect(JSON.stringify(snapshot)).not.toContain("PRIVATE");
  });
  it("actual exported bytes omit unselected fields and leave private draft intact", async () => {
    const { vault, settings } = await setup();
    const draft = await loadProfileDraft(vault);
    draft.profile.bio = "PRIVATE BIO"; draft.song = "PRIVATE SONG"; draft.book = "Selected Book";
    draft.selected.book = true;
    await saveProfileDraft(vault, draft);
    await updateFeedProfile(vault, draft, now);
    const snapshot = await buildFeedSnapshot(vault, settings, [], { now, seq: 1 });
    const bytes = snapshot.files.find(f => f.path === "chunks/profile.json")!.text;
    expect(bytes).toContain("Favorite book: Selected Book");
    expect(bytes).not.toContain("PRIVATE");
    expect((await loadProfileDraft(vault)).song).toBe("PRIVATE SONG");
  });
  it("deselection replaces old feed fields without deleting draft or promising recall", async () => {
    const { vault } = await setup();
    const draft = await loadProfileDraft(vault);
    draft.song = "Previously selected"; draft.selected.song = true;
    const first = await updateFeedProfile(vault, draft, now);
    draft.feedBaseline = first;
    draft.selected.song = false;
    const next = await updateFeedProfile(vault, draft, now);
    expect(next.seq).toBe(first.seq + 1); expect(next.bio).toBe("");
    expect(draft.song).toBe("Previously selected");
  });
  it("legacy v1 round-trips without new wire fields; old saved profiles are preserved", async () => {
    const { vault } = await setup();
    const draft = newProfileDraft(defaultProfile("alice", "alice", now));
    draft.song = "a song"; draft.selected.song = true;
    const projected = selectedProfile(draft, "alice");
    expect(ProfileSchema.parse(JSON.parse(JSON.stringify(projected)))).toEqual(projected);
    expect(Object.keys(projected)).not.toContain("song");
    await updateFeedProfile(vault, draft, now);
    const restored = await loadProfileDraft(vault);
    expect(restored.profile.bio).toBe("Favorite song: a song");
    expect(restored.selected.bio).toBe(true);
  });
  it("over-cap selection fails without truncation or altering the saved feed", async () => {
    const { vault } = await setup(); const draft = await loadProfileDraft(vault);
    const before = await updateFeedProfile(vault, draft, now);
    draft.feedBaseline = before;
    draft.profile.bio = "x".repeat(500); draft.song = "more"; draft.selected.bio = true; draft.selected.song = true;
    await expect(updateFeedProfile(vault, draft, now)).rejects.toThrow("Nothing was updated");
    expect(await getProfile(vault, "alice")).toEqual(before);
  });
  it("rejects foreign/corrupt drafts, and private edits cannot spoof authorId", async () => {
    const { vault } = await setup(); const draft = await loadProfileDraft(vault);
    draft.profile.authorId = "someone-else";
    await expect(saveProfileDraft(vault, draft)).rejects.toThrow("not your");
    await expect(updateFeedProfile(vault, draft, now)).rejects.toThrow();
    await vault.putJson("settings", "profile-studio:alice", { broken: true });
    await expect(loadProfileDraft(vault)).rejects.toThrow("could not be read");
  });
});

describe("profile studio compatibility and isolation", () => {
  it("backup/restore retains draft and selected snapshot as separate encrypted records", async () => {
    const { exportBackup, importBackup } = await import("@veil/vault");
    const { unlockVault } = await import("@veil/vault");
    const store = new MemoryStore();
    const deps = { store, crypto: new SubtleCryptoPort(), now: () => now };
    const vault = await createVault(deps, "backup-profile-passphrase");
    await saveSettings(vault, { ...defaultSettings(), authorId: "alice", handle: "alice" });
    const draft = await loadProfileDraft(vault); draft.song = "PRIVATE RESTORED SONG"; draft.book = "PUBLIC BOOK"; draft.selected.book = true;
    await saveProfileDraft(vault, draft); await updateFeedProfile(vault, draft, now);
    const backup = await exportBackup(store, now);
    expect(backup).not.toContain("PRIVATE RESTORED SONG"); expect(backup).not.toContain("PUBLIC BOOK");
    const otherStore = new MemoryStore(); const otherDeps = { ...deps, store: otherStore };
    await importBackup(otherDeps, backup);
    const restored = await unlockVault(otherDeps, "backup-profile-passphrase");
    expect((await loadProfileDraft(restored)).song).toBe("PRIVATE RESTORED SONG");
    expect((await getProfile(restored, "alice"))!.bio).toBe("Favorite book: PUBLIC BOOK");
    // Existing pre-studio APIs re-save settings and profile without touching separate draft.
    const { loadSettings } = await import("./social");
    const { saveOwnProfile } = await import("./profile");
    await saveSettings(restored, { ...await loadSettings(restored), handle: "renamed" });
    const oldProfile = (await getProfile(restored, "alice"))!;
    await saveOwnProfile(restored, { ...oldProfile, bio: "Edited by legacy API" }, now);
    expect((await getProfile(restored, "alice"))!.bio).toBe("Edited by legacy API");
    expect((await loadProfileDraft(restored)).song).toBe("PRIVATE RESTORED SONG");
    expect((await loadProfileDraft(restored)).profile.bio).toBe("");
  });
  it("selected legacy bytes sign, verify and apply in another vault, while omitted assets stay out", async () => {
    const { signProfile, parseSignedProfile, verifySignedProfile, applyProfile } = await import("./profile");
    const { vault } = await setup(); const draft = await loadProfileDraft(vault);
    draft.profile.avatar = { kind: "data-uri", mime: "image/png", data: "UFJJVkFURSBJTUFHRQ==" };
    draft.profile.decorations = [{ id: "private-sticker", kind: "sticker", asset: { kind: "inline-svg", data: "<svg>PRIVATE</svg>" }, position: { x: 0, y: 0, z: 0 }, rotation: 0, scale: 1 }];
    draft.song = "Shared song"; draft.selected.song = true;
    const projected = await updateFeedProfile(vault, draft, now);
    const signed = await signProfile(vault, projected); const bytes = JSON.stringify(signed);
    expect(bytes).not.toContain("PRIVATE"); expect(bytes).not.toContain("UFJJVkFURSBJTUFHRQ==");
    const incoming = parseSignedProfile(bytes); await verifySignedProfile(incoming, "alice", signed.pubkey);
    const other = await createVault({ store: new MemoryStore(), crypto: new SubtleCryptoPort(), now: () => now }, "recipient-passphrase");
    await saveSettings(other, { ...defaultSettings(), authorId: "bob", handle: "bob" });
    expect((await applyProfile(other, incoming.profile)).applied).toBe(true);
    expect((await getProfile(other, "alice"))!.bio).toBe("Favorite song: Shared song");
    expect((await getProfile(other, "alice"))!.avatar).toBe(null);
  });
});

describe("stale feed publication", () => {
  it("rejects stale studio state and preserves current fields; explicit latest review permits retry", async () => {
    const { vault } = await setup();
    const old = await loadProfileDraft(vault), other = await loadProfileDraft(vault);
    other.profile.theme.wallpaper = "clouds"; other.selected.theme = true;
    const newer = await updateFeedProfile(vault, other, now);
    old.song = "private song"; old.selected.song = false;
    await expect(updateFeedProfile(vault, old, now)).rejects.toThrow("saved profile changed");
    expect(await getProfile(vault, "alice")).toEqual(newer);
    const reviewed = await reviewLatestFeedProfile(vault, old);
    expect(reviewed.song).toBe("private song"); expect(reviewed.selected.song).toBe(false);
    expect(reviewed.feedBaseline).toEqual(newer);
    const updated = await updateFeedProfile(vault, reviewed, now);
    expect(updated.seq).toBe(newer.seq + 1); expect(updated.bio).not.toContain("private song");
  });
  it("two sessions racing through encryption cannot overwrite the winning update", async () => {
    const { vault } = await setup();
    const left = await loadProfileDraft(vault), right = await loadProfileDraft(vault);
    left.profile.displayName = "left"; right.profile.displayName = "right";
    const result = await Promise.allSettled([updateFeedProfile(vault, left, now), updateFeedProfile(vault, right, now)]);
    expect(result.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(result.filter(r => r.status === "rejected")).toHaveLength(1);
    expect((await getProfile(vault, "alice"))!.seq).toBe(1);
  });
});

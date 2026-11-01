import { describe, expect, it } from "vitest";
import { addProfileSticker, changeProfileSticker, PROFILE_STICKERS } from "./profile-assets";
import { defaultProfile, ProfileSchema } from "./profile";
const base = () => defaultProfile("alice", "alice", new Date("2026-11-01T16:00:00Z"));
describe("profile decorations", () => {
  it("all four stickers are small embedded assets accepted by the legacy schema", () => {
    for (const kind of PROFILE_STICKERS) {
      const profile = addProfileSticker(base(), kind, kind);
      expect(ProfileSchema.parse(profile)).toEqual(profile);
      expect(new TextEncoder().encode(profile.decorations[0].asset.data).length).toBeLessThan(700);
      expect(profile.decorations[0].asset.data).not.toMatch(/https?:\/\/(?!www.w3.org)/);
    }
  });
  it("bounded moves and resizing never change bio/avatar/theme", () => {
    let profile = addProfileSticker(base(), "star", "one");
    for (let i = 0; i < 100; i++) profile = changeProfileSticker(profile, "one", "right");
    expect(profile.decorations[0].position.x).toBe(0.95);
    for (let i = 0; i < 100; i++) profile = changeProfileSticker(profile, "one", "shrink");
    expect(profile.decorations[0].scale).toBe(0.5);
    expect(profile.bio).toBe(base().bio); expect(profile.avatar).toEqual(base().avatar); expect(profile.theme).toEqual(base().theme);
  });
  it("reorders without unbounded z, removes one, and enforces count cap", () => {
    let profile = addProfileSticker(addProfileSticker(base(), "star", "a"), "heart", "b");
    expect(() => addProfileSticker(profile, "smile", "a")).toThrow("unique");
    profile = changeProfileSticker(profile, "a", "front");
    expect(profile.decorations.map(d => d.id)).toEqual(["b", "a"]);
    expect(profile.decorations.map(d => d.position.z)).toEqual([0, 1]);
    profile = changeProfileSticker(profile, "b", "remove"); expect(profile.decorations.map(d => d.id)).toEqual(["a"]);
    for (let i = 0; i < 31; i++) profile = addProfileSticker(profile, "smile", `n${i}`);
    expect(() => addProfileSticker(profile, "smile", "over")).toThrow("This profile already has 32 decorations. Remove one first.");
    expect(() => changeProfileSticker(profile, "missing", "left")).toThrow("Select");
  });
});
it("decorated profile signs/verifies/applies with unchanged legacy APIs and respects asset selection", async () => {
  const { createVault } = await import("@veil/vault"); const { MemoryStore } = await import("../../vault/src/memory-store"); const { SubtleCryptoPort } = await import("@veil/crypto");
  const { saveSettings, defaultSettings } = await import("./social");
  const { newProfileDraft, selectedProfile, saveProfileDraft, loadProfileDraft } = await import("./profile-studio");
  const { signProfile, parseSignedProfile, verifySignedProfile, applyProfile, getProfile } = await import("./profile");
  const open = () => createVault({ store: new MemoryStore(), crypto: new SubtleCryptoPort(), now: () => new Date() }, "asset-compat-passphrase");
  const alice = await open(), bob = await open(); await saveSettings(alice, { ...defaultSettings(), authorId: "alice", handle: "alice" }); await saveSettings(bob, { ...defaultSettings(), authorId: "bob", handle: "bob" });
  const profile = addProfileSticker(base(), "heart", "heart-one"); profile.avatar = { kind: "data-uri", mime: "image/png", data: "aGVsbG8=" };
  const draft = newProfileDraft(profile); await saveProfileDraft(alice, draft);
  expect(selectedProfile(draft, "alice").decorations).toEqual([]); expect(selectedProfile(draft, "alice").avatar).toBeNull();
  draft.selected.avatar = true; draft.selected.decorations = true;
  const signed = await signProfile(alice, selectedProfile(draft, "alice")); const parsed = parseSignedProfile(JSON.stringify(signed)); await verifySignedProfile(parsed, "alice", signed.pubkey); await applyProfile(bob, parsed.profile);
  expect((await getProfile(bob, "alice"))!.decorations[0].kind).toBe("heart"); expect((await getProfile(bob, "alice"))!.avatar).toEqual(profile.avatar);
  expect((await loadProfileDraft(alice)).selected.avatar).toBe(false);
});
it("encrypted backup restore preserves private assets and selected-field privacy", async () => {
  const { createVault, unlockVault } = await import("@veil/vault");
  const { exportBackup, importBackup } = await import("../../vault/src/backup");
  const { MemoryStore } = await import("../../vault/src/memory-store"); const { SubtleCryptoPort } = await import("@veil/crypto");
  const { saveSettings, defaultSettings } = await import("./social");
  const { newProfileDraft, saveProfileDraft, loadProfileDraft, selectedProfile } = await import("./profile-studio");
  const source = new MemoryStore(), target = new MemoryStore(); const now = new Date("2026-11-01T20:00:00Z");
  const deps = (store: InstanceType<typeof MemoryStore>) => ({ store, crypto: new SubtleCryptoPort(), now: () => now });
  const alice = await createVault(deps(source), "asset-backup-passphrase");
  await saveSettings(alice, { ...defaultSettings(), authorId: "alice", handle: "alice" });
  const profile = addProfileSticker(base(), "flower", "private-flower");
  profile.avatar = { kind: "data-uri", mime: "image/png", data: "aGVsbG8=" };
  const draft = newProfileDraft(profile); await saveProfileDraft(alice, draft);
  const backup = await exportBackup(source, now); expect(backup).not.toContain("private-flower");
  await importBackup(deps(target), backup); const restored = await unlockVault(deps(target), "asset-backup-passphrase");
  const loaded = await loadProfileDraft(restored); expect(loaded).toEqual(draft);
  expect(selectedProfile(loaded, "alice").avatar).toBeNull(); expect(selectedProfile(loaded, "alice").decorations).toEqual([]);
});
it("20 actual Paint exports are distinct bounded96px PNGs, not remote URLs", async () => {
  const { PROFILE_AVATARS } = await import("./profile-avatars");
  const { decodeBase64 } = await import("@veil/core");
  expect(PROFILE_AVATARS).toHaveLength(20); expect(new Set(PROFILE_AVATARS.map(a => a.data)).size).toBe(20);
  expect(new Set(PROFILE_AVATARS.map(a => a.id)).size).toBe(20);
  for (const avatar of PROFILE_AVATARS) { const bytes = decodeBase64(avatar.data); const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); expect(view.getUint32(16)).toBe(96); expect(view.getUint32(20)).toBe(96); expect(bytes.length).toBeLessThanOrEqual(25 * 1024); }
});

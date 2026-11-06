import { describe, expect, it } from "vitest";
import { SubtleCryptoPort } from "@veil/crypto";
import { createVault } from "@veil/vault";
import { MemoryStore } from "../../vault/src/memory-store";
import { defaultProfile, getProfile } from "./profile";
import { newProfileDraft, saveProfileDraft, selectedProfile } from "./profile-studio";
import { defaultSettings, saveSettings } from "./social";
import { PROFILE_AVATARS } from "./profile-avatars";
import { loadDisplayAvatar } from "./display-avatar";

describe("local display avatars", () => {
  it("uses own private draft locally, only saved peer profile for peer, no feed mutation or missing-peer fallback", async () => {
    const now = new Date("2026-11-06T18:00:00Z");
    const vault = await createVault({ store: new MemoryStore(), crypto: new SubtleCryptoPort(), now: () => now }, "private-avatar-test");
    await saveSettings(vault, { ...defaultSettings(), authorId: "owner", handle: "owner" });
    const owner = { ...defaultProfile("owner", "owner", now), avatar: { kind: "data-uri" as const, mime: "image/png", data: PROFILE_AVATARS[0].data } };
    const draft = newProfileDraft(owner); await saveProfileDraft(vault, draft);
    expect(await loadDisplayAvatar(vault)).toEqual(owner.avatar);
    expect(await loadDisplayAvatar(vault, "owner")).toEqual(owner.avatar);
    expect(await loadDisplayAvatar(vault, "missing-peer")).toBeNull();
    expect(await getProfile(vault, "owner")).toBeNull();
    expect(selectedProfile(draft, "owner").avatar).toBeNull();
    const peer = { ...defaultProfile("peer", "Peer", now), avatar: { ...owner.avatar, data: PROFILE_AVATARS[1].data } };
    await vault.putJson("profile", "profile:peer", peer);
    expect(await loadDisplayAvatar(vault, "peer")).toEqual(peer.avatar);
    await vault.putJson("profile", "profile:peer", { ...peer, avatar: null });
    expect(await loadDisplayAvatar(vault, "peer")).toBeNull();
    await expect(loadDisplayAvatar(vault, "missing-peer")).resolves.toBeNull();
    vault.lock(); await expect(loadDisplayAvatar(vault)).rejects.toThrow();
  });
});

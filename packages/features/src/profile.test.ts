import { describe, expect, it } from "vitest";
import type { Settings } from "@veil/core";
import { SubtleCryptoPort } from "@veil/crypto";
import { encodeBase64 } from "@veil/core";
import { createVault, type UnlockedVault } from "@veil/vault";
import { MemoryStore } from "../../vault/src/memory-store";
import { applyProfile, defaultProfile, getProfile, parseSignedProfile, saveOwnProfile, signProfile, verifySignedProfile } from "./profile";
import { buildShareBundle, importShareBundle } from "./sharing";
import { defaultSettings, listConnections, saveSettings } from "./social";
import { buildFeedSnapshot } from "./feed";
import { syncConnection, type SyncFetcher } from "./sync";

const NOW = new Date("2026-10-30T12:00:00Z");
const open = () => createVault({ store: new MemoryStore(), crypto: new SubtleCryptoPort(), now: () => NOW }, "pass phrase 1");
const settingsFor = (authorId: string, handle: string): Settings => ({ ...defaultSettings(), authorId, handle });
let counter = 0;
const deps = { newId: () => `m${counter++}`, now: () => NOW };

const big = (kb: number): string => encodeBase64(new Uint8Array(kb * 1024));

async function pairedVaults(): Promise<{ alice: UnlockedVault; bob: UnlockedVault }> {
  const alice = await open();
  const bob = await open();
  await saveSettings(alice, settingsFor("alice-id", "alice"));
  await saveSettings(bob, settingsFor("bob-id", "bob"));
  await importShareBundle(bob, (await buildShareBundle(alice, settingsFor("alice-id", "alice"), [], NOW)).text, { settings: settingsFor("bob-id", "bob"), newId: deps.newId, now: NOW });
  await importShareBundle(alice, (await buildShareBundle(bob, settingsFor("bob-id", "bob"), [], NOW)).text, { settings: settingsFor("alice-id", "alice"), newId: deps.newId, now: NOW });
  return { alice, bob };
}

describe("eic-profile v1", () => {
  it("creates with seq 1 and bumps seq on every edit, enforcing the caps", async () => {
    const alice = (await pairedVaults()).alice;
    const first = await saveOwnProfile(alice, { ...defaultProfile("alice-id", "alice", NOW), bio: "hi" }, NOW);
    expect(first.seq).toBe(1);
    const second = await saveOwnProfile(alice, { ...first, bio: "updated" }, new Date(NOW.getTime() + 1000));
    expect(second.seq).toBe(2);
    expect(second.bio).toBe("updated");

    await expect(saveOwnProfile(alice, { ...second, avatar: { kind: "data-uri", mime: "image/png", data: big(30) } }, NOW)).rejects.toThrow("25 KB");
    await expect(
      saveOwnProfile(
        alice,
        {
          ...second,
          decorations: Array.from({ length: 33 }, (_, i) => ({
            id: `d${i}`,
            kind: "sticker",
            asset: { kind: "inline-svg" as const, data: "<svg/>" },
            position: { x: 0, y: 0, z: 0 },
            scale: 1,
            rotation: 0,
          })),
        },
        NOW,
      ),
    ).rejects.toThrow();
  });

  it("sign/verify round-trips and fails closed on the wrong key or a tampered profile", async () => {
    const { alice, bob } = await pairedVaults();
    const profile = await saveOwnProfile(alice, defaultProfile("alice-id", "alice", NOW), NOW);
    const signed = await signProfile(alice, profile);
    const bobConn = (await listConnections(bob)).find((c) => c.id === "alice-id")!;
    await verifySignedProfile(signed, "alice-id", bobConn.pubkey!);

    await expect(verifySignedProfile(signed, "alice-id", encodeBase64(new Uint8Array(32)))).rejects.toThrow();
    const tampered = { ...signed, profile: { ...signed.profile, bio: "forged" } };
    await expect(verifySignedProfile(tampered, "alice-id", bobConn.pubkey!)).rejects.toThrow("signature");
  });

  it("applies LWW by (authorId, seq) and never overwrites my own profile from a pull", async () => {
    const { alice, bob } = await pairedVaults();
    const v1 = await saveOwnProfile(alice, defaultProfile("alice-id", "alice", NOW), NOW);
    expect((await applyProfile(bob, v1)).applied).toBe(true);
    expect((await applyProfile(bob, v1)).applied).toBe(false); // idempotent
    const v2 = await saveOwnProfile(alice, { ...v1, decorations: [] }, new Date(NOW.getTime() + 1000));
    expect((await applyProfile(bob, v2)).applied).toBe(true);
    expect((await applyProfile(bob, v1)).applied).toBe(false); // stale seq
    // Own profile is never clobbered by an incoming record with my authorId.
    const mine = await saveOwnProfile(bob, defaultProfile("bob-id", "bob", NOW), NOW);
    const forged = { ...mine, bio: "not me", seq: mine.seq + 5 };
    expect((await applyProfile(bob, forged)).applied).toBe(false);
    expect((await getProfile(bob, "bob-id"))!.bio).toBe(mine.bio);
  });

  it("rides the feed: publish includes a signed profile chunk, pull applies it, tamper fails closed", async () => {
    const { alice, bob } = await pairedVaults();
    await saveSettings(alice, { ...settingsFor("alice-id", "alice"), feedUrl: "https://feeds.example/alice" });
    const profile = await saveOwnProfile(alice, defaultProfile("alice-id", "alice", NOW), NOW);
    const snapshot = await buildFeedSnapshot(alice, { ...settingsFor("alice-id", "alice"), feedUrl: "https://feeds.example/alice" }, [], { now: NOW, seq: 1 });
    const profileFile = snapshot.files.find((f) => f.path === "chunks/profile.json")!;
    expect(profileFile).toBeTruthy();
    expect(parseSignedProfile(profileFile.text).profile.seq).toBe(profile.seq);

    const requests: string[] = [];
    const byUrl = new Map(snapshot.files.map((f) => [`https://feeds.example/alice/${f.path}`, f.text]));
    const goodHost: SyncFetcher = async (url) => {
      requests.push(url);
      const text = byUrl.get(url);
      return text === undefined ? { status: 404, etag: null, text: null } : { status: 200, etag: "e1", text };
    };
    const conn = { ...(await listConnections(bob)).find((c) => c.id === "alice-id")!, feedUrl: "https://feeds.example/alice" };
    const result = await syncConnection(bob, conn, { fetch: goodHost, network: "wifi", newId: deps.newId, now: NOW });
    expect(result.appliedProfile).toBe(true);
    expect((await getProfile(bob, "alice-id"))!.displayName).toBe("alice");

    // A tampered profile chunk (hash no longer matches the signed manifest) fails closed.
    const badHost: SyncFetcher = async (url) =>
      url.endsWith("chunks/profile.json") ? { status: 200, etag: null, text: profileFile.text.replace("alice", "eve  ") } : goodHost.fetch(url, null);
    const bob2 = (await pairedVaults()).bob;
    await saveSettings(bob2, { ...settingsFor("bob-id", "bob"), feedUrl: null });
    const conn2 = { ...(await listConnections(bob2)).find((c) => c.id === "alice-id")!, feedUrl: "https://feeds.example/alice" };
    await expect(syncConnection(bob2, conn2, { fetch: badHost, network: "wifi", newId: deps.newId, now: NOW })).rejects.toThrow();
  });
});

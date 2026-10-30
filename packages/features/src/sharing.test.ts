import { describe, expect, it, vi } from "vitest";
import { VaultCorruptError, type Item, type Settings } from "@veil/core";
import { SubtleCryptoPort } from "@veil/crypto";
import { createVault, type UnlockedVault } from "@veil/vault";
import { MemoryStore } from "../../vault/src/memory-store";
import { getSampleItems } from "./demo-items";
import { buildShareBundle, importShareBundle, parseShareBundle, MAX_SHARE_FILE_BYTES } from "./sharing";
import { defaultSettings, listConnections, listNotes, saveSettings, loadSettings, toggleLike } from "./social";

const NOW = new Date("2026-10-29T12:00:00Z");
const open = () => createVault({ store: new MemoryStore(), crypto: new SubtleCryptoPort(), now: () => NOW }, "pass phrase 1");
const settingsFor = (authorId: string, handle: string): Settings => ({ ...defaultSettings(), authorId, handle });
let counter = 0;
const newId = () => `note${counter++}`;

async function postWithPhoto(vault: UnlockedVault, id: string, visibility: Item["visibility"]): Promise<Item> {
  const media = await vault.sealRecord("media", new Uint8Array([1, 2, 3, 4]));
  const thumb = await vault.sealRecord("thumb", new Uint8Array([9, 9]));
  const item: Item = {
    ...getSampleItems(NOW)[0]!,
    id,
    visibility,
    mediaIds: [media.id],
    thumbId: thumb.id,
  };
  await vault.putRecords([media, thumb, await vault.sealItem(item)]);
  return item;
}

describe("share files", () => {
  it("exports only my shareable posts", async () => {
    const vault = await open();
    await postWithPhoto(vault, "public-one", "shareable");
    await postWithPhoto(vault, "secret-one", "private");
    const items = await vault.listItems();

    const bundle = parseShareBundle((await buildShareBundle(vault, settingsFor("alice-id", "alice"), items, NOW)).text);

    expect(bundle.posts.map((post) => post.id)).toEqual(["public-one"]);
    expect(bundle.posts[0]!.media).toHaveLength(1);
  });

  it("refuses to export without a handle", async () => {
    const vault = await open();
    await expect(buildShareBundle(vault, defaultSettings(), [], NOW)).rejects.toThrow("handle");
  });

  it("imports posts and photos, records a connection, and a note", async () => {
    const alice = await open();
    await postWithPhoto(alice, "p1", "shareable");
    const { text: file } = await buildShareBundle(alice, settingsFor("alice-id", "alice"), await alice.listItems(), NOW);

    const bob = await open();
    const result = await importShareBundle(bob, file, { settings: settingsFor("bob-id", "bob"), newId, now: NOW });

    expect(result).toMatchObject({ handle: "alice", added: 1, updated: 0 });
    const imported = await bob.getItem("alice-id:p1");
    expect(imported).toMatchObject({ authorId: "alice-id", authorHandle: "alice", visibility: "private" });
    expect(await bob.getRecord(imported!.mediaIds[0]!)).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect((await listConnections(bob)).map((c) => c.handle)).toEqual(["alice"]);
    expect((await listNotes(bob))[0]!.text).toContain("@alice");
  });

  it("does not duplicate photos or re-share imported posts when imported twice", async () => {
    const alice = await open();
    await postWithPhoto(alice, "p1", "shareable");
    const { text: file } = await buildShareBundle(alice, settingsFor("alice-id", "alice"), await alice.listItems(), NOW);
    const bob = await open();
    const deps = { settings: settingsFor("bob-id", "bob"), newId, now: NOW };

    await importShareBundle(bob, file, deps);
    const again = await importShareBundle(bob, file, deps);

    expect(again).toMatchObject({ added: 0, updated: 1 });
    const imported = await bob.getItem("alice-id:p1");
    expect(imported!.mediaIds).toHaveLength(1);
    const bobFile = parseShareBundle((await buildShareBundle(bob, settingsFor("bob-id", "bob"), await bob.listItems(), NOW)).text);
    expect(bobFile.posts).toHaveLength(0);
  });

  it("carries likes back to the post owner exactly once", async () => {
    const alice = await open();
    await postWithPhoto(alice, "p1", "shareable");
    const aliceSettings = settingsFor("alice-id", "alice");
    const bob = await open();
    const bobSettings = settingsFor("bob-id", "bob");
    await importShareBundle(
      bob,
      (await buildShareBundle(alice, aliceSettings, await alice.listItems(), NOW)).text,
      { settings: bobSettings, newId, now: NOW },
    );
    const copy = (await bob.getItem("alice-id:p1"))!;
    await bob.putItem({ ...copy, likedByMe: true });
    const { text: bobFile } = await buildShareBundle(bob, bobSettings, await bob.listItems(), NOW);

    const first = await importShareBundle(alice, bobFile, { settings: aliceSettings, newId, now: NOW });
    const second = await importShareBundle(alice, bobFile, { settings: aliceSettings, newId, now: NOW });

    expect(first.likesReceived).toBe(1);
    expect(second.likesReceived).toBe(0);
    const liked = (await alice.getItem("p1"))!;
    expect(liked.likes).toBe(1);
    expect(liked.likedBy).toEqual(["bob-id"]);
  });

  it("rejects my own file, junk, and unsafe ids", async () => {
    const alice = await open();
    const settings = settingsFor("alice-id", "alice");
    const { text: file } = await buildShareBundle(alice, settings, [], NOW);
    await expect(importShareBundle(alice, file, { settings, newId, now: NOW })).rejects.toThrow("your own");
    expect(() => parseShareBundle("not json")).toThrow(VaultCorruptError);
    const evil = JSON.parse(file);
    evil.author.id = "a:b/../c";
    expect(() => parseShareBundle(JSON.stringify(evil))).toThrow(VaultCorruptError);
  });
});


describe("share regression cases", () => {
  it("namespaces connections without changing settings, item, media, or note records", async () => {
    const vault = await open();
    const settings = settingsFor("bob", "bob");
    await saveSettings(vault, settings);
    const item = await postWithPhoto(vault, "existing-item", "private");
    // Keep the own-post count consistent with its membership.
    await vault.putItem({ ...item, likes: 0 });
    await vault.putJson("note", "existing-note", { text: "keep me" });
    const ids = ["settings", item.id, item.mediaIds[0]!, "existing-note"];
    const before = await Promise.all(ids.map((id) => vault.getRecord(id)));
    for (const id of ids) {
      const { text } = await buildShareBundle(vault, settingsFor(id, "alice"), [], NOW);
      await importShareBundle(vault, text, { settings, newId, now: NOW });
      expect(await vault.getJson(`connection:${id}`)).toMatchObject({ id, handle: "alice" });
    }
    expect(await Promise.all(ids.map((id) => vault.getRecord(id)))).toEqual(before);
    expect(await loadSettings(vault)).toEqual(settings);
    expect((await listConnections(vault)).map((c) => c.id).sort()).toEqual([...ids].sort());
  });

  it("round-trips Alice/Bob likes without double counting and propagates unlikes", async () => {
    const alice = await open();
    const bob = await open();
    const aliceSettings = settingsFor("alice", "alice");
    const bobSettings = settingsFor("bob", "bob");
    const original = await postWithPhoto(alice, "p1", "shareable");
    await alice.putItem({ ...original, likes: 1, likedByMe: true });
    const send = async (from: UnlockedVault, to: UnlockedVault, sender: Settings, receiver: Settings) => {
      const { text } = await buildShareBundle(from, sender, await from.listItems(), NOW);
      return importShareBundle(to, text, { settings: receiver, newId, now: NOW });
    };
    await send(alice, bob, aliceSettings, bobSettings);
    await toggleLike(bob, (await bob.getItem("alice:p1"))!);
    expect((await send(bob, alice, bobSettings, aliceSettings)).likesReceived).toBe(1);
    expect(await alice.getItem("p1")).toMatchObject({ likes: 2, likedBy: ["bob"], likedByMe: true });
    await send(alice, bob, aliceSettings, bobSettings);
    await send(alice, bob, aliceSettings, bobSettings);
    expect(await bob.getItem("alice:p1")).toMatchObject({ likes: 2, likedByMe: true });
    await toggleLike(bob, (await bob.getItem("alice:p1"))!);
    await send(bob, alice, bobSettings, aliceSettings);
    await send(bob, alice, bobSettings, aliceSettings);
    expect(await alice.getItem("p1")).toMatchObject({ likes: 1, likedBy: [], likedByMe: true });
    await send(alice, bob, aliceSettings, bobSettings);
    expect(await bob.getItem("alice:p1")).toMatchObject({ likes: 1, likedByMe: false });
  });

  it("uses the author's reported count even before a local like is acknowledged", async () => {
    const vault = await open();
    const settings = settingsFor("bob", "bob");
    const post = { ...getSampleItems(NOW)[0]!, id: "alice:p1", authorId: "alice", authorHandle: "alice", likedByMe: true, likes: 5 };
    await vault.putItem(post);
    const { text } = await buildShareBundle(vault, settingsFor("alice", "alice"), [
      { ...post, id: "p1", authorId: null, visibility: "shareable", likes: 4 },
    ], NOW);
    await importShareBundle(vault, text, { settings, newId, now: NOW });
    expect(await vault.getItem("alice:p1")).toMatchObject({ likes: 4, likedByMe: true });
  });

  it("caps exports at 100 posts and 1000 likes and reports the real post count", async () => {
    const vault = await open();
    const base = getSampleItems(NOW)[0]!;
    const posts = Array.from({ length: 101 }, (_, i) => ({ ...base, id: `p${i}`, visibility: "shareable" as const }));
    const likes = Array.from({ length: 1001 }, (_, i) => ({ ...base, id: `alice:p${i}`, authorId: "alice", likedByMe: true }));
    const result = await buildShareBundle(vault, settingsFor("bob", "bob"), [...posts, ...likes], NOW);
    const bundle = parseShareBundle(result.text);
    expect(result.postCount).toBe(100);
    expect(bundle.posts).toHaveLength(100);
    expect(bundle.likes).toHaveLength(1000);
    expect(new TextEncoder().encode(result.text).byteLength).toBeLessThan(MAX_SHARE_FILE_BYTES);
  });

  it("refuses an aggregate export too large to import", async () => {
    const vault = await open();
    // Each individual photo is legal; their base64 aggregate exceeds the file limit.
    vi.spyOn(vault, "getRecord").mockResolvedValue(new Uint8Array(5 * 1024 * 1024));
    const post = { ...getSampleItems(NOW)[0]!, visibility: "shareable" as const, mediaIds: ["a", "b", "c", "d"] };
    await expect(buildShareBundle(vault, settingsFor("alice", "alice"), [post], NOW)).rejects.toThrow("Make fewer posts shareable");
  }, 20000);

  it("rejects duplicate post ids before sealing or writing anything", async () => {
    const vault = await open();
    const post = { ...getSampleItems(NOW)[0]!, visibility: "shareable" as const };
    const { text } = await buildShareBundle(vault, settingsFor("alice", "alice"), [post], NOW);
    const bundle = JSON.parse(text);
    bundle.posts.push(bundle.posts[0]);
    const duplicate = JSON.stringify(bundle);
    expect(() => parseShareBundle(duplicate)).toThrow(VaultCorruptError);
    const seal = vi.spyOn(vault, "sealItem");
    const sealMedia = vi.spyOn(vault, "sealRecord");
    const write = vi.spyOn(vault, "putRecords");
    const writeJson = vi.spyOn(vault, "putJson");
    await expect(importShareBundle(vault, duplicate, { settings: settingsFor("bob", "bob"), newId, now: NOW })).rejects.toThrow(VaultCorruptError);
    for (const spy of [seal, sealMedia, write, writeJson]) expect(spy).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from "vitest";
import { AppError, ItemSchema, VaultCorruptError, type Item, type Settings } from "@veil/core";
import { SubtleCryptoPort } from "@veil/crypto";
import { createVault, newRecordId, type UnlockedVault } from "@veil/vault";
import { MemoryStore } from "../../vault/src/memory-store";
import { getSampleItems } from "./demo-items";
import { buildShareBundle, importShareBundle, parseShareBundle, MAX_SHARE_FILE_BYTES } from "./sharing";
import { addNote, defaultSettings, listConnections, listNotes, saveSettings, loadSettings, toggleLike } from "./social";

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
    const imported = await bob.getItem("post:alice-id:p1");
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
    const imported = await bob.getItem("post:alice-id:p1");
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
    const copy = (await bob.getItem("post:alice-id:p1"))!;
    await bob.putItem({ ...copy, likedByMe: true });
    const { text: bobFile } = await buildShareBundle(bob, bobSettings, await bob.listItems(), NOW);

    const first = await importShareBundle(alice, bobFile, { settings: aliceSettings, newId, now: NOW });
    const second = await importShareBundle(alice, bobFile, { settings: aliceSettings, newId, now: NOW });

    expect(first.likesReceived).toBe(1);
    expect(second.likesReceived).toBe(0);
    const liked = (await alice.getItem("p1"))!;
    expect(liked.likes).toBe(24);
    expect(liked.likedBy).toEqual(["bob-id"]);
  });

  it("a single-post share does not strip the sender's likes on my posts", async () => {
    const alice = await open();
    const bob = await open();
    const aliceSettings = settingsFor("alice", "alice");
    const bobSettings = settingsFor("bob", "bob");
    await postWithPhoto(bob, "b1", "shareable");
    await postWithPhoto(alice, "a1", "private");
    const send = async (from: UnlockedVault, to: UnlockedVault, sender: Settings, receiver: Settings) => {
      const { text } = await buildShareBundle(from, sender, await from.listItems(), NOW);
      return importShareBundle(to, text, { settings: receiver, newId, now: NOW });
    };
    // Round trip: bob's b1 lands with alice, alice likes it, full share carries the like home.
    await send(bob, alice, bobSettings, aliceSettings);
    await toggleLike(alice, (await alice.getItem("post:bob:b1"))!);
    await send(alice, bob, aliceSettings, bobSettings);
    const before = (await bob.getItem("b1"))!;
    expect(before.likedBy).toEqual(["alice"]);

    // Alice shares ONE post on its own: that file is not her like snapshot...
    const singleText = (await buildShareBundle(alice, aliceSettings, await alice.listItems(), NOW, { onlyPostId: "a1" })).text;
    expect(parseShareBundle(singleText).likesComplete).toBe(false);
    const result = await importShareBundle(bob, singleText, { settings: bobSettings, newId, now: NOW });

    // ...so importing it adds the post but must not reconcile (which would erase alice's like on b1).
    expect(result).toMatchObject({ added: 1, likesReceived: 0 });
    expect(await bob.getItem("b1")).toMatchObject({ likes: before.likes, likedBy: ["alice"] });
    // Full exports still declare a complete snapshot.
    expect(parseShareBundle((await buildShareBundle(alice, aliceSettings, await alice.listItems(), NOW)).text).likesComplete).toBe(true);
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
  it("keeps own item, media, thumbnail, and note ids random and colon-free", async () => {
    const vault = await open();
    const crypto = new SubtleCryptoPort();
    const randomId = () => newRecordId(crypto);
    const item = await postWithPhoto(vault, randomId(), "private");
    const note = await addNote(vault, "A private note", { newId: randomId, now: NOW });
    for (const id of [item.id, ...item.mediaIds, item.thumbId!, note.id]) {
      expect(id).toMatch(/^[a-z2-7]{26}$/);
      expect(id).not.toContain(":");
    }
  });

  it("namespaces connections without changing settings, item, media, or note records", async () => {
    const vault = await open();
    const settings = settingsFor("bob", "bob");
    await saveSettings(vault, settings);
    const item = await postWithPhoto(vault, "existing-item", "private");
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
    await toggleLike(bob, (await bob.getItem("post:alice:p1"))!);
    expect((await send(bob, alice, bobSettings, aliceSettings)).likesReceived).toBe(1);
    expect(await alice.getItem("p1")).toMatchObject({ likes: 2, likedBy: ["bob"], likedByMe: true });
    await send(alice, bob, aliceSettings, bobSettings);
    await send(alice, bob, aliceSettings, bobSettings);
    expect(await bob.getItem("post:alice:p1")).toMatchObject({ likes: 2, likedByMe: true });
    await toggleLike(bob, (await bob.getItem("post:alice:p1"))!);
    await send(bob, alice, bobSettings, aliceSettings);
    await send(bob, alice, bobSettings, aliceSettings);
    expect(await alice.getItem("p1")).toMatchObject({ likes: 1, likedBy: [], likedByMe: true });
    await send(alice, bob, aliceSettings, bobSettings);
    expect(await bob.getItem("post:alice:p1")).toMatchObject({ likes: 1, likedByMe: false });
  });

  it("preserves pending likes before sending and acknowledges the round trip", async () => {
    const owner = await open();
    const reader = await open();
    const ownerSettings = settingsFor("alice", "alice");
    const readerSettings = settingsFor("bob", "bob");
    const original = await postWithPhoto(owner, "p1", "shareable");
    await owner.putItem({ ...original, likes: 4 });
    const send = async (from: UnlockedVault, to: UnlockedVault, sender: Settings, receiver: Settings) => {
      const { text } = await buildShareBundle(from, sender, await from.listItems(), NOW);
      return importShareBundle(to, text, { settings: receiver, newId, now: NOW });
    };
    const copy = async () => (await reader.listItems()).find((item) => item.authorId === "alice");
    await send(owner, reader, ownerSettings, readerSettings);
    expect((await copy())!.likes).toBe(4);
    await toggleLike(reader, (await copy())!);
    expect((await copy())!.likes).toBe(5);
    await send(owner, reader, ownerSettings, readerSettings);
    expect((await copy())!.likes).toBe(5);
    await toggleLike(reader, (await copy())!);
    expect((await copy())!.likes).toBe(4);
    await send(owner, reader, ownerSettings, readerSettings);
    expect((await copy())!.likes).toBe(4);
    await toggleLike(reader, (await copy())!);
    await send(reader, owner, readerSettings, ownerSettings);
    expect(await owner.getItem("p1")).toMatchObject({ likes: 5, likedBy: ["bob"] });
    const acknowledged = parseShareBundle((await buildShareBundle(owner, ownerSettings, await owner.listItems(), NOW)).text);
    expect(acknowledged.posts[0]!.likedBy).toEqual(["bob"]);
    await send(owner, reader, ownerSettings, readerSettings);
    await send(owner, reader, ownerSettings, readerSettings);
    expect(await copy()).toMatchObject({ likes: 5, likedByMe: true });
    await toggleLike(reader, (await copy())!);
    expect((await copy())!.likes).toBe(4);
    // The owner has not received the unlike: re-import the exact acknowledged file.
    const acknowledgedFile = JSON.stringify(acknowledged);
    await importShareBundle(reader, acknowledgedFile, { settings: readerSettings, newId, now: NOW });
    expect(await copy()).toMatchObject({ likes: 4, likedByMe: false });
    await toggleLike(reader, (await copy())!);
    expect(await copy()).toMatchObject({ likes: 5, likedByMe: true });
    await send(reader, owner, readerSettings, ownerSettings);
    await send(owner, reader, ownerSettings, readerSettings);
    expect(await owner.getItem("p1")).toMatchObject({ likes: 5, likedBy: ["bob"] });
    expect(await copy()).toMatchObject({ likes: 5, likedByMe: true });
    await toggleLike(reader, (await copy())!);
    await importShareBundle(reader, acknowledgedFile, { settings: readerSettings, newId, now: NOW });
    expect(await copy()).toMatchObject({ likes: 4, likedByMe: false });
    await send(reader, owner, readerSettings, ownerSettings);
    await send(owner, reader, ownerSettings, readerSettings);
    expect(await copy()).toMatchObject({ likes: 4, likedByMe: false });
    expect(await owner.getItem("p1")).toMatchObject({ likes: 4, likedBy: [] });
  });

  it("floors an imported pending unlike at zero", async () => {
    const vault = await open();
    const post = { ...getSampleItems(NOW)[0]!, id: "p1", visibility: "shareable" as const, likes: 0, likedBy: ["bob"] };
    const { text } = await buildShareBundle(vault, settingsFor("alice", "alice"), [post], NOW);
    await importShareBundle(vault, text, { settings: settingsFor("bob", "bob"), newId, now: NOW });
    expect(await vault.getItem("post:alice:p1")).toMatchObject({ likes: 0, likedByMe: false });
  });

  it("imports version-1 posts without likedBy as having no acknowledged likes", async () => {
    const vault = await open();
    const post = { ...getSampleItems(NOW)[0]!, id: "p1", visibility: "shareable" as const, likes: 4 };
    const bundle = JSON.parse((await buildShareBundle(vault, settingsFor("alice", "alice"), [post], NOW)).text);
    delete bundle.posts[0].likedBy;
    const text = JSON.stringify(bundle);
    expect(parseShareBundle(text).posts[0]!.likedBy).toEqual([]);
    const deps = { settings: settingsFor("bob", "bob"), newId, now: NOW };
    await importShareBundle(vault, text, deps);
    expect(await vault.getItem("post:alice:p1")).toMatchObject({ likes: 4, likedByMe: false });
    await toggleLike(vault, (await vault.getItem("post:alice:p1"))!);
    await importShareBundle(vault, text, deps);
    expect(await vault.getItem("post:alice:p1")).toMatchObject({ likes: 5, likedByMe: true });
  });

  it("exports likes only from ids namespaced for the item's author", async () => {
    const vault = await open();
    const base = { ...getSampleItems(NOW)[0]!, authorId: "alice", likedByMe: true };
    const items = ["post:alice:p1", "alice:p2", "p3", "post:other:p4", "junk:alice:p5", "post:alice:"].map((id) => ({ ...base, id }));
    const { text } = await buildShareBundle(vault, settingsFor("bob", "bob"), items, NOW);
    expect(JSON.parse(text).likes).toEqual([{ ownerId: "alice", postId: "p1" }]);
    expect(parseShareBundle(text).likes).toEqual([{ ownerId: "alice", postId: "p1" }]);
  });

  it("exports up to 5000 likes without truncation and keeps the 100-post cap", async () => {
    const vault = await open();
    const base = getSampleItems(NOW)[0]!;
    const posts = Array.from({ length: 101 }, (_, i) => ({ ...base, id: `p${i}`, visibility: "shareable" as const }));
    const likes = Array.from({ length: 5000 }, (_, i) => ({ ...base, id: `post:alice:p${i}`, authorId: "alice", likedByMe: true }));
    const result = await buildShareBundle(vault, settingsFor("bob", "bob"), [...posts, ...likes], NOW);
    const bundle = parseShareBundle(result.text);
    expect(result.postCount).toBe(100);
    expect(bundle.posts).toHaveLength(100);
    expect(bundle.likes).toHaveLength(5000);
    expect(bundle.likes[4999]).toEqual({ ownerId: "alice", postId: "p4999" });
    const overflow = { ...likes[0]!, id: "post:alice:overflow" };
    await expect(buildShareBundle(vault, settingsFor("bob", "bob"), [...likes, overflow], NOW)).rejects.toBeInstanceOf(AppError);
    expect(() => parseShareBundle(JSON.stringify({ ...bundle, likes: [...bundle.likes, { ownerId: "alice", postId: "overflow" }] }))).toThrow(VaultCorruptError);
  });

  it("throws AppError rather than silently dropping likes above the limit", async () => {
    const vault = await open();
    const likes = Array.from({ length: 5001 }, (_, i) => ({
      ...getSampleItems(NOW)[0]!, id: `post:alice:p${i}`, authorId: "alice", likedByMe: true,
    }));
    await expect(buildShareBundle(vault, settingsFor("bob", "bob"), likes, NOW)).rejects.toBeInstanceOf(AppError);
  });

  it("keeps connections and settings intact for reserved-looking author and post ids", async () => {
    const vault = await open();
    const settings = settingsFor("bob", "bob");
    await saveSettings(vault, settings);
    const send = async (authorId: string, postId?: string) => {
      const posts = postId ? [{ ...getSampleItems(NOW)[0]!, id: postId, visibility: "shareable" as const }] : [];
      const { text } = await buildShareBundle(vault, settingsFor(authorId, authorId), posts, NOW);
      return importShareBundle(vault, text, { settings, newId, now: NOW });
    };
    await send("alice");
    const connectionBefore = await vault.getRecord("connection:alice");
    const settingsBefore = await vault.getRecord("settings");
    await send("connection", "alice");
    expect(await vault.getRecord("connection:alice")).toEqual(connectionBefore);
    expect(await vault.getItem("post:connection:alice")).toMatchObject({ authorId: "connection" });
    await send("settings", "settings");
    expect(await vault.getRecord("settings")).toEqual(settingsBefore);
    expect(await loadSettings(vault)).toEqual(settings);
    expect((await listConnections(vault)).map((c) => c.id).sort()).toEqual(["alice", "connection", "settings"]);
  });

  it("leaves unrelated counts intact and only applies membership deltas, floored at zero", async () => {
    const vault = await open();
    const settings = settingsFor("bob", "bob");
    const post = await postWithPhoto(vault, "p1", "shareable");
    expect(post).toMatchObject({ likes: 23, likedBy: [] });
    const send = async (likes: { ownerId: string; postId: string }[]) => {
      const bundle = JSON.parse((await buildShareBundle(vault, settingsFor("alice", "alice"), [], NOW)).text);
      bundle.likes = likes;
      return importShareBundle(vault, JSON.stringify(bundle), { settings, newId, now: NOW });
    };
    const before = await vault.getRecord(post.id);
    await send([]);
    expect(await vault.getRecord(post.id)).toEqual(before);
    expect((await vault.getItem(post.id))!.likes).toBe(23);
    await send([{ ownerId: "bob", postId: post.id }]);
    await send([{ ownerId: "bob", postId: post.id }]);
    expect(await vault.getItem(post.id)).toMatchObject({ likes: 24, likedBy: ["alice"] });
    await send([]);
    await send([]);
    expect(await vault.getItem(post.id)).toMatchObject({ likes: 23, likedBy: [] });
    await vault.putItem({ ...post, likes: 0, likedBy: ["alice"] });
    await send([]);
    expect(await vault.getItem(post.id)).toMatchObject({ likes: 0, likedBy: [] });
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

describe("sharing one post", () => {
  it("exports just that post, even when it is private, with no likes", async () => {
    const vault = await open();
    await postWithPhoto(vault, "secret-one", "private");
    await postWithPhoto(vault, "other", "shareable");
    const items = await vault.listItems();

    const { text, postCount } = await buildShareBundle(vault, settingsFor("alice-id", "alice"), items, NOW, { onlyPostId: "secret-one" });
    const bundle = parseShareBundle(text);

    expect(postCount).toBe(1);
    expect(bundle.posts.map((post) => post.id)).toEqual(["secret-one"]);
    expect(bundle.likes).toEqual([]);
  });

  it("refuses to share an imported post", async () => {
    const vault = await open();
    await expect(buildShareBundle(vault, settingsFor("alice-id", "alice"), [], NOW, { onlyPostId: "post:bob:x" })).rejects.toBeInstanceOf(AppError);
  });

  it("still reads share files and items that use the removed moments and free categories", () => {
    const legacy = { ...getSampleItems(NOW)[0]!, category: "moments" };
    expect(ItemSchema.parse(legacy).category).toBe("general");
    expect(ItemSchema.parse({ ...legacy, category: "free" }).category).toBe("general");
  });
});

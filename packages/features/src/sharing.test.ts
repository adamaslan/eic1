import { describe, expect, it } from "vitest";
import { VaultCorruptError, type Item, type Settings } from "@veil/core";
import { SubtleCryptoPort } from "@veil/crypto";
import { createVault, type UnlockedVault } from "@veil/vault";
import { MemoryStore } from "../../vault/src/memory-store";
import { getSampleItems } from "./demo-items";
import { buildShareBundle, importShareBundle, parseShareBundle } from "./sharing";
import { defaultSettings, listConnections, listNotes } from "./social";

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

    const bundle = parseShareBundle(await buildShareBundle(vault, settingsFor("alice-id", "alice"), items, NOW));

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
    const file = await buildShareBundle(alice, settingsFor("alice-id", "alice"), await alice.listItems(), NOW);

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
    const file = await buildShareBundle(alice, settingsFor("alice-id", "alice"), await alice.listItems(), NOW);
    const bob = await open();
    const deps = { settings: settingsFor("bob-id", "bob"), newId, now: NOW };

    await importShareBundle(bob, file, deps);
    const again = await importShareBundle(bob, file, deps);

    expect(again).toMatchObject({ added: 0, updated: 1 });
    const imported = await bob.getItem("alice-id:p1");
    expect(imported!.mediaIds).toHaveLength(1);
    const bobFile = parseShareBundle(await buildShareBundle(bob, settingsFor("bob-id", "bob"), await bob.listItems(), NOW));
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
      await buildShareBundle(alice, aliceSettings, await alice.listItems(), NOW),
      { settings: bobSettings, newId, now: NOW },
    );
    const copy = (await bob.getItem("alice-id:p1"))!;
    await bob.putItem({ ...copy, likedByMe: true });
    const bobFile = await buildShareBundle(bob, bobSettings, await bob.listItems(), NOW);
    const before = (await alice.getItem("p1"))!.likes;

    const first = await importShareBundle(alice, bobFile, { settings: aliceSettings, newId, now: NOW });
    const second = await importShareBundle(alice, bobFile, { settings: aliceSettings, newId, now: NOW });

    expect(first.likesReceived).toBe(1);
    expect(second.likesReceived).toBe(0);
    const liked = (await alice.getItem("p1"))!;
    expect(liked.likes).toBe(before + 1);
    expect(liked.likedBy).toEqual(["bob-id"]);
  });

  it("rejects my own file, junk, and unsafe ids", async () => {
    const alice = await open();
    const settings = settingsFor("alice-id", "alice");
    const file = await buildShareBundle(alice, settings, [], NOW);
    await expect(importShareBundle(alice, file, { settings, newId, now: NOW })).rejects.toThrow("your own");
    expect(() => parseShareBundle("not json")).toThrow(VaultCorruptError);
    const evil = JSON.parse(file);
    evil.author.id = "a:b/../c";
    expect(() => parseShareBundle(JSON.stringify(evil))).toThrow(VaultCorruptError);
  });
});

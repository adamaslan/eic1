import { describe, expect, it } from "vitest";
import type { Item, Settings } from "@veil/core";
import { SubtleCryptoPort } from "@veil/crypto";
import { createVault, type UnlockedVault } from "@veil/vault";
import { MemoryStore } from "../../vault/src/memory-store";
import { getSampleItems } from "./demo-items";
import { buildShareBundle, importShareBundle } from "./sharing";
import {
  defaultSettings,
  listConnections,
  removeConnection,
  setConnectionHidden,
  setConnectionNickname,
  summarizeConnections,
} from "./social";

const NOW = new Date("2026-10-29T12:00:00Z");
const LATER = new Date("2026-10-30T09:00:00Z");
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

/** Alice exports a share file; Bob imports it. Returns Bob's vault. */
async function bobWithConnection(): Promise<{ bob: UnlockedVault; alice: UnlockedVault }> {
  const alice = await open();
  await postWithPhoto(alice, "p1", "shareable");
  const { text } = await buildShareBundle(alice, settingsFor("alice-id", "alice"), await alice.listItems(), NOW);
  const bob = await open();
  await importShareBundle(bob, text, { settings: settingsFor("bob-id", "bob"), newId, now: NOW });
  return { bob, alice };
}

describe("connection management", () => {
  it("sets and clears a local nickname", async () => {
    const { bob } = await bobWithConnection();
    const renamed = await setConnectionNickname(bob, "alice-id", "Alice W");
    expect(renamed.nickname).toBe("Alice W");
    expect((await listConnections(bob))[0]!.nickname).toBe("Alice W");

    const cleared = await setConnectionNickname(bob, "alice-id", "  ");
    expect(cleared.nickname).toBeNull();

    await expect(setConnectionNickname(bob, "nobody", "x")).rejects.toThrow("does not exist");
  });

  it("hides and unhides a connection without touching posts", async () => {
    const { bob } = await bobWithConnection();
    await setConnectionHidden(bob, "alice-id", true);
    const [connection] = await listConnections(bob);
    expect(connection!.hidden).toBe(true);
    expect(await bob.getItem("post:alice-id:p1")).not.toBeNull();

    await setConnectionHidden(bob, "alice-id", false);
    expect((await listConnections(bob))[0]!.hidden).toBe(false);
  });

  it("removes a connection but keeps their posts when asked", async () => {
    const { bob } = await bobWithConnection();
    const result = await removeConnection(bob, "alice-id", { dropPosts: false });
    expect(result.droppedPosts).toBe(0);
    expect(await listConnections(bob)).toHaveLength(0);
    expect(await bob.getItem("post:alice-id:p1")).not.toBeNull();
  });

  it("removes a connection and drops their posts, photos, and thumbs", async () => {
    const { bob } = await bobWithConnection();
    const before = await bob.getItem("post:alice-id:p1");
    const result = await removeConnection(bob, "alice-id", { dropPosts: true });
    expect(result.droppedPosts).toBe(1);
    expect(await listConnections(bob)).toHaveLength(0);
    expect(await bob.getItem("post:alice-id:p1")).toBeNull();
    expect(await bob.getRecord(before!.mediaIds[0]!)).toBeNull();
    expect(await bob.getRecord(before!.thumbId!)).toBeNull();
  });

  it("summarizes post counts per connection", async () => {
    const { bob } = await bobWithConnection();
    const summaries = summarizeConnections(await listConnections(bob), await bob.listItems());
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.postCount).toBe(1);
    expect(summaries[0]!.connection.handle).toBe("alice");
  });

  it("re-import preserves nickname and hidden, keeps first-seen addedAt, refreshes lastImportAt", async () => {
    const { bob, alice } = await bobWithConnection();
    await setConnectionNickname(bob, "alice-id", "Alice W");
    await setConnectionHidden(bob, "alice-id", true);

    const { text: fresh } = await buildShareBundle(alice, settingsFor("alice-id", "alice"), await alice.listItems(), LATER);
    await importShareBundle(bob, fresh, { settings: settingsFor("bob-id", "bob"), newId, now: LATER });

    const [connection] = await listConnections(bob);
    expect(connection!.nickname).toBe("Alice W");
    expect(connection!.hidden).toBe(true);
    expect(connection!.addedAt).toBe(NOW.toISOString());
    expect(connection!.lastImportAt).toBe(LATER.toISOString());
  });
});

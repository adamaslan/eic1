import { describe, expect, it } from "vitest";
import {
  ARRIVAL_HASH_KEY,
  clearMemoryArrival,
  dropAllStashes,
  dropStash,
  kindOfHash,
  pendingKey,
  promoteArrivalHash,
  readMemoryArrival,
  readStash,
  resolveStashForVault, bindStashesToVault,
  writeStash,
  type SlotStore,
} from "./pending-links";

const mapStore = (): SlotStore & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, get: (k) => data.get(k) ?? null, set: (k, v) => void data.set(k, v), remove: (k) => void data.delete(k) };
};

const chatEntry = (forAuthorId: string | null) => ({ hash: "#chat=abc123", forAuthorId, stashedAt: 1 });

describe("pending-link slots", () => {
  it("keys a slot stashed while a vault is active, and only that vault reads it", () => {
    const store = mapStore();
    writeStash(store, "chat", chatEntry("alice-id"));
    expect(resolveStashForVault(store, "chat", "alice-id")?.hash).toBe("#chat=abc123");
    // A different vault on the same device: the slot is dropped, never applied.
    expect(resolveStashForVault(store, "chat", "bob-id")).toBeNull();
    expect(readStash(store, "chat")).toBeNull();
  });

  it("binds an unbound fresh-load slot to the first vault that unlocks (the primary tap path)", () => {
    const store = mapStore();
    // Fresh page load: stashed before the vault rehydrates, so it starts unbound.
    writeStash(store, "chat", chatEntry(null));
    const bound = resolveStashForVault(store, "chat", "alice-id");
    expect(bound?.forAuthorId).toBe("alice-id");
    // The binding persists: from here on the cross-vault guard engages normally.
    expect(readStash(store, "chat")?.forAuthorId).toBe("alice-id");
    expect(resolveStashForVault(store, "chat", "bob-id")).toBeNull();
    expect(readStash(store, "chat")).toBeNull();
  });

  it("drops every slot on lock so no prompt survives into another session", () => {
    const store = mapStore();
    writeStash(store, "chat", chatEntry("alice-id"));
    writeStash(store, "connect", { hash: "#connect=xyz", forAuthorId: "alice-id", stashedAt: 1 });
    dropAllStashes(store);
    expect(store.data.size).toBe(0);
  });

  it("ignores malformed or kind-mismatched slot contents", () => {
    const store = mapStore();
    store.set(pendingKey("chat"), "not json");
    store.set(pendingKey("post"), JSON.stringify({ hash: "#chat=abc", forAuthorId: null, stashedAt: 1 }));
    expect(readStash(store, "chat")).toBeNull();
    expect(readStash(store, "post")).toBeNull();
  });

  it("maps each link prefix to its own slot kind", () => {
    expect(kindOfHash("#chat=a")).toBe("chat");
    expect(kindOfHash("#connect=a")).toBe("connect");
    expect(kindOfHash("#import=a")).toBe("post");
    expect(kindOfHash("#/feed")).toBeNull();
  });
});

describe("bindStashesToVault", () => {
  it("binds unbound slots to the vault that just resumed and leaves keyed slots alone", () => {
    const store = mapStore();
    writeStash(store, "chat", chatEntry(null));
    writeStash(store, "connect", { hash: "#connect=xyz789", forAuthorId: "other-vault", stashedAt: 1 });
    bindStashesToVault(store, "vault-1");
    expect(readStash(store, "chat")!.forAuthorId).toBe("vault-1");
    expect(readStash(store, "connect")!.forAuthorId).toBe("other-vault");
  });
});

describe("promoteArrivalHash (parse-time capture)", () => {
  it("promotes a captured link hash to a typed unbound slot and removes the raw key", () => {
    const store = mapStore();
    store.set(ARRIVAL_HASH_KEY, "#import=payload");
    promoteArrivalHash(store, "");
    expect(store.get(ARRIVAL_HASH_KEY)).toBeNull(); // consumed: no stale leftover
    const stashed = readStash(store, "post");
    expect(stashed?.hash).toBe("#import=payload");
    expect(stashed?.forAuthorId).toBeNull(); // unbound: vault-arrival binding owns keying
  });

  it("drops an unrelated hash - parked raw key removed, nothing stashed", () => {
    const store = mapStore();
    store.set(ARRIVAL_HASH_KEY, "#/feed");
    promoteArrivalHash(store, "");
    expect(store.get(ARRIVAL_HASH_KEY)).toBeNull();
    for (const kind of ["post", "chat", "connect"] as const) expect(readStash(store, kind)).toBeNull();
  });

  it("retains the link in memory when storage is fully denied, until consumed", () => {
    // sessionSlotStore swallows storage errors: reads return null, writes no-op. The link
    // must still survive client-side navigation (landing -> unlock -> vault creation) -
    // memory is the only retention left, and it lasts exactly this document's life.
    clearMemoryArrival();
    const denied = mapStore();
    denied.get = () => null;
    denied.set = () => undefined;
    promoteArrivalHash(denied, "#chat=live");
    expect(readStash(denied, "chat")).toBeNull(); // nothing could persist - honest
    expect(readMemoryArrival()).toBe("#chat=live"); // but the link is not lost
    // Consumed (dismiss/import) or locked: the retention clears with the slot lifecycle.
    dropStash(denied, "chat");
    expect(readMemoryArrival()).toBeNull();
  });

  it("clears retention on lock (dropAllStashes) and keeps it on an unrelated kind drop", () => {
    clearMemoryArrival();
    const store = mapStore();
    store.set(ARRIVAL_HASH_KEY, "#import=payload");
    promoteArrivalHash(store, "");
    expect(readMemoryArrival()).toBe("#import=payload");
    dropStash(store, "chat"); // a chat dismissal must not eat the retained post link
    expect(readMemoryArrival()).toBe("#import=payload");
    dropAllStashes(store); // lock: every pending link goes, retained copies included
    expect(readMemoryArrival()).toBeNull();
  });

  it("ignores a live hash that is not a link, and a newer capture supersedes an older slot", () => {
    const store = mapStore();
    promoteArrivalHash(store, "#/settings");
    for (const kind of ["post", "chat", "connect"] as const) expect(readStash(store, kind)).toBeNull();
    writeStash(store, "post", { hash: "#import=older", forAuthorId: null, stashedAt: 1 });
    store.set(ARRIVAL_HASH_KEY, "#import=newer");
    promoteArrivalHash(store, "");
    expect(readStash(store, "post")?.hash).toBe("#import=newer");
  });
});

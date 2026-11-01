import { describe, expect, it } from "vitest";
import {
  dropAllStashes,
  kindOfHash,
  pendingKey,
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

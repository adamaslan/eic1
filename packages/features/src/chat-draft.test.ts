import { describe, expect, it } from "vitest";
import { SubtleCryptoPort } from "@veil/crypto";
import { createVault } from "@veil/vault";
import { MemoryStore } from "../../vault/src/memory-store";
import { loadChatDraft, saveChatDraft } from "./chat-draft";
import { listChatThread } from "./chat";

const NOW = new Date("2026-11-20T12:00:00Z");
const open = (store = new MemoryStore()) => createVault({ store, crypto: new SubtleCryptoPort(), now: () => NOW }, "pass phrase 1");

describe("chat drafts", () => {
  it("keeps one draft per chat, encrypted, and never lists it as a message", async () => {
    const store = new MemoryStore();
    const vault = await open(store);
    await saveChatDraft(vault, "alice-id", "half a thought");
    await saveChatDraft(vault, "bob-id", "for bob");
    expect(await loadChatDraft(vault, "alice-id")).toBe("half a thought");
    expect(await loadChatDraft(vault, "bob-id")).toBe("for bob");
    expect(await listChatThread(vault, "alice-id")).toEqual([]);
    const raw = JSON.stringify([...(store as unknown as { records: Map<string, unknown> }).records.values()]);
    expect(raw).not.toContain("half a thought");
  });

  it("blank text removes the record, and a missing or unreadable draft reads as empty", async () => {
    const vault = await open();
    expect(await loadChatDraft(vault, "alice-id")).toBe("");
    await saveChatDraft(vault, "alice-id", "sent soon");
    await saveChatDraft(vault, "alice-id", "   ");
    expect(await vault.getJson("chat-draft:alice-id")).toBeNull();
    await vault.putJson("settings", "chat-draft:alice-id", { v: 2, body: "future shape" });
    expect(await loadChatDraft(vault, "alice-id")).toBe("");
  });
});

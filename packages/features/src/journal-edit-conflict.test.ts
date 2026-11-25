import { describe, expect, it } from "vitest";
import { SubtleCryptoPort } from "@veil/crypto";
import { createVault } from "@veil/vault";
import { MemoryStore } from "../../vault/src/memory-store";
import { addJournalEntry, updateJournalEntry } from "./journal";

const fresh = () => createVault({ store: new MemoryStore(), crypto: new SubtleCryptoPort(), now: () => new Date() }, "synthetic edit conflicts");
const deps = { newId: () => "fixture", now: new Date("2026-11-24T12:00:00Z") };

describe("journal edit conflict safety", () => {
  it("refuses a stale displayed entry after another tab saved a newer version", async () => {
    const vault = await fresh();
    const original = await addJournalEntry(vault, "original", deps);
    await updateJournalEntry(vault, original.id, "other tab's saved edit");
    await expect(updateJournalEntry(vault, original.id, "stale draft", original)).rejects.toThrow();
    expect(await vault.getJson(original.id)).toEqual({ ...original, text: "other tab's saved edit" });
  });

  for (const action of ["edit", "delete"] as const) {
    it(`does not overwrite or recreate a record when another tab wins a ${action} during the read/write gap`, async () => {
      const vault = await fresh();
      const original = await addJournalEntry(vault, "original", deps);
      const read = vault.getJson.bind(vault);
      let raced = false;
      vault.getJson = async (id) => {
        const snapshot = await read(id);
        if (!raced && id === original.id) {
          raced = true;
          if (action === "edit") await vault.putJson("journal", id, { ...original, text: "winning edit" });
          else await vault.deleteRecords([id]);
        }
        return snapshot;
      };
      await expect(updateJournalEntry(vault, original.id, "losing edit")).rejects.toThrow();
      expect(await read(original.id)).toEqual(action === "edit" ? { ...original, text: "winning edit" } : null);
    });
  }

  it("keeps an ordinary guarded edit and original identity/date", async () => {
    const vault = await fresh();
    const original = await addJournalEntry(vault, "original", deps);
    expect(await updateJournalEntry(vault, original.id, "  revised  ", original)).toEqual({ ...original, text: "revised" });
  });
});

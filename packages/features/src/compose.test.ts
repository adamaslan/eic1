import { describe, expect, it, vi } from "vitest";
import type { Bytes, EncryptedRecord, Item } from "@veil/core";
import type { UnlockedVault } from "@veil/vault";
import { parsePriceToCents, saveComposedItem, validateCompose, type ComposeInput } from "./compose";

const listing: ComposeInput = {
  type: "listing",
  title: "  Peugeot road bike ",
  category: "bikes",
  price: "120",
  description: "Needs tires.",
};

describe("parsePriceToCents", () => {
  it("parses dollars and cents", () => {
    expect(parsePriceToCents("120")).toBe(12000);
    expect(parsePriceToCents("$12.50")).toBe(1250);
    expect(parsePriceToCents("0.1")).toBe(10);
  });

  it("treats blank and zero as free", () => {
    expect(parsePriceToCents("")).toBeNull();
    expect(parsePriceToCents("  ")).toBeNull();
    expect(parsePriceToCents("0")).toBeNull();
  });

  it("rejects non-amounts", () => {
    for (const bad of ["abc", "-5", "1.234", "1,000", "12 dollars"]) {
      expect(parsePriceToCents(bad)).toBeNaN();
    }
  });

  it("rejects cent values outside the safe integer range", () => {
    expect(parsePriceToCents("90071992547410")).toBeNaN();
  });
});

describe("validateCompose", () => {
  it("trims and normalises a valid listing without media", () => {
    const result = validateCompose(listing, 0);
    expect(result).toEqual({
      ok: true,
      fields: { type: "listing", title: "Peugeot road bike", category: "bikes", priceCents: 12000, description: "Needs tires.", visibility: "private" },
    });
  });

  it("keeps the shareable choice", () => {
    expect(validateCompose({ ...listing, visibility: "shareable" }, 0)).toMatchObject({ ok: true, fields: { visibility: "shareable" } });
  });

  it("forces the moments category and no price on photos", () => {
    const result = validateCompose({ ...listing, type: "photo", category: "bikes", price: "99" }, 1);
    expect(result).toMatchObject({ ok: true, fields: { category: "moments", priceCents: null } });
  });

  it("requires a title, a valid price, and a photo for moments", () => {
    expect(validateCompose({ ...listing, title: " ", price: "x" }, 0)).toEqual({
      ok: false,
      errors: { title: expect.any(String), price: expect.any(String) },
    });
    expect(validateCompose({ ...listing, type: "photo" }, 0)).toMatchObject({ ok: false, errors: { media: expect.any(String) } });
  });

  it("caps media count and text length", () => {
    expect(validateCompose(listing, 7)).toMatchObject({ ok: false, errors: { media: expect.any(String) } });
    expect(validateCompose({ ...listing, description: "x".repeat(2001) }, 0)).toMatchObject({
      ok: false,
      errors: { description: expect.any(String) },
    });
  });
});

describe("saveComposedItem", () => {
  const bytes = (n: number) => new Uint8Array([n]) as Bytes;

  function fakeVault() {
    const records: Array<{ kind: string; bytes: Bytes }> = [];
    const written: EncryptedRecord[][] = [];
    const sealed = (kind: string, id: string) => ({ v: 1, id, kind, iv: bytes(0), ciphertext: bytes(0) });
    const vault = {
      sealRecord: vi.fn(async (kind: string, plaintext: Bytes) => {
        records.push({ kind, bytes: plaintext });
        return sealed(kind, `${kind}-${records.length}`);
      }),
      sealItem: vi.fn(async (item: Item) => sealed("item", item.id)),
      putRecords: vi.fn(async (batch: EncryptedRecord[]) => {
        written.push(batch);
      }),
    } as unknown as UnlockedVault;
    return { vault, records, written };
  }

  const fields = { type: "photo" as const, title: "Fog", category: "moments" as const, priceCents: null, description: "", visibility: "private" as const };

  it("stores media, the first thumb, then an item pointing at them", async () => {
    const { vault, records, written } = fakeVault();
    const item = await saveComposedItem(
      vault,
      fields,
      [
        { bytes: bytes(1), thumb: bytes(11), mime: "image/jpeg" },
        { bytes: bytes(2), thumb: bytes(12), mime: "image/jpeg" },
      ],
      { newId: () => "abc", now: new Date("2026-10-25T12:00:00Z") },
    );

    expect(records.map((r) => r.kind)).toEqual(["media", "media", "thumb"]);
    expect(records[2]?.bytes).toEqual(bytes(11));
    expect(item).toMatchObject({
      id: "abc",
      mediaIds: ["media-1", "media-2"],
      thumbId: "thumb-3",
      mediaMime: "image/jpeg",
      createdAt: "2026-10-25T12:00:00.000Z",
      likes: 0,
    });
    expect(written).toHaveLength(1);
    expect(written[0]?.map((record) => record.kind)).toEqual(["media", "media", "thumb", "item"]);
  });

  it("writes nothing when any image fails to seal", async () => {
    const { vault, written } = fakeVault();
    const sealRecord = vault.sealRecord as unknown as ReturnType<typeof vi.fn>;
    sealRecord.mockImplementationOnce(async () => ({ v: 1, id: "media-1" }));
    sealRecord.mockImplementationOnce(async () => {
      throw new Error("encryption failed");
    });

    await expect(
      saveComposedItem(
        vault,
        fields,
        [
          { bytes: bytes(1), thumb: bytes(11), mime: "image/jpeg" },
          { bytes: bytes(2), thumb: bytes(12), mime: "image/jpeg" },
        ],
        { newId: () => "ghi", now: new Date() },
      ),
    ).rejects.toThrow("encryption failed");
    expect(written).toHaveLength(0);
  });

  it("saves a media-less listing with no thumb", async () => {
    const { vault, records, written } = fakeVault();
    const item = await saveComposedItem(vault, { ...fields, type: "listing", category: "bikes" }, [], {
      newId: () => "def",
      now: new Date(),
    });
    expect(records).toHaveLength(0);
    expect(written[0]?.map((record) => record.kind)).toEqual(["item"]);
    expect(item).toMatchObject({ mediaIds: [], thumbId: null });
  });
});

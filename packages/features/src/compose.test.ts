import { describe, expect, it, vi } from "vitest";
import type { Bytes } from "@veil/core";
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
});

describe("validateCompose", () => {
  it("trims and normalises a valid listing without media", () => {
    const result = validateCompose(listing, 0);
    expect(result).toEqual({
      ok: true,
      fields: { type: "listing", title: "Peugeot road bike", category: "bikes", priceCents: 12000, description: "Needs tires." },
    });
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
    const putItem = vi.fn(async () => {});
    const vault = {
      putRecord: vi.fn(async (kind: string, plaintext: Bytes) => {
        records.push({ kind, bytes: plaintext });
        return `${kind}-${records.length}`;
      }),
      putItem,
    } as unknown as UnlockedVault;
    return { vault, records, putItem };
  }

  const fields = { type: "photo" as const, title: "Fog", category: "moments" as const, priceCents: null, description: "" };

  it("stores media, the first thumb, then an item pointing at them", async () => {
    const { vault, records, putItem } = fakeVault();
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
    expect(putItem).toHaveBeenCalledWith(item);
  });

  it("saves a media-less listing with no thumb", async () => {
    const { vault, records } = fakeVault();
    const item = await saveComposedItem(vault, { ...fields, type: "listing", category: "bikes" }, [], {
      newId: () => "def",
      now: new Date(),
    });
    expect(records).toHaveLength(0);
    expect(item).toMatchObject({ mediaIds: [], thumbId: null });
  });
});

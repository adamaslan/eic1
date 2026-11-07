import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("public sticker downloads are real PNGs, accessible without a vault", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto("/stickers");
  await expect(page.getByRole("link", { name: /^Download .* PNG$/ })).toHaveCount(20);
  for (const image of await page.locator("img").all()) {
    await expect(image).toHaveJSProperty("naturalWidth", 96);
    await expect(image).toHaveJSProperty("naturalHeight", 96);
  }
  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download Seal PNG", exact: true }).click();
  const file = await download; expect(file.suggestedFilename()).toBe("eic-sticker-seal.png");
  const bytes = await readFile((await file.path())!);
  expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  expect(bytes.readUInt32BE(16)).toBe(96); expect(bytes.readUInt32BE(20)).toBe(96);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test("private avatar decorates own shell and graph but never selected feed preview; clear and lock hide it", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  await page.goto("/unlock"); await page.getByLabel("Passphrase", { exact: true }).fill("avatar-surface-private-test"); await page.getByLabel("Confirm passphrase").fill("avatar-surface-private-test"); await page.getByRole("button", { name: "Create vault", exact: true }).click();
  await page.getByRole("link", { name: "Connections", exact: true }).click(); await page.getByLabel("Handle", { exact: true }).fill("surfacecheck"); await page.getByRole("button", { name: "Save", exact: true }).click(); await expect(page.getByText("Handle saved.")).toBeVisible();
  await page.getByRole("link", { name: "My profile", exact: true }).click(); await page.getByRole("button", { name: "Customize profile", exact: true }).click();
  await page.getByRole("group", { name: "Paint avatars", exact: true }).getByRole("button", { name: "Seal", exact: true }).click(); await page.getByRole("button", { name: "Save private draft", exact: true }).click(); await expect(page.getByRole("status")).toContainText("Feed profile unchanged");
  await expect(page.locator("header").getByAltText("Your avatar")).toBeVisible();
  await page.getByRole("button", { name: "Preview selected feed profile", exact: true }).click(); await expect(page.getByRole("region", { name: "Selected feed profile preview" }).locator("img")).toHaveCount(0);
  await expect(page.getByRole("checkbox", { name: "Avatar", exact: true })).not.toBeChecked();
  await page.getByRole("link", { name: "+ Post", exact: true }).click(); await page.getByRole("radio", { name: "Marketplace listing" }).check(); await page.getByLabel("Title", { exact: true }).fill("Avatar graph fixture"); await page.getByRole("button", { name: /Encrypt & save/ }).click(); await expect(page.getByText("Avatar graph fixture")).toBeVisible();
  await page.getByRole("link", { name: "Graph", exact: true }).click(); await expect(page.locator('svg image[aria-label="surfacecheck\'s avatar"]')).toHaveCount(1);
  await page.getByRole("link", { name: "My profile", exact: true }).click(); await page.getByRole("button", { name: "Customize profile", exact: true }).click(); await page.getByRole("button", { name: "Remove avatar", exact: true }).click(); await page.getByRole("button", { name: "Save private draft", exact: true }).click(); await expect(page.locator("header").getByAltText("Your avatar")).toHaveCount(0);
  await page.getByRole("button", { name: "Lock", exact: true }).click(); await expect(page.getByAltText("Your avatar")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("signed-out landing feed examples carry drawn avatars, and the gallery shows all 20", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto("/");
  // Feed tab: sample photo cards show their fictional authors' drawn avatars, no vault needed.
  await expect(page.getByAltText("maya's avatar").first()).toBeVisible();
  await expect(page.getByAltText("juno's avatar").first()).toBeVisible();
  await expect(page.getByAltText("rex's avatar").first()).toBeVisible();
  // The sample photo panels show the example's drawn sticker big, not a blank color panel.
  const stickerPanels = page.locator('img[src^="/stickers/eic-sticker-"]');
  await expect(stickerPanels).toHaveCount(4);
  await expect(page.getByRole("img", { name: "Drawn Cat sticker", exact: true })).toBeVisible();
  for (const sticker of await stickerPanels.all()) {
    await expect(sticker).toHaveJSProperty("naturalWidth", 96);
  }
  // Marketplace tab: sample listing rows carry authors too.
  await page.getByRole("tab", { name: "Marketplace", exact: true }).click();
  await expect(page.getByAltText("volt's avatar").first()).toBeVisible();
  await expect(page.getByAltText("otis's avatar").first()).toBeVisible();
  // Detail view of a sample item also names its author.
  await page.getByRole("tab", { name: "Feed", exact: true }).click();
  await page.getByRole("button", { name: /Cat asleep on the radiator/ }).click();
  await expect(page.getByAltText("juno's avatar").first()).toBeVisible();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  // The gallery lists every drawn avatar and links the sticker downloads.
  await expect(page.getByRole("list", { name: "The 20 drawn avatars", exact: true }).locator("img")).toHaveCount(20);
  await expect(page.getByRole("link", { name: "Download all 20 as PNG stickers", exact: true })).toBeVisible();
  // The music panel states the catalog-derived count and real formats, never a stale hardcode.
  const musicCatalog = JSON.parse(await readFile(new URL("../apps/web/app/data/music-library.json", import.meta.url), "utf8")) as { file: string }[];
  const formats = [...new Set(musicCatalog.map((track) => track.file.split(".").pop()?.toUpperCase()))].join(" and ");
  await expect(page.getByText(`42b - ${musicCatalog.length} songs, free to play.`, { exact: true })).toBeVisible();
  await expect(page.getByText(`Original ${formats} files, unchanged.`, { exact: false })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

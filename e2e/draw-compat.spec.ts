import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";

/**
 * Rollback data compatibility: this fixture is a real encrypted vault backup produced
 * by the pre-expansion Paint build (cf08a58) holding a drawing made with the old
 * brush-only editor (black stroke on white paper, old 16-color PNG post). The expanded
 * editor must keep restoring and rendering it - saved drawings outlive any editor
 * change or revert. The fixture passphrase is compat-old-passphrase; the file is
 * ciphertext, so it carries no secrets.
 */

const FIXTURE = "e2e/fixtures/old-drawing-backup.vault";
const FIXTURE_PASSPHRASE = "compat-old-passphrase";

async function imageInk(page: Page, name: string): Promise<number> {
  const img = page.getByRole("img", { name });
  await expect(img).toBeVisible();
  return img.evaluate((node) => {
    const image = node as HTMLImageElement;
    const probe = document.createElement("canvas");
    probe.width = image.naturalWidth;
    probe.height = image.naturalHeight;
    const context = probe.getContext("2d");
    if (!context || probe.width === 0) return -1;
    context.drawImage(image, 0, 0);
    const data = context.getImageData(0, 0, probe.width, probe.height).data;
    let inked = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] < 250 || data[i + 1] < 250 || data[i + 2] < 250) inked += 1;
    }
    return inked;
  });
}

test("a drawing saved by the pre-expansion Paint still restores and renders", async ({ page }) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(String(error)));

  const backup = await readFile(FIXTURE, "utf8");
  await page.goto("/unlock");
  await expect(page.getByText(/No vault yet/)).toBeVisible();
  await page.getByLabel("Restore from backup").setInputFiles({
    name: "backup.vault",
    mimeType: "application/json",
    buffer: Buffer.from(backup, "utf8"),
  });
  await expect(page.getByText(/Backup restored \(\d+ records\)/)).toBeVisible();
  await page.getByLabel("Passphrase", { exact: true }).fill(FIXTURE_PASSPHRASE);
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();

  await page.goto("/feed");
  expect(await imageInk(page, "old-drawing")).toBeGreaterThan(0);

  // And the restored drawing still opens at full size on its own page.
  await page.getByText("old-drawing").first().click();
  await expect(page).toHaveURL(/\/feed\/|\/item/);
  expect(pageErrors).toEqual([]);
  expect(consoleErrors.filter((text) => !text.startsWith("Failed to load resource"))).toEqual([]);
});

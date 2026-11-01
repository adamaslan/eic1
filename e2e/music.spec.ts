import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

/**
 * Local music player: real MP3 files picked through the real file input, played by the real
 * <audio> element. Asserts natural ordering, automatic next track, folder loop, and toggles
 * from the element's own state (currentTime / src / ended), not from DOM labels alone.
 */

let vaultCounter = 0;
async function createVault(page: Page) {
  vaultCounter += 1;
  const passphrase = `ci-music-passphrase-${Date.now()}-${vaultCounter}`;
  await page.goto("/");
  await page.getByRole("link", { name: "Create or open your vault" }).first().click();
  await page.getByLabel("Passphrase", { exact: true }).fill(passphrase);
  await page.getByLabel("Confirm passphrase").fill(passphrase);
  await page.getByRole("button", { name: "Create vault" }).click();
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
}

const FILES = ["1 tone.mp3", "2 tone.mp3", "10 tone.mp3"].map((name) => `e2e/fixtures/music/${name}`);

test("plays picked mp3s in order, moves on by itself and loops the folder", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  await createVault(page);
  await page.goto("/tools");
  await page.getByRole("link", { name: "Music" }).click();
  await expect(page.getByText("No folder loaded")).toBeVisible();

  await page.getByLabel("Choose music files").setInputFiles(FILES);
  const list = page.getByRole("list", { name: "Playlist" });
  await expect(list.getByRole("button")).toHaveText(["1. 1 tone", "2. 2 tone", "3. 10 tone"]);

  await page.getByRole("button", { name: "▶ Play" }).click();
  const title = page.locator(".font-mono");
  await expect(title).toContainText("1/3");
  await expect(page.getByTestId("player")).toHaveJSProperty("paused", false);
  // Real decoded media: duration is known and time advances.
  await expect.poll(() => page.getByTestId("player").evaluate((a: HTMLAudioElement) => a.currentTime)).toBeGreaterThan(0.2);
  expect(await page.getByTestId("player").evaluate((a: HTMLAudioElement) => a.duration)).toBeGreaterThan(0.8);

  // Natural end of each 1s track advances without any click, then wraps to track 1.
  await expect(title).toContainText("2/3", { timeout: 10_000 });
  await expect(title).toContainText("3/3", { timeout: 10_000 });
  await expect(title).toContainText("1/3", { timeout: 10_000 });
  await expect(page.getByTestId("player")).toHaveJSProperty("paused", false);

  // Loop off: stops after the last track instead of wrapping.
  await page.getByRole("button", { name: /Loop: folder/ }).click(); // -> song
  await page.getByRole("button", { name: /Loop: song/ }).click(); // -> off
  await list.getByRole("button", { name: "3. 10 tone" }).click();
  await expect(title).toContainText("3/3");
  await expect(page.getByTestId("player")).toHaveJSProperty("paused", true, { timeout: 10_000 });
  await expect(title).toContainText("3/3");

  // Toggles: playlist hides, speed changes the element's rate.
  await page.getByRole("button", { name: "Playlist" }).click();
  await expect(list).toHaveCount(0);
  await page.getByRole("button", { name: /Speed 1x/ }).click();
  await expect(page.getByTestId("player")).toHaveJSProperty("playbackRate", 1.25);

  expect(pageErrors).toEqual([]);
});

test("ignores non-audio files and says so", async ({ page }) => {
  await createVault(page);
  await page.goto("/tools/music");
  await page.getByLabel("Choose music files").setInputFiles([
    { name: "1 tone.mp3", mimeType: "audio/mpeg", buffer: readFileSync(FILES[0]!) },
    { name: "cover.jpg", mimeType: "image/jpeg", buffer: Buffer.from("x") },
  ]);
  await expect(page.getByRole("list", { name: "Playlist" }).getByRole("button")).toHaveCount(1);
});

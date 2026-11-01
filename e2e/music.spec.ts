import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

/**
 * Local music player: real MP3 files picked through the real file input, played by the real
 * <audio> element. Asserts natural ordering, automatic next track, folder loop, and toggles
 * from the element's own state (currentTime / src / ended), not from DOM labels alone.
 */

let vaultCounter = 0;
let currentPassphrase = "";
async function createVault(page: Page) {
  vaultCounter += 1;
  const passphrase = `ci-music-passphrase-${Date.now()}-${vaultCounter}`;
  currentPassphrase = passphrase;
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
  await expect(list.getByRole("button", { name: /^\d+\. / })).toHaveText([/1\. 1 tone/, /2\. 2 tone/, /3\. 10 tone/]);

  await page.getByRole("button", { name: "▶ Play" }).click();
  const title = page.getByTestId("track-display");
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
  await list.getByRole("button", { name: /^3\. 10 tone/ }).click();
  await expect(title).toContainText("3/3");
  await expect(page.getByTestId("player")).toHaveJSProperty("paused", true, { timeout: 10_000 });
  await expect(title).toContainText("3/3");

  // Toggles: playlist hides, speed menu changes the element's rate.
  await page.getByRole("button", { name: "Playlist", exact: true }).click();
  await expect(list).toHaveCount(0);
  await page.getByLabel("Playback speed").selectOption("1.25");
  await expect(page.getByTestId("player")).toHaveJSProperty("playbackRate", 1.25);
  await page.getByLabel("Playback speed").selectOption("0.5");
  await expect(page.getByTestId("player")).toHaveJSProperty("playbackRate", 0.5);

  expect(pageErrors).toEqual([]);
});

test("ignores non-audio files and says so", async ({ page }) => {
  await createVault(page);
  await page.goto("/tools/music");
  await page.getByLabel("Choose music files").setInputFiles([
    { name: "1 tone.mp3", mimeType: "audio/mpeg", buffer: readFileSync(FILES[0]!) },
    { name: "cover.jpg", mimeType: "image/jpeg", buffer: Buffer.from("x") },
  ]);
  await expect(page.getByRole("list", { name: "Playlist" }).getByRole("button", { name: /^1\. / })).toHaveCount(1);
});

test("plays wav files and shows the expanded speed menu", async ({ page }) => {
  await createVault(page);
  await page.goto("/tools/music");
  await page.getByLabel("Choose music files").setInputFiles(["e2e/fixtures/music/4 tone.wav"]);
  await page.getByRole("button", { name: "▶ Play" }).click();
  const player = page.getByTestId("player");
  await expect(player).toHaveJSProperty("paused", false);
  await expect.poll(() => player.evaluate((a: HTMLAudioElement) => a.currentTime)).toBeGreaterThan(0.2);
  // The speed menu lists every rate from 0.5x to 2x.
  await expect(page.getByLabel("Playback speed").locator("option")).toHaveText([
    "0.5x", "0.75x", "1x", "1.25x", "1.5x", "1.75x", "2x",
  ]);
});

test("saves a playlist and reopens it by re-picking the songs", async ({ page }) => {
  await createVault(page);
  await page.goto("/tools/music");
  await page.getByLabel("Choose music files").setInputFiles(FILES);
  await page.getByLabel("Playlist name").fill("Gym Mix");
  await page.getByRole("button", { name: "Save playlist" }).click();
  await expect(page.getByRole("status")).toContainText('Saved "Gym Mix" - the list, not the songs');

  // Clear, then reopen through the saved list: the same picks re-link in saved order.
  page.once("dialog", (d) => void d.accept());
  await page.getByRole("button", { name: "Clear" }).click();
  await expect(page.getByTestId("track-display")).toContainText("No folder loaded");
  await page.getByRole("button", { name: "Open…" }).click();
  await page.getByLabel("Pick the songs for this playlist").setInputFiles(FILES);
  await expect(page.getByRole("status")).toContainText('Opened "Gym Mix"');
  await expect(page.getByRole("list", { name: "Playlist" }).getByRole("button", { name: /\d\. / })).toHaveText([
    /1\. 1 tone/,
    /2\. 2 tone/,
    /3\. 10 tone/,
  ]);
});

test("share bundle round-trip: import plays the actual audio", async ({ page, browser }) => {
  await createVault(page);
  await page.goto("/tools/music");
  await page.getByLabel("Choose music files").setInputFiles(FILES);

  // Share. On desktop Linux Chromium there is no native share sheet, so this downloads a bundle.
  const downloadPromise = page.waitForEvent("download", { timeout: 15_000 }).catch(() => null);
  await page.getByRole("button", { name: "Share playlist + songs" }).click();
  const download = await downloadPromise;
  const status = page.getByRole("status");
  if (!download) {
    // A native share sheet appeared instead; cancel it and prove the honest fallback note path is not required.
    await expect(status).toContainText(/Shared|cancelled/i);
    return;
  }
  const bundlePath = `/tmp/${download.suggestedFilename()}`;
  await download.saveAs(bundlePath);
  await expect(status).toContainText(".eicmusic");

  // A fresh browser context = the receiver's device: import the bundle and really play it.
  const receiver = await browser.newContext();
  const receiverPage = await receiver.newPage();
  const receiverErrors: string[] = [];
  receiverPage.on("pageerror", (e) => receiverErrors.push(String(e)));
  await createVault(receiverPage);
  await receiverPage.goto("/tools/music");
  await receiverPage.getByLabel("Import a shared playlist").setInputFiles(bundlePath);
  await expect(receiverPage.getByRole("status")).toContainText(/Imported .* 3 song\(s\) ready to play/);
  await receiverPage.getByRole("button", { name: "▶ Play" }).click();
  const player = receiverPage.getByTestId("player");
  await expect(player).toHaveJSProperty("paused", false);
  await expect
    .poll(() => player.evaluate((a: HTMLAudioElement) => a.currentTime))
    .toBeGreaterThan(0.2);
  expect(await player.evaluate((a: HTMLAudioElement) => a.duration)).toBeGreaterThan(0.8);
  expect(receiverErrors).toEqual([]);
  await receiver.close();
});

test("refuses to share over the 25 MB audio limit", async ({ page }) => {
  await createVault(page);
  await page.goto("/tools/music");
  // 26 MB of fake audio bytes: the size check must fire before anything is built.
  await page.getByLabel("Choose music files").setInputFiles([
    { name: "big.mp3", mimeType: "audio/mpeg", buffer: Buffer.alloc(26 * 1024 * 1024, 1) },
  ]);
  await page.getByRole("button", { name: "Share playlist + songs" }).click();
  await expect(page.getByRole("status")).toContainText("over the 25.0 MB share limit");
});

test("music keeps playing on the feed with a now-playing strip", async ({ page }) => {
  await createVault(page);
  await page.goto("/tools/music");
  await page.getByLabel("Choose music files").setInputFiles(FILES);
  await page.getByRole("button", { name: "▶ Play" }).click();
  await expect(page.getByTestId("player")).toHaveJSProperty("paused", false);

  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Feed" }).click();
  const strip = page.getByLabel("Now playing");
  await expect(strip).toBeVisible();
  await expect(strip).toContainText(/tone/);
  // The same audio element kept playing through navigation.
  await expect(page.getByTestId("player")).toHaveJSProperty("paused", false);
  await expect
    .poll(() => page.getByTestId("player").evaluate((a: HTMLAudioElement) => a.currentTime))
    .toBeGreaterThan(0.2);
  await strip.getByLabel("Pause").click();
  await expect(page.getByTestId("player")).toHaveJSProperty("paused", true);
});

test("shrinks a wav on-device and the result plays", async ({ page }) => {
  await createVault(page);
  await page.goto("/tools/music");
  await page.getByLabel("Choose music files").setInputFiles(["e2e/fixtures/music/4 tone.wav"]);
  await page.getByRole("button", { name: "Shrink songs…" }).click();
  await page.getByRole("button", { name: /^Convert/ }).click();
  // Real encode of a 1s wav: finishes well under the default timeout.
  await expect(page.getByRole("button", { name: "Use" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("status")).toContainText(/Shrunk "4 tone" from .* to .*\./);
  await page.getByRole("button", { name: "Use" }).click();
  await page.getByRole("button", { name: "▶ Play" }).click();
  const player = page.getByTestId("player");
  await expect(player).toHaveJSProperty("paused", false);
  await expect.poll(() => player.evaluate((a: HTMLAudioElement) => a.currentTime)).toBeGreaterThan(0.15);
});

test("locking the vault stops playback and drops playlist state", async ({ page }) => {
  await createVault(page);
  await page.goto("/tools/music");
  await page.getByLabel("Choose music files").setInputFiles(FILES);
  await page.getByRole("button", { name: "▶ Play" }).click();
  await expect(page.getByTestId("player")).toHaveJSProperty("paused", false);
  await page.getByRole("button", { name: "Lock" }).click();
  await expect(page).toHaveURL(/\/unlock$/);
  // The element is gone with the desktop shell; unlocking brings back an empty, silent player.
  await page.getByLabel("Passphrase", { exact: true }).fill(currentPassphrase);
  await page.getByRole("button", { name: "Unlock" }).click();
  await page.getByRole("navigation", { name: "Main navigation" }).waitFor();
  await page.goto("/tools/music");
  await expect(page.getByTestId("track-display")).toContainText("No folder loaded");
  await expect(page.getByTestId("player")).toHaveJSProperty("paused", true);
});

test("a tampered bundle name list is refused honestly", async ({ page }) => {
  await createVault(page);
  await page.goto("/tools/music");
  await page.getByLabel("Import a shared playlist").setInputFiles([
    { name: "junk.eicmusic", mimeType: "application/zip", buffer: Buffer.from("not a zip at all") },
  ]);
  await expect(page.getByRole("status")).toContainText(/not a readable bundle|too small/i);
});

test("shrink panel is honest when the browser cannot re-encode", async ({ page }) => {
  await page.addInitScript(() => {
    // Simulate a browser with no MediaRecorder (the Safari-legacy path).
    Object.defineProperty(window, "MediaRecorder", { value: undefined, writable: true });
  });
  await createVault(page);
  await page.goto("/tools/music");
  await page.getByLabel("Choose music files").setInputFiles(FILES);
  await page.getByRole("button", { name: "Shrink songs…" }).click();
  await expect(page.getByRole("alert")).toContainText("This browser cannot re-encode audio");
  await expect(page.getByRole("button", { name: /^Convert/ })).toHaveCount(0);
});

test("a failed playlist delete says so, keeps the record, and does not crash", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await createVault(page);
  await page.goto("/tools/music");
  await page.getByLabel("Choose music files").setInputFiles(FILES);
  await page.getByLabel("Playlist name").fill("Keep Me");
  await page.getByRole("button", { name: "Save playlist" }).click();
  await expect(page.getByRole("status")).toContainText('Saved "Keep Me"');
  const savedList = page.getByRole("list", { name: "Saved playlists" });
  await expect(savedList).toContainText("Keep Me");

  // Sabotage the next IndexedDB delete only: the store's transaction aborts,
  // so the rejection must mean the record survived.
  await page.evaluate(() => {
    const proto = IDBObjectStore.prototype as unknown as { delete: (...args: unknown[]) => unknown };
    const orig = proto.delete;
    proto.delete = function (...args: unknown[]) {
      proto.delete = orig;
      throw new DOMException("injected delete failure", "AbortError");
    };
  });
  page.once("dialog", (d) => void d.accept());
  await savedList.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("status")).toContainText("Couldn't confirm deletion");
  await expect(savedList).toContainText("Keep Me");

  // Vault truth after a full reload: the record is still there.
  await page.reload();
  await expect(page.getByRole("list", { name: "Saved playlists" })).toContainText("Keep Me");

  // And a retry without the fault deletes it for real, with no fake failure note.
  page.once("dialog", (d) => void d.accept());
  await page.getByRole("list", { name: "Saved playlists" }).getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("list", { name: "Saved playlists" }).getByText("Keep Me", { exact: true })).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});

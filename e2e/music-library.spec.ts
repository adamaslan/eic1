import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import tracks from "../apps/web/app/data/music-library.json" with { type: "json" };

test("homepage library works signed out, plays real audio, and keeps controls inside a phone", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.setViewportSize({ width: 390, height: 844 });
  const audioRequests: string[] = [];
  page.on("request", (r) => { if (r.url().includes("/42b/")) audioRequests.push(r.url()); });
  await page.goto("/");
  await page.getByRole("link", { name: "music-library", exact: true }).click();
  await expect(page).toHaveURL(/\/music-library$/);
  const songs = page.getByRole("list", { name: "42b songs" });
  await expect(songs.getByRole("button")).toHaveCount(40);
  expect(audioRequests).toHaveLength(0);
  await songs.getByRole("button").first().click();
  const audio = page.getByTestId("library-audio");
  await expect.poll(() => audio.evaluate((a: HTMLAudioElement) => a.currentTime)).toBeGreaterThan(0.1);
  await page.getByLabel("Playback speed").selectOption("1.5");
  await expect.poll(() => audio.evaluate((a: HTMLAudioElement) => a.playbackRate)).toBe(1.5);
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByTestId("library-current")).toContainText(tracks[1]!.file.replace(/\.mp3$/i, ""));
  await expect.poll(() => audio.evaluate((a: HTMLAudioElement) => a.currentTime)).toBeGreaterThan(0.1);
  await page.getByLabel("Find a song").fill("nothing-matches-this");
  await expect(page.getByText("No songs match that search.")).toBeVisible();
  await page.getByLabel("Find a song").fill("");
  await page.screenshot({ path: "/downloads/music-library-390.png", fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.reload();
  await expect(page.getByTestId("library-current")).toHaveText("Choose a song");
  await page.goto("/tools/music");
  await expect(page).toHaveURL(/\/unlock$/);
  expect(errors).toEqual([]);
});

test("every original track is served byte-identical and loads as audio without signing in", async ({ page, request }) => {
  test.setTimeout(120000);
  await page.goto("/music-library");
  for (const track of tracks) {
    const url = `/42b/${encodeURIComponent(track.file).replace(/%2C/gi, ",")}`;
    const response = await request.get(url);
    expect(response.status(), track.file).toBe(200);
    expect(response.headers()["content-type"], track.file).toMatch(/audio\/mpeg/);
    const bytes = await response.body();
    expect(bytes.length).toBe(track.bytes);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(track.sha256);
    const duration = await page.evaluate((url) => new Promise<number>((resolve, reject) => {
      const audio = document.createElement("audio");
      audio.preload = "metadata";
      audio.onloadedmetadata = () => { const duration = audio.duration; audio.removeAttribute("src"); audio.load(); resolve(duration); };
      audio.onerror = () => reject(new Error(`Cannot read audio: ${url}`));
      audio.src = url;
    }), url);
    expect(duration).toBeGreaterThan(0);
  }
});

test("audio load failure is visible and another song can recover", async ({ page }) => {
  await page.route("**/42b/*", (r) => r.abort());
  await page.goto("/music-library");
  await page.getByRole("list", { name: "42b songs" }).getByRole("button").first().click();
  await expect(page.getByRole("status")).toContainText("could not be loaded or played");
  await page.unroute("**/42b/*");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect.poll(() => page.getByTestId("library-audio").evaluate((a: HTMLAudioElement) => a.currentTime)).toBeGreaterThan(0.1);
  await expect(page.getByRole("status")).toBeEmpty();
});

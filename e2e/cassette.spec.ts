import { test, expect } from "@playwright/test";

test("cassette flips by keyboard, keeps its music link, and starts reels only on request", async ({ page }) => {
  await page.goto("/");
  const tape = page.getByRole("region", { name: "Two-sided mixtape" });
  await expect(tape.getByRole("status")).toHaveText("Side A · featuring part1 je suis en delay");
  const flip = tape.getByRole("button", { name: "Flip to Side B" });
  await flip.focus();
  await page.keyboard.press("Enter");
  await expect(tape.getByRole("status")).toHaveText("Side B · Make it yours");
  await expect(tape.getByRole("button", { name: "Flip to Side A" })).toBeFocused();
  await expect(tape.getByRole("link", { name: "Open cassette music library" })).toHaveAttribute("href", "/music-library");
  const reel = tape.locator(".eic-tape-reels i").first();
  await expect(reel).toHaveCSS("animation-play-state", "paused");
  await tape.getByRole("button", { name: "Spin reels" }).click();
  await expect(reel).toHaveCSS("animation-play-state", "running");
  await tape.getByRole("button", { name: "Pause reels" }).click();
  await expect(reel).toHaveCSS("animation-play-state", "paused");
  expect(await page.locator("audio").evaluateAll(es => es.some(e => !(e as HTMLAudioElement).paused))).toBe(false);
});

for (const mode of ["off", "reduced"] as const) {
  test(`cassette side switching works without animation under ${mode} motion`, async ({ page }) => {
    if (mode === "reduced") await page.emulateMedia({ reducedMotion: "reduce" });
    if (mode === "off") await page.addInitScript(() => localStorage.setItem("eic.display.v1", JSON.stringify({ motion: "off" })));
    await page.goto("/");
    const tape = page.getByRole("region", { name: "Two-sided mixtape" });
    await tape.getByRole("button", { name: "Spin reels" }).click();
    await expect(tape.locator(".eic-tape-reels i").first()).toHaveCSS("animation-name", "none");
    await tape.getByRole("button", { name: "Flip to Side B" }).click();
    await expect(tape.getByRole("status")).toHaveText("Side B · Make it yours");
    await expect(tape.locator(".eic-tape-body")).toHaveCSS("transition-duration", "0s");
  });
}

test("cassette stays within the phone viewport at enlarged text", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem("eic.display.v1", JSON.stringify({ scale: 1.4, motion: "off" })));
  await page.goto("/unlock");
  await page.getByLabel("Passphrase", { exact: true }).fill("synthetic-cassette-test");
  await page.getByLabel("Confirm passphrase").fill("synthetic-cassette-test");
  await page.getByRole("button", { name: "Create vault" }).click();
  await page.waitForURL("/");
  const tape = page.getByRole("region", { name: "Two-sided mixtape" });
  await expect(page.locator(".w95-zoom")).toHaveCSS("zoom", "1.4");
  await tape.getByRole("button", { name: "Flip to Side B" }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  for (const button of await tape.getByRole("button").all()) {
    const bounds = await button.boundingBox();
    expect(bounds!.width).toBeGreaterThanOrEqual(44);
    expect(bounds!.height).toBeGreaterThanOrEqual(44);
  }
});

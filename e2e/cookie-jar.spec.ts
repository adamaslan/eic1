import { expect, test } from "@playwright/test";

// Cookie Jar release checks (T-2, T-4, T-6 subset, I-1, I-3, I-6). Synthetic data only.
const PROTECTED = { "eic.vault-lock": "marker-123", "eic.vault-activity.v1": '{"id":"s","at":1}' };

test("lists what the device remembers, with Turnstile disclosed and no third-party request on load", async ({ page }) => {
  const external: string[] = [];
  page.on("request", (req) => { if (/challenges\.cloudflare\.com/.test(req.url())) external.push(req.url()); });
  await page.goto("/cookie-jar");
  await expect(page.getByText("Cookie Jar & Privacy").first()).toBeVisible();
  await expect(page.getByText("Cloudflare Turnstile").first()).toBeVisible();
  await expect(page.getByText(/Measurement: Off/)).toBeVisible();
  expect(external).toEqual([]);
});

test("Clear preferences removes preferences and leaves security keys byte-identical (I-1)", async ({ page }) => {
  await page.goto("/cookie-jar");
  await page.evaluate((protectedKeys) => {
    for (const [k, v] of Object.entries(protectedKeys)) localStorage.setItem(k, v);
    localStorage.setItem("eic.display.v1", "{}");
    localStorage.setItem("eic.desk.v1", "{}");
    sessionStorage.setItem("eic.boot.shown.v1", "1");
  }, PROTECTED);
  await page.getByRole("button", { name: "Clear preferences" }).click();
  await expect(page.getByRole("status")).toContainText("Cleared");
  const after = await page.evaluate(() => ({
    lock: localStorage.getItem("eic.vault-lock"), activity: localStorage.getItem("eic.vault-activity.v1"),
    display: localStorage.getItem("eic.display.v1"), desk: localStorage.getItem("eic.desk.v1"), boot: sessionStorage.getItem("eic.boot.shown.v1"),
  }));
  expect(after).toEqual({ lock: PROTECTED["eic.vault-lock"], activity: PROTECTED["eic.vault-activity.v1"], display: null, desk: null, boot: null });
});

test("optional purposes are off by default and tab-only mode never writes localStorage (I-3, I-7)", async ({ page }) => {
  await page.goto("/cookie-jar");
  const sticker = page.locator("button[aria-pressed]").first();
  await sticker.click();
  expect(await page.evaluate(() => localStorage.getItem("eic.desk.v1") ?? sessionStorage.getItem("eic.desk.v1"))).toBeNull();
  await page.getByRole("radio", { name: /Pocket universe/ }).check();
  await page.getByRole("checkbox", { name: "Desk memory" }).check();
  await page.locator("button[aria-pressed]").nth(1).click();
  const where = await page.evaluate(() => ({ local: localStorage.getItem("eic.desk.v1"), session: sessionStorage.getItem("eic.desk.v1") }));
  expect(where.local).toBeNull();
  expect(where.session).not.toBeNull();
});

test("postcard preview is the exact payload, and nothing is kept until Accept (I-6)", async ({ page }) => {
  await page.goto("/cookie-jar");
  await page.getByRole("radio", { name: /Friends' clubhouse/ }).check();
  await page.getByLabel("Message").fill("hello from my room");
  const payload = await page.getByLabel("Postcard payload").innerText();
  expect(Object.keys(JSON.parse(payload)).sort()).toEqual(["avatarId", "format", "message", "v", "wallpaper"]);
  await page.getByLabel("Paste it here").fill(payload);
  await page.getByRole("button", { name: "Open it" }).click();
  await expect(page.getByText("Nothing is saved yet")).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("eic.postcards.v1"))).toBeNull();
  await page.getByRole("checkbox", { name: "Postcards you accepted" }).check();
  await page.getByRole("button", { name: "Accept and keep" }).click();
  expect(await page.evaluate(() => localStorage.getItem("eic.postcards.v1"))).toContain("hello from my room");
  await page.getByLabel("Paste it here").fill(payload.replace("}", ',"handle":"me"}'));
  await page.getByRole("button", { name: "Open it" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "extra data" })).toBeVisible();
});

test("storage-blocked browsers are told the truth (I-8)", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", { get() { throw new Error("denied"); } });
  });
  await page.goto("/cookie-jar");
  await expect(page.getByRole("alert").filter({ hasText: "blocked storage" })).toBeVisible();
  await page.getByRole("radio", { name: "Friends' clubhouse" }).check();
  await expect(page.getByRole("alert").filter({ hasText: "blocked storage" })).toBeVisible();
});

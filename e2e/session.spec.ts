import { expect, test, type Page } from "@playwright/test";
const EIGHT_HOURS = 8 * 60 * 60_000;
const passphrase = "eight-hour-session-test-only";
async function create(page: Page) {
  await page.goto("/unlock");
  await page.getByLabel("Passphrase", { exact: true }).fill(passphrase);
  await page.getByLabel("Confirm passphrase").fill(passphrase);
  await page.getByRole("button", { name: "Create vault" }).click();
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
  await page.goto("/compose");
  await page.getByRole("radio", { name: "Marketplace listing" }).check();
  await page.getByLabel("Title").fill("eight-hour persisted data");
  await page.getByRole("button", { name: /Encrypt & save/ }).click();
  await expect(page.getByText("eight-hour persisted data")).toBeVisible();
}
async function savedDeadline(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("veil-session", 1);
      req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
    });
    try {
      return await new Promise<number | null>((resolve, reject) => {
        const req = db.transaction("session").objectStore("session").get("current");
        req.onsuccess = () => resolve(req.result?.expiresAt ?? null); req.onerror = () => reject(req.error);
      });
    } finally { db.close(); }
  });
}
test("reload, new tab and activity preserve the same eight-hour deadline; manual lock clears it", async ({ page, context }, info) => {
  const errors: string[] = [];
  page.on("pageerror", e => errors.push(String(e)));
  await page.clock.install();
  await create(page);
  const expiresAt = (await savedDeadline(page))!;
  const now = await page.evaluate(() => Date.now());
  expect(expiresAt - now).toBeGreaterThan(EIGHT_HOURS - 60_000);
  expect(expiresAt - now).toBeLessThanOrEqual(EIGHT_HOURS);
  await page.clock.setSystemTime(expiresAt - 60_000);
  await page.reload();
  await expect(page.getByText("eight-hour persisted data")).toBeVisible();
  expect(await savedDeadline(page)).toBe(expiresAt);
  await page.getByRole("link", { name: "Vault", exact: true }).click();
  await expect(page.getByText(/8 hours from unlocking/)).toBeVisible();
  await page.screenshot({ path: info.outputPath("eight-hour-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: info.outputPath("eight-hour-phone.png"), fullPage: true });
  const tab = await context.newPage();
  await tab.goto("/market");
  await expect(tab.getByText("eight-hour persisted data")).toBeVisible();
  await page.getByRole("button", { name: "Lock now", exact: true }).click();
  await expect(page).toHaveURL(/\/unlock/);
  expect(await savedDeadline(page)).toBeNull();
  await expect(tab).toHaveURL(/\/unlock/);
  await tab.reload();
  await expect(tab).toHaveURL(/\/unlock/);
  await tab.close();
  await page.goto("/market");
  await expect(page).toHaveURL(/\/unlock/);
  expect(errors).toEqual([]);
});
test("expired session locks on return even with delayed timers, and data survives re-unlock", async ({ page }) => {
  await page.clock.install();
  await create(page);
  const expiresAt = (await savedDeadline(page))!;
  // setSystemTime intentionally advances wall clock without firing queued timers.
  await page.clock.setSystemTime(expiresAt + 1);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page).toHaveURL(/\/unlock/);
  await expect.poll(() => savedDeadline(page)).toBeNull();
  await page.reload();
  await expect(page.getByText("Enter your passphrase to unlock the vault.")).toBeVisible();
  await page.getByLabel("Passphrase", { exact: true }).fill(passphrase);
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
  await page.goto("/market");
  await expect(page.getByText("eight-hour persisted data")).toBeVisible();
});

test("missed lock events: returning tab checks durable revocation before showing data", async ({ page, context }) => {
  await create(page);
  const tab = await context.newPage();
  await tab.addInitScript(() => {
    Object.defineProperty(window, "BroadcastChannel", { value: undefined });
    const add = window.addEventListener.bind(window);
    window.addEventListener = ((type: string, ...args: unknown[]) => {
      if (type !== "storage") (add as (...args: unknown[]) => void)(type, ...args);
    }) as typeof window.addEventListener;
  });
  await tab.goto("/market");
  await expect(tab.getByText("eight-hour persisted data")).toBeVisible();
  await tab.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(tab.locator("body")).toHaveCSS("visibility", "hidden");
  await page.getByRole("button", { name: "Lock", exact: true }).click();
  await expect(page).toHaveURL(/\/unlock/);
  const immediate = await tab.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    window.dispatchEvent(new Event("focus"));
    return document.body.innerText;
  });
  expect(immediate).not.toContain("eight-hour persisted data");
  await expect(tab).toHaveURL(/\/unlock/);
  await expect(tab.getByText("Enter your passphrase to unlock the vault.")).toBeVisible();
  await tab.getByLabel("Passphrase", { exact: true }).fill(passphrase);
  await tab.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(tab.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
  await tab.goto("/market");
  await expect(tab.getByText("eight-hour persisted data")).toBeVisible();
  await tab.close();
});

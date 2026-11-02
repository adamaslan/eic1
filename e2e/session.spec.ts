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
  for (let halfHour = 0; halfHour < 15; halfHour += 1) {
    await page.clock.fastForward(30 * 60_000);
    await page.mouse.click(380, 500);
  }
  await page.clock.fastForward(29 * 60_000);
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

test("idle lock stays at one hour, activity resets idle only, and delayed return locks", async ({ page }) => {
  await page.clock.install();
  await create(page);
  const deadline = await savedDeadline(page);
  await page.clock.fastForward(59 * 60_000);
  await expect(page.getByText("eight-hour persisted data")).toBeVisible();
  await page.mouse.click(380, 500);
  await page.clock.fastForward(59 * 60_000);
  await expect(page.getByText("eight-hour persisted data")).toBeVisible();
  expect(await savedDeadline(page)).toBe(deadline);
  await page.clock.fastForward(60_000);
  await expect(page).toHaveURL(/\/unlock/);
  await expect.poll(() => savedDeadline(page)).toBeNull();
  await page.getByLabel("Passphrase", { exact: true }).fill(passphrase);
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
  await page.goto("/market");
  // A hard load resumes the vault asynchronously. Do not take the clock origin
  // from navigation completion before the unlocked route has actually rendered.
  await expect(page.getByText("eight-hour persisted data")).toBeVisible();
  // The exact 60-minute boundary is covered above. Here timers are deliberately
  // not fired: a clearly overdue wall clock must be checked on the return event.
  await page.clock.setSystemTime((await page.evaluate(() => Date.now())) + 61 * 60_000);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page).toHaveURL(/\/unlock/);
});

test("blocked localStorage never resumes a saved vault even when IndexedDB works", async ({ page }) => {
  await create(page);
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => { throw new DOMException("blocked", "SecurityError"); };
  });
  await page.reload();
  await expect(page).toHaveURL(/\/unlock/);
  await expect(page.getByText("eight-hour persisted data")).toHaveCount(0);
  await expect.poll(() => savedDeadline(page)).toBeNull();
});

// Resume races. The returning tab has no lock listeners, and its resume decrypt is held open.
async function gatedTab(context: import("@playwright/test").BrowserContext) {
  const tab = await context.newPage();
  await tab.addInitScript(() => {
    Object.defineProperty(window, "BroadcastChannel", { value: undefined });
    const add = window.addEventListener.bind(window);
    window.addEventListener = ((type: string, ...args: unknown[]) => {
      if (type !== "storage") (add as (...args: unknown[]) => void)(type, ...args);
    }) as typeof window.addEventListener;
    const w = window as unknown as { __release: () => void; __armFlip: boolean; __held: number; __flipAfter: number; __reads: (string | null)[] };
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => { open = resolve; });
    // Every resume run parks at its first decrypt. React dev mode starts two runs (only the last is
    // adopted); a minified build starts one. __held counts them, so no code name is needed.
    let heldDecrypts = 0;
    const decrypt = SubtleCrypto.prototype.decrypt;
    SubtleCrypto.prototype.decrypt = async function (this: SubtleCrypto, ...args: Parameters<typeof decrypt>) {
      heldDecrypts += 1; w.__held = heldDecrypts;
      await gate;
      return decrypt.apply(this, args);
    };
    // Once armed, log every read of the lock marker. With all N runs past their loadSession reads, the
    // first N reads are the runs' final comparisons and read N+1 is adoption (setVault). The marker is
    // flipped right after read N, as another tab's lock would, with no storage event. The test asserts
    // this order from the log, so a miscount fails loudly instead of passing by luck.
    const getItem = Storage.prototype.getItem;
    const setItem = Storage.prototype.setItem;
    w.__reads = [];
    Storage.prototype.getItem = function (this: Storage, key: string) {
      const value = getItem.call(this, key);
      if (key === "eic.vault-lock" && w.__armFlip) {
        w.__reads.push(value);
        if (w.__reads.length === w.__flipAfter) setItem.call(this, key, `other-tab:${Math.random()}`);
      }
      return value;
    };
    w.__release = open;
  });
  return tab;
}
test("lock from another tab while resume decrypt is in flight never shows decrypted data", async ({ page, context }) => {
  await create(page);
  const tab = await gatedTab(context);
  await tab.goto("/market");
  await expect(tab.getByText("eight-hour persisted data")).toHaveCount(0);
  await page.getByRole("button", { name: "Lock", exact: true }).click();
  await expect(page).toHaveURL(/\/unlock/);
  await tab.evaluate(() => (window as unknown as { __release: () => void }).__release());
  await expect(tab).toHaveURL(/\/unlock/);
  await expect(tab.getByText("eight-hour persisted data")).toHaveCount(0);
  await expect.poll(() => savedDeadline(tab)).toBeNull();
});
test("lock landing between resume's final check and adoption is a revocation, not a new baseline", async ({ page, context }) => {
  await create(page);
  const tab = await gatedTab(context);
  await tab.goto("/market");
  // Release only once every resume run is parked at the decrypt gate: the held count must stop changing.
  const heldNow = () => tab.evaluate(() => (window as unknown as { __held?: number }).__held ?? 0);
  await expect.poll(heldNow).toBeGreaterThan(0);
  let runs = await heldNow();
  for (let stable = 0; stable < 3; ) {
    await tab.waitForTimeout(500);
    const now = await heldNow();
    stable = now === runs ? stable + 1 : 0;
    runs = now;
  }
  await tab.evaluate((n) => {
    const w = window as unknown as { __release: () => void; __armFlip: boolean; __flipAfter: number };
    w.__flipAfter = n;
    w.__armFlip = true;
    w.__release();
  }, runs);
  await expect(tab).toHaveURL(/\/unlock/);
  await expect(tab.getByText("Enter your passphrase to unlock the vault.")).toBeVisible();
  await expect(tab.getByText("eight-hour persisted data")).toHaveCount(0);
  await expect.poll(() => savedDeadline(tab)).toBeNull();
  // The flip landed between the last resume comparison and adoption: N reads saw the original marker,
  // the next read (adoption) saw the other tab's lock.
  const reads = await tab.evaluate(() => (window as unknown as { __reads: (string | null)[] }).__reads);
  expect(reads.length).toBeGreaterThan(runs);
  expect(reads.slice(0, runs).every((value) => value === reads[0])).toBe(true);
  expect(reads[runs]).toMatch(/^other-tab:/);
  // Vault data is untouched: a normal unlock still shows it.
  await tab.getByLabel("Passphrase", { exact: true }).fill(passphrase);
  await tab.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(tab.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
  const fresh = await context.newPage(); // the gated tab holds every new load's decrypt, so check on a clean page
  await fresh.goto("/market");
  await expect(fresh.getByText("eight-hour persisted data")).toBeVisible();
});

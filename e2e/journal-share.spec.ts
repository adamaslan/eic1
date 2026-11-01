import { expect, test, type Page } from "@playwright/test";

/**
 * Journal share-as-link, end to end: the owner shares ONE entry explicitly; the link carries
 * the entry in its fragment (no server); a recipient with no unlocked vault taps it, unlocks,
 * sees the entry, and only keeps it after their own explicit "Save a copy" click. An entry
 * too big for the link cap fails honestly and shares nothing.
 */

const REACT_HOOKS_SIGNATURE = /Rendered (more|fewer) hooks|error #310|error #418/i;

function watchRuntime(page: Page) {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  return { consoleErrors, pageErrors };
}

function expectCleanRuntime(watched: { consoleErrors: string[]; pageErrors: string[] }) {
  const unexpected = watched.consoleErrors.filter((text) => !text.startsWith("Failed to load resource"));
  expect(watched.pageErrors, "uncaught page errors").toEqual([]);
  expect(unexpected, "console errors").toEqual([]);
  expect([...watched.pageErrors, ...unexpected].join("\n")).not.toMatch(REACT_HOOKS_SIGNATURE);
}

test.setTimeout(240_000);

let vaultCounter = 0;

async function stubShareCapture(page: Page) {
  await page.addInitScript(() => {
    const shared: string[] = [];
    (window as unknown as { __shared: string[] }).__shared = shared;
    Object.defineProperty(navigator.clipboard, "writeText", { value: async (text: string) => { shared.push(text); }, configurable: true });
  });
}

async function createVault(page: Page, handle?: string) {
  vaultCounter += 1;
  const passphrase = `journal-share-passphrase-${Date.now()}-${vaultCounter}`;
  // Preserve an arrival link captured in this document's memory. The actual landing CTA
  // is client-side navigation; reloading / here would intentionally discard that memory.
  if (new URL(page.url()).pathname !== "/") await page.goto("/");
  await page.getByRole("link", { name: "Create or open your vault" }).first().click();
  await page.getByLabel("Passphrase", { exact: true }).fill(passphrase);
  await page.getByLabel("Confirm passphrase").fill(passphrase);
  await page.getByRole("button", { name: "Create vault" }).click();
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
  if (handle) {
    await page.goto("/connections");
    await page.getByLabel("Handle").fill(handle);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Handle saved.")).toBeVisible();
  }
}

async function lastSharedLink(page: Page): Promise<string> {
  const text = await page.evaluate(() => (window as unknown as { __shared: string[] }).__shared.at(-1));
  expect(text).toBeTruthy();
  return text!;
}

test("a shared journal entry opens for the recipient and saves only on their explicit click", async ({ browser }) => {
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  const alice = await aliceContext.newPage();
  const bob = await bobContext.newPage();
  const watchedAlice = watchRuntime(alice);
  const watchedBob = watchRuntime(bob);
  await stubShareCapture(alice);

  // Alice writes two entries and shares one of them, explicitly.
  await createVault(alice, "alice");
  await alice.goto("/tools/journal");
  await alice.getByLabel("What is on your mind?").fill("Bridge at dawn, worth the cold");
  await alice.getByRole("button", { name: "🔒 Save entry" }).click();
  await expect(alice.getByText("Entries (1)")).toBeVisible();
  await alice.getByLabel("What is on your mind?").fill("Private note that stays mine");
  await alice.getByRole("button", { name: "🔒 Save entry" }).click();
  await expect(alice.getByText("Entries (2)")).toBeVisible();

  const bridgeRow = alice.locator("li", { hasText: "Bridge at dawn, worth the cold" });
  await bridgeRow.getByRole("button", { name: "Share" }).click();
  await expect(alice.getByText(/Link copied\. It opens the app and shows this entry/)).toBeVisible();
  const link = await lastSharedLink(alice);
  expect(link).toContain("#import=");

  // Bob taps the link with NO unlocked vault: the link waits, he unlocks, then sees the entry.
  // FAST-PATH REGRESSION: the payload must be parked at module evaluation, before first
  // paint - a fast tapper who goes straight into vault creation cannot outrun it.
  // DOMContentLoaded guarantees deferred module scripts ran; React effects have NOT run at
  // this point, so an effect-based stash would deterministically fail here.
  await bob.goto(link, { waitUntil: "domcontentloaded" });
  // Journal text remains in document memory only; it is removed from the address bar and
  // never written to sessionStorage, including either pending-link slot.
  await expect.poll(() => new URL(bob.url()).hash).toBe("");
  expect(await bob.evaluate(() => window.sessionStorage.getItem("eic.arrivalHash"))).toBeNull();
  expect(await bob.evaluate(() => window.sessionStorage.getItem("eic.pendingLink.v2.post"))).toBeNull();
  await createVault(bob);
  await expect(bob.getByText("A friend shared a journal entry")).toBeVisible();
  await expect(bob.getByText("Bridge at dawn, worth the cold")).toBeVisible();
  await expect(bob.getByText(/@alice/)).toBeVisible();

  // Only the shared entry is visible; the unshared one never left alice's vault.
  await expect(bob.getByText("Private note that stays mine")).toHaveCount(0);

  // Nothing is in bob's journal until he explicitly keeps a copy.
  await bob.getByRole("button", { name: "Save a copy to my journal" }).click();
  await expect(bob.getByText(/A copy of @alice's entry is in your journal/)).toBeVisible();
  await bob.goto("/tools/journal");
  await expect(bob.getByText("Bridge at dawn, worth the cold")).toBeVisible();
  await expect(bob.getByText("Entries (1)")).toBeVisible();

  // Consumed means consumed: a reload must not resurface the saved link.
  await bob.reload();
  await expect(bob.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
  await expect(bob.getByText("A friend shared a journal entry")).toHaveCount(0);

  expectCleanRuntime(watchedAlice);
  expectCleanRuntime(watchedBob);
  await aliceContext.close();
  await bobContext.close();
});

test("an entry too big for a link fails honestly and shares nothing", async ({ page }) => {
  const watched = watchRuntime(page);
  await stubShareCapture(page);
  await createVault(page, "carol");
  await page.goto("/tools/journal");
  await page.getByLabel("What is on your mind?").fill("界".repeat(5000));
  await page.getByRole("button", { name: "🔒 Save entry" }).click();
  await expect(page.getByText("Entries (1)")).toBeVisible();
  await page.getByRole("button", { name: "Share" }).click();
  await expect(page.getByText("That entry is too big for a link. Nothing was shared.")).toBeVisible();
  const sharedCount = await page.evaluate(() => (window as unknown as { __shared: string[] }).__shared.length);
  expect(sharedCount).toBe(0);
  expectCleanRuntime(watched);
});

test("a long unbroken shared entry stays bounded and its actions stay reachable on a phone", async ({ browser }) => {
  test.skip(browser.browserType().name() !== "chromium", "chromium only");
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const alice = await aliceContext.newPage();
  const bob = await bobContext.newPage();
  const watchedBob = watchRuntime(bob);
  await stubShareCapture(alice);

  // One 4000-char unbroken token: fits the link cap (ASCII), breaks naive dialog layouts.
  const longToken = "x".repeat(4000);
  await createVault(alice, "alice");
  await alice.goto("/tools/journal");
  await alice.getByLabel("What is on your mind?").fill(longToken);
  await alice.getByRole("button", { name: "🔒 Save entry" }).click();
  await expect(alice.getByText("Entries (1)")).toBeVisible();
  await alice.locator("li", { hasText: longToken.slice(0, 40) }).getByRole("button", { name: "Share" }).click();
  await expect(alice.getByText(/Link copied/)).toBeVisible();
  const link = await lastSharedLink(alice);

  await bob.goto(link, { waitUntil: "domcontentloaded" });
  await createVault(bob);
  await expect(bob.getByText("A friend shared a journal entry")).toBeVisible();
  expect(new URL(bob.url()).hash).toBe("");

  // The preview is a bounded scroll region, and both actions are reachable without
  // scrolling the page - the dialog never grows past the viewport.
  const preview = bob.locator("p", { hasText: longToken.slice(0, 60) }).first();
  await expect(preview).toBeVisible();
  const metrics = await preview.evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight }));
  expect(metrics.scroll, "long entry must overflow its bounded preview").toBeGreaterThan(metrics.client);
  const saveButton = bob.getByRole("button", { name: "Save a copy to my journal" });
  await expect(saveButton).toBeVisible();
  await expect(bob.getByRole("button", { name: "Not now" })).toBeVisible();
  const saveBox = await saveButton.boundingBox();
  expect(saveBox!.y + saveBox!.height, "Save button must sit inside the 390x844 viewport").toBeLessThanOrEqual(844);

  await saveButton.click();
  await expect(bob.getByText(/A copy of @alice's entry is in your journal/)).toBeVisible();
  expectCleanRuntime(watchedBob);
  await aliceContext.close();
  await bobContext.close();
});

test("a dismissed shared entry stays dismissed across a reload", async ({ browser }) => {
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  const alice = await aliceContext.newPage();
  const bob = await bobContext.newPage();
  await stubShareCapture(alice);

  await createVault(alice, "alice");
  await alice.goto("/tools/journal");
  await alice.getByLabel("What is on your mind?").fill("Bridge at dawn, worth the cold");
  await alice.getByRole("button", { name: "🔒 Save entry" }).click();
  await expect(alice.getByText("Entries (1)")).toBeVisible();
  await alice.locator("li").first().getByRole("button", { name: "Share" }).click();
  await expect(alice.getByText(/Link copied/)).toBeVisible();
  const link = await lastSharedLink(alice);

  await bob.goto(link, { waitUntil: "domcontentloaded" });
  await createVault(bob);
  await expect(bob.getByText("A friend shared a journal entry")).toBeVisible();
  await bob.getByRole("button", { name: "Not now" }).click();
  await expect(bob.getByText("A friend shared a journal entry")).toHaveCount(0);
  await bob.reload();
  await expect(bob.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
  await expect(bob.getByText("A friend shared a journal entry")).toHaveCount(0);
  // Nothing was kept: bob's journal is empty.
  await bob.goto("/tools/journal");
  await expect(bob.getByText("No entries yet.")).toBeVisible();

  await aliceContext.close();
  await bobContext.close();
});

test("a fast tap with storage denied still keeps the link (in-memory retention)", async ({ browser }) => {
  // Deny sessionStorage before any app code runs: private-mode degradation must not lose
  // the tapped link. The tap path is client-side (landing Link -> unlock -> create), so
  // module memory retains the payload until the dialog consumes it.
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  const alice = await aliceContext.newPage();
  const bob = await bobContext.newPage();
  await stubShareCapture(alice);
  await bob.addInitScript(() => {
    const denied = {
      getItem: () => { throw new Error("denied"); },
      setItem: () => { throw new Error("denied"); },
      removeItem: () => { throw new Error("denied"); },
      clear: () => undefined,
      key: () => null,
      length: 0,
    };
    Object.defineProperty(window, "sessionStorage", { get: () => denied });
  });

  await createVault(alice, "alice");
  await alice.goto("/tools/journal");
  await alice.getByLabel("What is on your mind?").fill("Bridge at dawn, worth the cold");
  await alice.getByRole("button", { name: "🔒 Save entry" }).click();
  await expect(alice.getByText("Entries (1)")).toBeVisible();
  await alice.locator("li").first().getByRole("button", { name: "Share" }).click();
  await expect(alice.getByText(/Link copied/)).toBeVisible();
  const link = await lastSharedLink(alice);

  // Fast tap, no settling wait, then straight into vault creation by CLICKING THROUGH -
  // the real tap path (client-side navigation), not a hard reload.
  await bob.goto(link, { waitUntil: "domcontentloaded" });
  await bob.getByRole("link", { name: "Create or open your vault" }).first().click();
  const passphrase = `denied-storage-${Date.now()}`;
  await bob.getByLabel("Passphrase", { exact: true }).fill(passphrase);
  await bob.getByLabel("Confirm passphrase").fill(passphrase);
  await bob.getByRole("button", { name: "Create vault" }).click();
  await expect(bob.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
  await expect(bob.getByText("A friend shared a journal entry")).toBeVisible();
  await bob.getByRole("button", { name: "Save a copy to my journal" }).click();
  await expect(bob.getByText(/A copy of @alice's entry is in your journal/)).toBeVisible();

  await aliceContext.close();
  await bobContext.close();
});

test("a damaged journal payload shows the honest damaged state, never a save affordance", async ({ page }) => {
  const watched = watchRuntime(page);
  await createVault(page, "dana");
  // type marker present (routes it to the journal dialog) but the bundle is incomplete.
  const damaged = JSON.stringify({ format: "eic-share", version: 1, type: "journal-entry" });
  const link = `/#import=${Buffer.from(damaged).toString("base64url")}`;
  await page.goto(link);
  await expect(page.getByText("A friend shared a journal entry")).toBeVisible();
  await expect(page.getByText("That shared entry is damaged. Ask your friend for a fresh link.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save a copy to my journal" })).toHaveCount(0);
  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.getByText("A friend shared a journal entry")).toHaveCount(0);
  expectCleanRuntime(watched);
});

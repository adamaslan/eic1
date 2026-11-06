import { expect, test, type Page } from "@playwright/test";
import { unexpectedConsoleErrors, watchRuntime, type WatchedRuntime } from "./fixtures/runtime-watch";

/**
 * Journal share-as-link, end to end: the owner shares ONE entry explicitly; the link carries
 * the entry in its fragment (no server); a recipient with no unlocked vault taps it, unlocks,
 * sees the entry, and only keeps it after their own explicit "Save a copy" click. An entry
 * too big for the link cap fails honestly and shares nothing.
 */

const REACT_HOOKS_SIGNATURE = /Rendered (more|fewer) hooks|error #310|error #418/i;

function expectCleanRuntime(watched: WatchedRuntime) {
  const unexpected = unexpectedConsoleErrors(watched.consoleErrors);
  expect(watched.pageErrors, "uncaught page errors").toEqual([]);
  expect(unexpected, "console errors").toEqual([]);
  expect([...watched.pageErrors, ...unexpected.map((entry) => entry.text)].join("\n")).not.toMatch(REACT_HOOKS_SIGNATURE);
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

// Clipboard blocked, share sheet + download captured: exercises the blocked-copy ladder
// without anything leaving the page. __shared catches navigator.share text; __downloads
// catches the exact text of every blob handed to a download.
async function stubShareBlocked(page: Page) {
  await page.addInitScript(() => {
    const shared: string[] = [];
    (window as unknown as { __shared: string[] }).__shared = shared;
    Object.defineProperty(navigator.clipboard, "writeText", {
      value: async () => { throw new DOMException("Write permission denied.", "NotAllowedError"); },
      configurable: true,
    });
    Object.defineProperty(navigator, "share", {
      value: async (data: { text?: string }) => { shared.push(data.text ?? ""); },
      configurable: true,
    });
    const downloads: string[] = [];
    (window as unknown as { __downloads: string[] }).__downloads = downloads;
    const originalCreateObjectURL = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob: Blob) => {
      void blob.text().then((text) => downloads.push(text));
      return originalCreateObjectURL(blob);
    };
  });
}

function decodeSharedEntryText(link: string): Promise<string> {
  const payload = link.split("#import=")[1];
  const base64 = payload.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const bundle = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(padded), (c) => c.charCodeAt(0)))) as { entry: { text: string } };
  return Promise.resolve(bundle.entry.text);
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
  const watchedAlice = await watchRuntime(alice);
  const watchedBob = await watchRuntime(bob);
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
  const watched = await watchRuntime(page);
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

test("a blocked automatic copy offers explicit next steps, with the privacy warning before the choices", async ({ page }) => {
  const watched = await watchRuntime(page);
  await stubShareBlocked(page);
  await createVault(page, "dana");
  await page.goto("/tools/journal");
  await page.getByLabel("What is on your mind?").fill("Fallback ladder entry text");
  await page.getByRole("button", { name: "🔒 Save entry" }).click();
  await expect(page.getByText("Entries (1)")).toBeVisible();

  await page.getByRole("button", { name: "Share" }).click();
  await expect(page.getByText("Your browser blocked the automatic copy - the link was not copied. Choose a next step, or do nothing.")).toBeVisible();
  const warning = page.getByText("Either choice hands out this entry as readable text - anyone who gets the link can read it.");
  await expect(warning).toBeVisible();
  const sheetButton = page.getByRole("button", { name: "Open share sheet" });
  const fileButton = page.getByRole("button", { name: "Download as file" });
  await expect(sheetButton).toBeVisible();
  await expect(fileButton).toBeVisible();

  // The warning comes BEFORE the choices in the document, never after.
  const warningBeforeChoices = await page.evaluate(() => {
    const paragraphs = [...document.querySelectorAll("p")];
    const warningNode = paragraphs.find((p) => p.textContent?.includes("Either choice hands out this entry as readable text"));
    const buttons = [...document.querySelectorAll("button")];
    const choiceNode = buttons.find((b) => b.textContent === "Open share sheet");
    return warningNode && choiceNode ? Boolean(warningNode.compareDocumentPosition(choiceNode) & Node.DOCUMENT_POSITION_FOLLOWING) : false;
  });
  expect(warningBeforeChoices).toBe(true);

  // Nothing was copied; the explicit download choice hands out exactly the built link.
  expect(await page.evaluate(() => (window as unknown as { __shared: string[] }).__shared.length)).toBe(0);
  await page.evaluate(() => {
    const revoked: string[] = [];
    (window as unknown as { __revoked: string[] }).__revoked = revoked;
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = (url: string) => { revoked.push(url); revoke(url); };
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      click.call(this);
      (window as unknown as { __downloadAnchor: HTMLAnchorElement }).__downloadAnchor = this;
      window.setTimeout(() => {
        (window as unknown as { __retainedForBrowser: boolean }).__retainedForBrowser = this.isConnected && revoked.length === 0;
      }, 0);
    };
  });
  await fileButton.click();
  await expect(page.getByText("Download requested. The file holds the link as readable text.")).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __retainedForBrowser: boolean }).__retainedForBrowser)).toBe(true);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __revoked: string[] }).__revoked.length)).toBe(1);
  expect(await page.evaluate(() => (window as unknown as { __downloadAnchor: HTMLAnchorElement }).__downloadAnchor.isConnected)).toBe(false);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __downloads: string[] }).__downloads.length)).toBe(1);
  const downloaded = await page.evaluate(() => (window as unknown as { __downloads: string[] }).__downloads[0]);
  expect(downloaded).toContain("#import=");
  expect(await decodeSharedEntryText(downloaded)).toBe("Fallback ladder entry text");
  expectCleanRuntime(watched);
});

test("an entry edited after a blocked copy marks the link stale and a choice rebuilds from the current text", async ({ page }) => {
  const watched = await watchRuntime(page);
  await stubShareBlocked(page);
  await createVault(page, "erin");
  await page.goto("/tools/journal");
  await page.getByLabel("What is on your mind?").fill("original text before edit");
  await page.getByRole("button", { name: "🔒 Save entry" }).click();
  await expect(page.getByText("Entries (1)")).toBeVisible();

  await page.getByRole("button", { name: "Share" }).click();
  await expect(page.getByText("Your browser blocked the automatic copy - the link was not copied. Choose a next step, or do nothing.")).toBeVisible();

  const row = page.locator("li", { hasText: "original text before edit" });
  await row.getByRole("button", { name: "Edit" }).click();
  // In edit mode the old text lives in the textarea value, so locate within the edit form.
  await page.getByLabel("Edit entry").fill("edited replacement text");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Changes saved - encrypted in this vault.")).toBeVisible();

  // The already-built link is now stale, and says so instead of handing out old text.
  await expect(page.getByText("This link still holds the entry's older text - it does not include your latest edit. Your next share or download will rebuild it from the current text.")).toBeVisible();

  // The explicit choice rebuilds from the current text first: the sheet receives the EDITED entry.
  await page.getByRole("button", { name: "Open share sheet" }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __shared: string[] }).__shared.length)).toBe(1);
  const sharedLink = await lastSharedLink(page);
  expect(await decodeSharedEntryText(sharedLink)).toBe("edited replacement text");
  // Fresh link is no longer stale once rebuilt and handed out.
  await expect(page.getByText("This link still holds the entry's older text")).toHaveCount(0);
  expectCleanRuntime(watched);
});

test("a long unbroken shared entry stays bounded and its actions stay reachable on a phone", async ({ browser }) => {
  test.skip(browser.browserType().name() !== "chromium", "chromium only");
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const alice = await aliceContext.newPage();
  const bob = await bobContext.newPage();
  const watchedBob = await watchRuntime(bob);
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
  const watched = await watchRuntime(page);
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

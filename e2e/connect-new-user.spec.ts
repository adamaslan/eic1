import { expect, test, type Page } from "@playwright/test";

/**
 * Control for the NEW-USER connect-link journey (no vault yet, no handle yet):
 * a brand-new recipient taps a connect link, creates a vault, and hits the pre-existing
 * handle gate. Documents the blocked tap, the honest error, and the safe recovery
 * (set a handle, re-tap the link, explicit connect). No automatic connect, import,
 * or disclosure happens anywhere on this path. Branch-agnostic: every string and
 * control here exists on main; run on both trees to prove the edge pre-dates the
 * profile-preview diff.
 */

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
  const passphrase = `connect-new-user-passphrase-${Date.now()}-${vaultCounter}`;
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
  const link = text!.split(/\s+/).find((token) => token.startsWith("http"));
  expect(link).toBeTruthy();
  return link!;
}

test("new recipient hits the handle gate, sees an honest error, and recovers via re-tap", async ({ browser }) => {
  const ownerContext = await browser.newContext();
  const friendContext = await browser.newContext();
  const owner = await ownerContext.newPage();
  const friend = await friendContext.newPage();
  await stubShareCapture(owner);

  await createVault(owner, "ada-owner");
  await owner.goto("/connections");
  await owner.getByRole("button", { name: "Text my connect link" }).click();
  await expect(owner.getByText(/Connect link copied/)).toBeVisible();
  const link = await lastSharedLink(owner);
  expect(link).toContain("#connect=");

  // New user: lands on the link with no vault, creates one (no handle yet).
  await friend.goto(link, { waitUntil: "domcontentloaded" });
  await createVault(friend);
  await expect(friend.getByText("A friend wants to connect")).toBeVisible();

  // The blocked path: connecting without a handle fails honestly, nothing connects.
  await friend.getByRole("button", { name: "Add and open chat" }).click();
  await expect(friend.getByText(/Choose a handle/)).toBeVisible();
  await friend.getByRole("button", { name: "Close" }).click();
  // Client-side nav, not a reload: a reload re-offers the stashed link over the page.
  await friend.getByRole("link", { name: "Connections", exact: true }).click();
  await expect(friend.getByText("@ada-owner")).not.toBeVisible();

  // Recovery: set a handle, re-tap the same link, connect explicitly.
  await friend.getByLabel("Handle").fill("fynn-friend");
  await friend.getByRole("button", { name: "Save", exact: true }).click();
  await expect(friend.getByText("Handle saved.")).toBeVisible();
  await friend.goto(link, { waitUntil: "domcontentloaded" });
  await expect(friend.getByText("A friend wants to connect")).toBeVisible();
  await friend.getByRole("button", { name: "Add and open chat" }).click();
  await expect(friend).toHaveURL(/\/chat\//);
  await friend.getByRole("link", { name: "Connections", exact: true }).click();
  await expect(friend).toHaveURL(/\/connections/);
  await expect(friend.getByText("@ada-owner").first()).toBeVisible();

  await ownerContext.close();
  await friendContext.close();
});

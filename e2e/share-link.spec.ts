import { expect, test, type Page, type Browser } from "@playwright/test";
import { watchRuntime } from "./fixtures/runtime-watch";

/**
 * Post share-link (#import=) recipient coverage. A share-one-post link carries the sealed
 * post in its URL fragment; the recipient's app offers the import in a modal (root.tsx
 * ShareLinkImport), writes the post into THEIR vault, and re-opening the same link must
 * stay idempotent. None of that browser path had e2e coverage - unit tests cover bundle
 * build/parse, but the modal only exists on a real hard load with the hash.
 *
 * Two isolated browser contexts stand in for the sender and the recipient (separate
 * IndexedDB, no server: the post never leaves the link). The error bar is identical to
 * the transition smoke: zero console errors and zero uncaught page errors in BOTH
 * contexts, filtering only favicon-style failed resource loads.
 */

function expectCleanRuntime(watched: { consoleErrors: string[]; pageErrors: string[] }) {
  // Failed resource loads (e.g. favicon) are network noise, not runtime failures.
  const unexpected = watched.consoleErrors.filter((text) => !text.startsWith("Failed to load resource"));
  expect(watched.pageErrors, "uncaught page errors").toEqual([]);
  expect(unexpected, "console errors").toEqual([]);
}

async function createVault(page: Page, passphrase: string) {
  await page.goto("/");
  await page.getByRole("link", { name: "Create or open your vault" }).first().click();
  await page.getByLabel("Passphrase", { exact: true }).fill(passphrase);
  await page.getByLabel("Confirm passphrase").fill(passphrase);
  await page.getByRole("button", { name: "Create vault" }).click();
  // Vault creation runs the key derivation; the unlocked landing nav confirms completion.
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
}

test("post share link imports into a second vault and reopening stays idempotent", async ({ browser }) => {
  const title = `share link round trip ${Date.now()}`;

  // Sender: vault, listing, then the item page's "Link" button copies the share link.
  const contextA = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const pageA = await contextA.newPage();
  const watchedA = await watchRuntime(pageA);
  await createVault(pageA, `share-sender-${Date.now()}`);
  // Sharing requires a handle (the item page refuses without one).
  await pageA.goto("/connections");
  await pageA.getByLabel("Handle").fill("sender");
  await pageA.getByRole("button", { name: "Save" }).click();
  await expect(pageA.getByText("Handle saved.")).toBeVisible();
  await pageA.getByRole("link", { name: "+ Post" }).click();
  await pageA.getByRole("radio", { name: "Marketplace listing" }).check();
  await pageA.getByLabel("Title").fill(title);
  await pageA.getByLabel("Notes").fill("travels inside the link itself");
  await pageA.getByRole("button", { name: /Encrypt & save/ }).click();
  await pageA.waitForURL("**/market");
  await pageA.getByText(title).click();
  await pageA.waitForURL("**/item/**");
  await pageA.getByRole("button", { name: "↗ Link" }).click();
  await expect(pageA.getByText(/Link copied/)).toBeVisible();
  const link = await pageA.evaluate(() => navigator.clipboard.readText());
  expect(link).toContain("#import=");

  // Recipient: a second, isolated vault. A hard load of the link resumes their session
  // and must surface the import offer carrying the sender's claim.
  const contextB = await browser.newContext();
  const pageB = await contextB.newPage();
  const watchedB = await watchRuntime(pageB);
  await createVault(pageB, `share-recipient-${Date.now()}`);
  // Importing also requires a handle (importShareBundle rejects handle-less vaults so it
  // can refuse self-imports and track the connection). A hard load of the link then
  // resumes the recipient's session and surfaces the import offer.
  await pageB.goto("/connections");
  await pageB.getByLabel("Handle").fill("recipient");
  await pageB.getByRole("button", { name: "Save" }).click();
  await expect(pageB.getByText("Handle saved.")).toBeVisible();
  await pageB.goto(link);
  await expect(pageB.getByText("A friend shared a post with you")).toBeVisible();
  await expect(pageB.getByText("This link carries a post from a friend. Import it into your vault?")).toBeVisible();
  await pageB.getByRole("button", { name: "Import", exact: true }).click();
  // First contact: the bundle also carries the sender's verified chat key, so a fresh
  // recipient gets the key-saved message (the post imports in the same pass).
  await expect(pageB.getByRole("status")).toContainText("Chat unlocked with @sender");
  await pageB.getByRole("button", { name: "Close" }).click();
  // The post now lives in the recipient's vault and renders offline.
  await pageB.goto("/market");
  await expect(pageB.getByText(title)).toBeVisible();

  // Re-opening the same link must not duplicate the post. Re-import is the designed
  // refresh path (sharing.ts re-seals over the existing id so owner edits propagate),
  // so the honest idempotence guarantee is "0 new" and exactly one copy in the vault.
  await pageB.goto(link);
  await expect(pageB.getByText("A friend shared a post with you")).toBeVisible();
  await pageB.getByRole("button", { name: "Import", exact: true }).click();
  await expect(pageB.getByRole("status")).toContainText("Imported from @sender: 0 new");
  await pageB.getByRole("button", { name: "Close" }).click();
  await pageB.goto("/market");
  await expect(pageB.getByText(title)).toHaveCount(1);

  expectCleanRuntime(watchedA);
  expectCleanRuntime(watchedB);
  await contextA.close();
  await contextB.close();
});

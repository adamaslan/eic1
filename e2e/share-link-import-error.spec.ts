import { expect, test, type Page } from "@playwright/test";
import { watchRuntime } from "./fixtures/runtime-watch";

/**
 * Share-link import error honesty. Before the fix in app/root.tsx, a recipient WITHOUT a
 * saved handle who clicked Import got no feedback at all: importShareBundle throws
 * "Choose a handle before importing.", the catch set `message`, but the modal rendered
 * only the bundleText prompt branch and never displayed it. The user saw a dead button.
 *
 * The fix renders the error inside the prompt branch (preserving bundleText, so the link
 * is not lost) and this spec proves the recoverable path end to end: honest error shown,
 * then after saving a handle the SAME link imports successfully.
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
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
}

async function saveHandle(page: Page, handle: string) {
  await page.goto("/connections");
  await page.getByLabel("Handle").fill(handle);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Handle saved.")).toBeVisible();
}

test("handle-less recipient sees an honest import error and can still import the same link", async ({ browser }) => {
  const title = `share link error honesty ${Date.now()}`;

  // Sender: vault, handle, listing, share link.
  const contextA = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const pageA = await contextA.newPage();
  const watchedA = await watchRuntime(pageA);
  await createVault(pageA, `share-err-sender-${Date.now()}`);
  await saveHandle(pageA, "sender");
  await pageA.getByRole("link", { name: "+ Post" }).click();
  await pageA.getByRole("radio", { name: "Marketplace listing" }).check();
  await pageA.getByLabel("Title").fill(title);
  await pageA.getByLabel("Notes").fill("error honesty check");
  await pageA.getByRole("button", { name: /Encrypt & save/ }).click();
  await pageA.waitForURL("**/market");
  await pageA.getByText(title).click();
  await pageA.waitForURL("**/item/**");
  await pageA.getByRole("button", { name: "↗ Link" }).click();
  await expect(pageA.getByText(/Link copied/)).toBeVisible();
  const link = await pageA.evaluate(() => navigator.clipboard.readText());
  expect(link).toContain("#import=");

  // Recipient WITHOUT a handle: Import must fail with a visible, honest error - and the
  // modal must keep the offer (bundle preserved) instead of swallowing it.
  const contextB = await browser.newContext();
  const pageB = await contextB.newPage();
  const watchedB = await watchRuntime(pageB);
  await createVault(pageB, `share-err-recipient-${Date.now()}`);
  await pageB.goto(link);
  await expect(pageB.getByText("A friend shared a post with you")).toBeVisible();
  await pageB.getByRole("button", { name: "Import", exact: true }).click();
  await expect(pageB.getByRole("alert")).toContainText("Choose a handle before importing.");
  // The offer is still there (not dismissed, not replaced) - nothing was eaten.
  await expect(pageB.getByText("Import it into your vault?")).toBeVisible();

  // Recover: the modal is global, so the user closes it ("Not now" consumes the URL
  // hash), saves a handle, and re-taps the original text - the same link then imports.
  await pageB.getByRole("button", { name: "Not now" }).click();
  await expect(pageB.getByText("A friend shared a post with you")).toHaveCount(0);
  await saveHandle(pageB, "recipient");
  await pageB.goto(link);
  await pageB.getByRole("button", { name: "Import", exact: true }).click();
  // First contact imports the post AND saves the sender's verified key - the
  // confirmation must name both, with honest counts (not only "Chat unlocked").
  await expect(pageB.getByRole("status")).toContainText("Imported from @sender: 1 new, 0 updated");
  await expect(pageB.getByRole("status")).toContainText("Chat unlocked with @sender");
  await pageB.getByRole("button", { name: "Close" }).click();
  await pageB.goto("/market");
  await expect(pageB.getByText(title)).toBeVisible();

  expectCleanRuntime(watchedA);
  expectCleanRuntime(watchedB);
  await contextA.close();
  await contextB.close();
});

import { expect, test, type Page } from "@playwright/test";
import { watchRuntime } from "./fixtures/runtime-watch";

/**
 * Returning-user unlock coverage. /unlock gates every returning user's encrypted data, and
 * it previously had no end-to-end coverage: the transition smoke only exercises vault
 * CREATION. These tests pin the three live states that silently lock users out if they
 * regress: correct unlock after lock (with real encrypted data surviving the round trip),
 * a wrong passphrase (honest error, vault stays closed, correct retry works), and a
 * mismatched new-vault confirmation (inline error, nothing created).
 *
 * The error bar is identical to the transition smoke: zero console errors and zero
 * uncaught page errors, filtering only favicon-style failed resource loads.
 */

function expectCleanRuntime(watched: { consoleErrors: string[]; pageErrors: string[] }) {
  // Failed resource loads (e.g. favicon) are network noise, not runtime failures.
  const unexpected = watched.consoleErrors.filter((text) => !text.startsWith("Failed to load resource"));
  expect(watched.pageErrors, "uncaught page errors").toEqual([]);
  expect(unexpected, "console errors").toEqual([]);
}

let vaultCounter = 0;

function nextPassphrase() {
  vaultCounter += 1;
  return `unlock-spec-passphrase-${Date.now()}-${vaultCounter}`;
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

test("lock then unlock with the right passphrase returns the user to their data", async ({ page }) => {
  const watched = await watchRuntime(page);
  const passphrase = nextPassphrase();
  await createVault(page, passphrase);

  // Seed real encrypted data: a marketplace listing round-trips through seal + storage.
  const title = `unlock round trip listing ${Date.now()}`;
  await page.getByRole("link", { name: "+ Post" }).click();
  await page.getByRole("radio", { name: "Marketplace listing" }).check();
  await page.getByLabel("Title").fill(title);
  await page.getByLabel("Notes").fill("must survive a lock/unlock round trip");
  await page.getByRole("button", { name: /Encrypt & save/ }).click();
  await page.waitForURL("**/market");
  await expect(page.getByText(title)).toBeVisible();

  // Lock from the taskbar, then hard-load a desktop route like a returning user: the
  // saved session key is gone, so the app must land on /unlock, not silently resume.
  // ("/" is the standalone landing and does not redirect; desktop routes do.)
  await page.getByRole("button", { name: "Lock" }).click();
  await page.waitForURL("**/unlock");
  await page.goto("/market");
  await page.waitForURL("**/unlock");
  await expect(page.getByText("Enter your passphrase to unlock the vault.")).toBeVisible();

  await page.getByLabel("Passphrase", { exact: true }).fill(passphrase);
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();

  // The point of the round trip: the data sealed before the lock is still there after it.
  await page.goto("/market");
  await expect(page.getByText(title)).toBeVisible();
  expectCleanRuntime(watched);
});

test("wrong passphrase shows an honest error, keeps the vault closed, and a correct retry works", async ({ page }) => {
  const watched = await watchRuntime(page);
  const passphrase = nextPassphrase();
  await createVault(page, passphrase);
  // Lock from a desktop route: the standalone landing locks in place, while the desktop
  // layout redirects to /unlock - the path a returning user hits.
  await page.goto("/feed");
  await page.getByRole("button", { name: "Lock" }).click();
  await page.waitForURL("**/unlock");

  await page.getByLabel("Passphrase", { exact: true }).fill(`wrong-${passphrase}`);
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByRole("alert")).toHaveText("That passphrase does not open this vault.");
  // The vault stays closed: still on /unlock, no unlocked navigation rendered.
  await expect(page).toHaveURL(/\/unlock/);
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toHaveCount(0);

  await page.getByLabel("Passphrase", { exact: true }).fill(passphrase);
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
  await page.goto("/feed");
  await expect(page).toHaveTitle("Feed — Everybody is Cool");
  expectCleanRuntime(watched);
});

test("mismatched new-vault passphrases show an inline error and create nothing", async ({ page }) => {
  const watched = await watchRuntime(page);
  const passphrase = nextPassphrase();
  await page.goto("/unlock");
  await expect(page.getByText(/No vault yet/)).toBeVisible();

  await page.getByLabel("Passphrase", { exact: true }).fill(passphrase);
  await page.getByLabel("Confirm passphrase").fill(`${passphrase}-different`);
  await page.getByRole("button", { name: "Create vault" }).click();
  await expect(page.getByRole("alert")).toHaveText("The two passphrases do not match.");
  // Nothing was created: still the new-vault form, no unlocked navigation.
  await expect(page).toHaveURL(/\/unlock/);
  await expect(page.getByRole("button", { name: "Create vault" })).toBeVisible();

  // Correcting the confirmation creates the vault and lands unlocked.
  await page.getByLabel("Confirm passphrase").fill(passphrase);
  await page.getByRole("button", { name: "Create vault" }).click();
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
  expectCleanRuntime(watched);
});

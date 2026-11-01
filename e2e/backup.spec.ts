import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";

/**
 * Vault backup/restore - the data-loss net. The exported backup is the user's ONLY
 * recovery when browser storage is wiped, so this exercises the real bytes, not UI
 * copy: export a download, wipe the vault through its confirm gate, restore the
 * exact bytes, unlock, and prove the seeded data (not just the app shell) survived.
 * Console errors and uncaught page errors are asserted at the end of every test,
 * matching the transition-smoke posture.
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

let vaultCounter = 0;

async function createVault(page: Page, passphrase: string) {
  vaultCounter += 1;
  await page.goto("/");
  await page.getByRole("link", { name: "Create or open your vault" }).first().click();
  await page.getByLabel("Passphrase", { exact: true }).fill(passphrase);
  await page.getByLabel("Confirm passphrase").fill(passphrase);
  await page.getByRole("button", { name: "Create vault" }).click();
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
}

test("backup export, wipe, restore: seeded data survives the round trip", async ({ page }) => {
  const watched = watchRuntime(page);
  const passphrase = `ci-backup-passphrase-${Date.now()}-${vaultCounter}`;
  const journalText = "backup probe entry - keep me safe";
  const listingTitle = "backup probe listing";
  await createVault(page, passphrase);

  // Seed two kinds of records: a journal entry and a marketplace listing.
  await page.goto("/tools/journal");
  await page.getByLabel("What is on your mind?").fill(journalText);
  await page.getByRole("button", { name: /Save entry/ }).click();
  await expect(page.getByText(journalText)).toBeVisible();

  await page.goto("/compose");
  await page.getByRole("radio", { name: "Marketplace listing" }).click();
  await page.getByLabel("Title").fill(listingTitle);
  await page.getByRole("button", { name: /Encrypt & save/ }).click();
  await expect(page).toHaveURL(/\/market$/);
  await expect(page.getByText(listingTitle)).toBeVisible();

  // Export: capture the actual download. The file must not leak seeded plaintext -
  // it is the encrypted backup, not a data export.
  await page.goto("/vault");
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export encrypted backup" }).click();
  const download = await downloadPromise;
  const downloadPath = await download.path();
  expect(downloadPath, "export produced a downloaded file").toBeTruthy();
  const backup = await readFile(downloadPath!, "utf8");
  expect(backup.length).toBeGreaterThan(0);
  expect(backup).not.toContain("backup probe");
  expect(backup).not.toContain(journalText);

  // Wipe through the typed confirmation gate: destructive, lands on the no-vault
  // unlock screen. The backup file above is now the only copy of the data.
  await page.getByRole("button", { name: "Wipe all local data…" }).click();
  await page.getByLabel("Type WIPE to confirm").fill("WIPE");
  await page.getByRole("button", { name: "Wipe now" }).click();
  await expect(page).toHaveURL(/\/unlock$/);
  await expect(page.getByText(/No vault yet/)).toBeVisible();

  // Restore the exact exported bytes and unlock with the original passphrase.
  await page.getByLabel("Restore from backup").setInputFiles({
    name: "backup.vault",
    mimeType: "application/json",
    buffer: Buffer.from(backup, "utf8"),
  });
  await expect(page.getByText(/Backup restored \(\d+ records\)/)).toBeVisible();
  await page.getByLabel("Passphrase", { exact: true }).fill(passphrase);
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();

  // The seeded data itself survived - journal entry and listing both render.
  await page.goto("/tools/journal");
  await expect(page.getByText(journalText)).toBeVisible();
  await page.goto("/market");
  await expect(page.getByText(listingTitle)).toBeVisible();
  expectCleanRuntime(watched);
});

test("a corrupted backup fails honestly and leaves the vault absent", async ({ page }) => {
  const watched = watchRuntime(page);
  await page.goto("/unlock");
  await expect(page.getByText(/No vault yet/)).toBeVisible();

  await page.getByLabel("Restore from backup").setInputFiles({
    name: "corrupt.vault",
    mimeType: "application/json",
    buffer: Buffer.from('{"version":1,"records":"not-real-ciphertext', "utf8"),
  });
  // An honest error, no restore notice, and no half-created vault.
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByText(/Backup restored/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Create vault" })).toBeVisible();
  expectCleanRuntime(watched);
});

test("readable export downloads chosen categories only, with an honest confirmation", async ({ page }) => {
  const watched = watchRuntime(page);
  const passphrase = `ci-export-passphrase-${Date.now()}-${vaultCounter}`;
  await createVault(page, passphrase);

  // Seed a journal entry via the production journal UI.
  await page.goto("/tools/journal");
  await page.getByLabel("What is on your mind?").fill("export probe entry");
  await page.getByRole("button", { name: /Save entry|Add entry/ }).click();
  await expect(page.getByText("export probe entry")).toBeVisible();

  await page.goto("/vault");
  // Deselect connections (none exist anyway) and export items+journal.
  await page.getByLabel("Connections").uncheck();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export readable copy" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^eic-export-.*\.json$/);
  const path = await download.path();
  const bundle = JSON.parse(await readFile(path, "utf8")) as {
    format: string; items: unknown[]; journal: { text: string }[]; connections: unknown[];
  };
  expect(bundle.format).toBe("eic-export");
  expect(bundle.journal.map((j) => j.text)).toContain("export probe entry");
  expect(bundle.connections).toHaveLength(0);
  await expect(page.getByText(/Exported .*1 journal entry.*only in this device's downloads/)).toBeVisible();

  // Deselecting everything disables the export.
  await page.getByLabel("Posts and listings").uncheck();
  await page.getByLabel("Journal entries").uncheck();
  await expect(page.getByRole("button", { name: "Export readable copy" })).toBeDisabled();

  expectCleanRuntime(watched);
});

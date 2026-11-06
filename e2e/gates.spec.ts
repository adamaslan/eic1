import { expect, test, type Page } from "@playwright/test";
import { unexpectedConsoleErrors, watchRuntime, type WatchedRuntime } from "./fixtures/runtime-watch";

function expectCleanRuntime(watched: WatchedRuntime) {
  const unexpected = unexpectedConsoleErrors(watched.consoleErrors);
  expect(watched.pageErrors, "uncaught page errors").toEqual([]);
  expect(unexpected, "console errors").toEqual([]);
}

let vaultCounter = 0;
async function createVault(page: Page) {
  vaultCounter += 1;
  const passphrase = `ci-gates-passphrase-${Date.now()}-${vaultCounter}`;
  await page.goto("/unlock");
  await page.getByLabel("Passphrase", { exact: true }).fill(passphrase);
  await page.getByLabel("Confirm passphrase").fill(passphrase);
  await page.getByRole("button", { name: "Create vault" }).click();
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
}

test("feature gates hide and restore surfaces without losing saved data", async ({ page }) => {
  const watched = await watchRuntime(page);
  await createVault(page);

  // Seed a journal entry and confirm editing is available.
  await page.goto("/tools/journal");
  await page.getByLabel("What is on your mind?").fill("Gate retention entry");
  await page.getByRole("button", { name: "🔒 Save entry" }).click();
  await expect(page.getByText("Entries (1)")).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit" })).toBeVisible();

  // Turn the map and journal editing off in Tools. Each toggle saves and reloads.
  await page.goto("/tools");
  await page.getByLabel(/Connections map/).click();
  await page.waitForLoadState("load");
  await expect(page.getByRole("link", { name: "Graph" })).toHaveCount(0);
  await expect(page.getByLabel(/Connections map/)).not.toBeChecked();
  await page.getByLabel(/Journal editing/).click();
  await page.waitForLoadState("load");
  await expect(page.getByLabel(/Journal editing/)).not.toBeChecked();

  // The graph route answers honestly instead of mapping.
  await page.goto("/graph");
  await expect(page.getByText(/The map is turned off in Tools/)).toBeVisible();

  // Journal entries stay; only the Edit affordance is hidden.
  await page.goto("/tools/journal");
  await expect(page.getByText("Gate retention entry")).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit" })).toHaveCount(0);

  // Turn both back on: everything returns, nothing lost.
  await page.goto("/tools");
  await page.getByLabel(/Connections map/).click();
  await page.waitForLoadState("load");
  await expect(page.getByRole("link", { name: "Graph" })).toBeVisible();
  await page.getByLabel(/Journal editing/).click();
  await page.waitForLoadState("load");
  await expect(page.getByLabel(/Journal editing/)).toBeChecked();
  await page.goto("/tools/journal");
  await expect(page.getByText("Gate retention entry")).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit" })).toBeVisible();

  expectCleanRuntime(watched);
});

test("an edit started before journal editing is turned off cannot be saved", async ({ page, context }) => {
  const watched = await watchRuntime(page);
  await createVault(page);
  await page.goto("/tools/journal");
  await page.getByLabel("What is on your mind?").fill("Entry that stays as written");
  await page.getByRole("button", { name: "🔒 Save entry" }).click();
  await expect(page.getByText("Entries (1)")).toBeVisible();

  // Start editing, then flip the gate off from a second tab.
  await page.getByRole("button", { name: "Edit" }).click();
  await page.getByLabel("Edit entry").fill("sneaky overwrite");
  const other = await context.newPage();
  const watchedOther = await watchRuntime(other);
  await other.goto("/tools");
  await other.getByLabel(/Journal editing/).click();
  await expect(other.getByLabel(/Journal editing/)).not.toBeChecked();

  // The in-progress save is refused honestly; the stored entry is unchanged.
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Journal editing is turned off in Tools. Your entry is unchanged.")).toBeVisible();
  await expect(page.getByText("Entry that stays as written")).toBeVisible();
  await expect(page.getByText("sneaky overwrite")).toHaveCount(0);

  expectCleanRuntime(watched);
  expectCleanRuntime(watchedOther);
});

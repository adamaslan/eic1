import { expect, test, type Page } from "@playwright/test";

/**
 * Journal editing: save entries, edit in place (timestamp preserved), search, and delete
 * behind its explicit confirmation - all with a clean runtime.
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

async function createVault(page: Page) {
  vaultCounter += 1;
  const passphrase = `ci-journal-passphrase-${Date.now()}-${vaultCounter}`;
  await page.goto("/");
  await page.getByRole("link", { name: "Create or open your vault" }).first().click();
  await page.getByLabel("Passphrase", { exact: true }).fill(passphrase);
  await page.getByLabel("Confirm passphrase").fill(passphrase);
  await page.getByRole("button", { name: "Create vault" }).click();
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
}

test("journal entries can be saved, edited, searched, and deleted with confirmation", async ({ page }) => {
  const watched = watchRuntime(page);
  await createVault(page);
  await page.goto("/tools/journal");

  // Save two entries.
  await page.getByLabel("What is on your mind?").fill("Bridge at dawn, worth the cold");
  await page.getByRole("button", { name: "🔒 Save entry" }).click();
  await expect(page.getByText("Bridge at dawn, worth the cold")).toBeVisible();
  await page.getByLabel("What is on your mind?").fill("Gym, then gallery paperwork");
  await page.getByRole("button", { name: "🔒 Save entry" }).click();
  await expect(page.getByText("Entries (2)")).toBeVisible();

  // Date filters narrow by a rolling window and show the honest count line.
  await page.getByRole("button", { name: "Last 24 hours" }).click();
  await expect(page.getByText("Showing 2 of 2 entries.")).toBeVisible();
  await page.getByRole("button", { name: "All time" }).click();
  await expect(page.getByText("Showing", { exact: false })).toHaveCount(0);

  // Text and date combine; a combined miss says so honestly.
  await page.getByRole("button", { name: "Last 7 days" }).click();
  await page.getByLabel("Search entries").fill("gallery");
  await expect(page.getByText("Showing 1 of 2 entries.")).toBeVisible();
  await page.getByLabel("Search entries").fill("zzz");
  await expect(page.getByText("No entries match that search in that date range.")).toBeVisible();
  await page.getByRole("button", { name: "Clear filter" }).click();
  await expect(page.getByText("Bridge at dawn", { exact: false })).toHaveCount(1);
  await expect(page.getByText("Gym, then gallery paperwork")).toBeVisible();

  // Edit the first entry in place.
  await page.getByRole("button", { name: "Edit" }).last().click();
  await page.getByLabel("Edit entry").fill("Bridge at dawn, worth every cold minute");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Bridge at dawn, worth every cold minute")).toBeVisible();
  await expect(page.getByText("Bridge at dawn, worth the cold", { exact: true })).toHaveCount(0);

  // Search narrows the list; a miss says so honestly.
  await page.getByLabel("Search entries").fill("gallery");
  await expect(page.getByText("Gym, then gallery paperwork")).toBeVisible();
  await expect(page.getByText("Bridge at dawn", { exact: false })).toHaveCount(0);
  await page.getByLabel("Search entries").fill("zzz");
  await expect(page.getByText("No entries match that search.")).toBeVisible();
  await page.getByLabel("Search entries").fill("");

  // A long entry saves, wraps, and edits in place.
  const longText = `Long walk home: ${"the river kept flashing through the railings and I kept stopping to look, ".repeat(18)}end.`;
  await page.getByLabel("What is on your mind?").fill(longText);
  await page.getByRole("button", { name: "🔒 Save entry" }).click();
  await expect(page.getByText("Entries (3)")).toBeVisible();
  const longEntry = page.getByText("Long walk home:", { exact: false });
  await expect(longEntry).toBeVisible();
  await expect
    .poll(async () => longEntry.evaluate((el) => (el as HTMLElement).getBoundingClientRect().height))
    .toBeGreaterThan(60); // wraps over several lines (~18px would be one squeezed line)

  // Delete needs the explicit Yes; the other entry survives.
  await page.getByRole("button", { name: "Delete" }).first().click();
  await expect(page.getByText("Delete this entry?")).toBeVisible();
  await page.getByRole("button", { name: "Keep" }).click();
  await expect(page.getByText("Entries (3)")).toBeVisible();
  await page.getByRole("button", { name: "Delete" }).first().click();
  await page.getByRole("button", { name: "Yes, delete" }).click();
  await expect(page.getByText("Entries (2)")).toBeVisible();

  expectCleanRuntime(watched);
});

import { expect, test, type Page } from "@playwright/test";
import { watchRuntime } from "./fixtures/runtime-watch";

/**
 * Calendar + chore chart e2e. Both tools write NEW encrypted record kinds
 * ("calendar" and "chore"), so this suite proves the full loop in a real browser:
 * save through the UI, survive a lock/unlock round trip (the data was really sealed
 * into the vault, not just React state), check off and uncheck, and delete.
 * It also pins privacy wording: the tools page and both screens state the data
 * stays in the vault, matching the no-share-file posture.
 */

function expectCleanRuntime(watched: { consoleErrors: string[]; pageErrors: string[] }) {
  const unexpected = watched.consoleErrors.filter((text) => !text.startsWith("Failed to load resource"));
  expect(watched.pageErrors, "uncaught page errors").toEqual([]);
  expect(unexpected, "console errors").toEqual([]);
}

function todayLabel(date: Date): string {
  return date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

async function createVault(page: Page, passphrase: string) {
  await page.goto("/");
  await page.getByRole("link", { name: "Create or open your vault" }).first().click();
  await page.getByLabel("Passphrase", { exact: true }).fill(passphrase);
  await page.getByLabel("Confirm passphrase").fill(passphrase);
  await page.getByRole("button", { name: "Create vault" }).click();
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
}

async function lockAndUnlock(page: Page, passphrase: string) {
  await page.getByRole("button", { name: "Lock" }).click();
  await page.waitForURL("**/unlock");
  await page.getByLabel("Passphrase", { exact: true }).fill(passphrase);
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
}

test("calendar: add an event, it marks the grid, survives lock/unlock, and deletes", async ({ page }) => {
  const watched = await watchRuntime(page);
  const passphrase = `calendar-spec-${Date.now()}`;
  const title = `dentist ${Date.now()}`;
  const label = todayLabel(new Date());
  await createVault(page, passphrase);

  // The today cell is selected by default, so saving lands on today.
  await page.goto("/tools/calendar");
  await expect(page.getByRole("gridcell", { name: `${label}, no events` })).toBeVisible();
  await page.getByPlaceholder("Title").fill(title);
  await page.getByPlaceholder("Note (optional)").fill("bring the insurance card");
  await page.getByRole("button", { name: "🔒 Save event" }).click();

  // Explicit post-write confirmation: only after the awaited encrypted write lands.
  await expect(page.getByRole("status")).toHaveText("Event saved to your encrypted vault.");

  // Day panel shows the event and its note; the grid cell now carries the marker.
  await expect(page.getByText(title)).toBeVisible();
  await expect(page.getByText("bring the insurance card")).toBeVisible();
  await expect(page.getByRole("gridcell", { name: `${label}, 1 event` })).toBeVisible();

  // Lock/unlock round trip: the event was sealed into the vault, not held in state.
  await lockAndUnlock(page, passphrase);
  await page.goto("/tools/calendar");
  await expect(page.getByText(title)).toBeVisible();
  await expect(page.getByRole("gridcell", { name: `${label}, 1 event` })).toBeVisible();

  // Delete is real: panel empties and the marker is gone.
  await page.getByRole("button", { name: `Delete ${title}` }).click();
  // Delete feedback is honest wording - a removal, never phrased as a save.
  await expect(page.getByRole("status")).toHaveText("Event deleted.");
  await expect(page.getByText(title)).toHaveCount(0);
  await expect(page.getByText("Nothing planned for this day.")).toBeVisible();
  await expect(page.getByRole("gridcell", { name: `${label}, no events` })).toBeVisible();
  expectCleanRuntime(watched);
});

test("chore chart: add a chore, check off today, it survives lock/unlock, unchecks", async ({ page }) => {
  const watched = await watchRuntime(page);
  const passphrase = `chores-spec-${Date.now()}`;
  const name = `water plants ${Date.now()}`;
  const now = new Date();
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][now.getDay()]!;
  await createVault(page, passphrase);

  await page.goto("/tools/chores");
  await page.getByPlaceholder("e.g. Water plants").fill(name);
  await page.getByRole("button", { name: "🔒 Save chore" }).click();
  await expect(page.getByRole("status")).toHaveText("Chore saved to your encrypted vault.");
  await expect(page.getByText(name)).toBeVisible();
  await expect(page.getByText("0/7 this week")).toBeVisible();

  // Check off today: the cell flips to pressed and the weekly counter moves.
  await page.getByRole("button", { name: `Check off ${name} for ${weekday} ${now.getDate()}` }).click();
  await expect(page.getByRole("status")).toHaveText("Check-off saved to your encrypted vault.");
  await expect(page.getByRole("button", { name: `Uncheck ${name} for ${weekday} ${now.getDate()}` })).toBeVisible();
  await expect(page.getByText("1/7 this week")).toBeVisible();

  // Lock/unlock round trip keeps the check-off.
  await lockAndUnlock(page, passphrase);
  await page.goto("/tools/chores");
  await expect(page.getByRole("button", { name: `Uncheck ${name} for ${weekday} ${now.getDate()}` })).toBeVisible();

  // Uncheck returns to zero; deleting the chore removes the row.
  await page.getByRole("button", { name: `Uncheck ${name} for ${weekday} ${now.getDate()}` }).click();
  await expect(page.getByText("0/7 this week")).toBeVisible();
  await page.getByRole("button", { name: `Delete chore ${name}` }).click();
  await expect(page.getByRole("status")).toHaveText("Chore deleted.");
  await expect(page.getByText("No chores yet. Add one below to start the chart.")).toBeVisible();
  expectCleanRuntime(watched);
});

test("tools page lists Calendar and Chore chart with their privacy wording", async ({ page }) => {
  const watched = await watchRuntime(page);
  await createVault(page, `tools-cal-spec-${Date.now()}`);

  await page.goto("/tools");
  await expect(page.getByRole("link", { name: "Calendar" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Chore chart" })).toBeVisible();
  await expect(page.getByText("encrypted in your vault and never shared")).toBeVisible();

  await page.getByRole("link", { name: "Calendar" }).click();
  await expect(page).toHaveTitle("Calendar — Everybody is Cool");
  await expect(page.getByText("Events stay in this vault.")).toBeVisible();

  await page.goto("/tools/chores");
  await expect(page.getByText("Check-offs stay in this vault.")).toBeVisible();
  expectCleanRuntime(watched);
});


test("calendar + chores: saved data survives a full page reload (session resume, not lock/unlock)", async ({ page }) => {
  const watched = await watchRuntime(page);
  const passphrase = `cal-reload-${Date.now()}`;
  const title = `gallery ${Date.now()}`;
  const chore = `dishes ${Date.now()}`;
  const now = new Date();
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][now.getDay()]!;
  await createVault(page, passphrase);

  await page.goto("/tools/calendar");
  await page.getByPlaceholder("Title").fill(title);
  await page.getByRole("button", { name: "🔒 Save event" }).click();
  await expect(page.getByText(title)).toBeVisible();

  await page.goto("/tools/chores");
  await page.getByPlaceholder("e.g. Water plants").fill(chore);
  await page.getByRole("button", { name: "🔒 Save chore" }).click();
  await page.getByRole("button", { name: `Check off ${chore} for ${weekday} ${now.getDate()}` }).click();
  await expect(page.getByText("1/7 this week")).toBeVisible();

  // Full reload: the app resumes the saved session and both kinds of data are back.
  await page.reload();
  await page.goto("/tools/calendar");
  await expect(page.getByText(title)).toBeVisible();
  await page.goto("/tools/chores");
  await expect(page.getByRole("button", { name: `Uncheck ${chore} for ${weekday} ${now.getDate()}` })).toBeVisible();
  expectCleanRuntime(watched);
});

test("invalid input never saves: save buttons stay disabled and no records appear", async ({ page }) => {
  const watched = await watchRuntime(page);
  await createVault(page, `cal-negative-${Date.now()}`);
  const label = todayLabel(new Date());

  await page.goto("/tools/calendar");
  // Blank and whitespace-only titles keep the button disabled; nothing is written.
  const saveEvent = page.getByRole("button", { name: "🔒 Save event" });
  await expect(saveEvent).toBeDisabled();
  await page.getByPlaceholder("Title").fill("   ");
  await expect(saveEvent).toBeDisabled();
  await expect(page.getByRole("gridcell", { name: `${label}, no events` })).toBeVisible();

  await page.goto("/tools/chores");
  const saveChore = page.getByRole("button", { name: "🔒 Save chore" });
  await expect(saveChore).toBeDisabled();
  // A name with zero days picked is also refused before any write.
  await page.getByPlaceholder("e.g. Water plants").fill("laundry");
  for (const day of ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]) {
    await page.getByRole("checkbox", { name: day }).uncheck();
  }
  await expect(saveChore).toBeDisabled();
  await expect(page.getByText("No chores yet. Add one below to start the chart.")).toBeVisible();
  expectCleanRuntime(watched);
});


test("storage failures surface honest errors, never false success, and preserve data", async ({ page }) => {
  const watched = await watchRuntime(page);
  const passphrase = `cal-fault-${Date.now()}`;
  const kept = `kept ${Date.now()}`;
  const label = todayLabel(new Date());
  await createVault(page, passphrase);

  // Seed one real event.
  await page.goto("/tools/calendar");
  await page.getByPlaceholder("Title").fill(kept);
  await page.getByRole("button", { name: "🔒 Save event" }).click();
  await expect(page.getByText(kept)).toBeVisible();

  // Fault injection at the real storage layer: every IndexedDB write now fails.
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    (window as unknown as { __restorePut: () => void }).__restorePut = () => {
      IDBObjectStore.prototype.put = original;
    };
    IDBObjectStore.prototype.put = function () {
      throw new DOMException("injected storage failure", "UnknownError");
    } as typeof IDBObjectStore.prototype.put;
  });
  await page.getByPlaceholder("Title").fill("ghost");
  await page.getByRole("button", { name: "🔒 Save event" }).click();
  // Honest failure: the alert names the failure, the button leaves its saving state,
  // and the ghost never appears in the list.
  await expect(page.getByRole("alert")).toContainText("The event could not be saved. Please try again.");
  // No false success: the status line never appears, and the input is preserved for retry.
  await expect(page.getByRole("status")).toHaveCount(0);
  await expect(page.getByPlaceholder("Title")).toHaveValue("ghost");
  await expect(page.getByText("ghost")).toHaveCount(0);
  await expect(page.getByRole("gridcell", { name: `${label}, 1 event` })).toBeVisible();

  // Writes heal after the fault clears; the retry genuinely lands.
  await page.evaluate(() => (window as unknown as { __restorePut: () => void }).__restorePut());
  await page.getByRole("button", { name: "🔒 Save event" }).click();
  await expect(page.getByText("ghost")).toBeVisible();
  await expect(page.getByRole("gridcell", { name: `${label}, 2 events` })).toBeVisible();

  // Read failure: the screen says so instead of rendering an empty or stale list.
  await page.evaluate(() => {
    const original = IDBIndex.prototype.getAll;
    (window as unknown as { __restoreGetAll: () => void }).__restoreGetAll = () => {
      IDBIndex.prototype.getAll = original;
    };
    IDBIndex.prototype.getAll = function () {
      throw new DOMException("injected read failure", "UnknownError");
    } as typeof IDBObjectStore.prototype.getAll;
  });
  // Client-side navigation keeps the injected fault alive (a full goto would reload the page).
  await page.getByRole("link", { name: "Back to tools" }).click();
  await page.getByRole("link", { name: "Chore chart" }).click();
  await expect(page.getByText("The chore chart could not be read.")).toBeVisible();
  await expect(page.getByText("No chores yet.")).toHaveCount(0);

  // Nothing was lost: clear the fault, reload, both events are still sealed in the vault.
  await page.evaluate(() => (window as unknown as { __restoreGetAll: () => void }).__restoreGetAll());
  await page.reload();
  await page.goto("/tools/calendar");
  await expect(page.getByText(kept)).toBeVisible();
  await expect(page.getByText("ghost")).toBeVisible();
  expectCleanRuntime(watched);
});

test("save feedback clears on a new edit and stays honest when the refresh fails after a successful write", async ({ page }) => {
  const watched = await watchRuntime(page);
  const passphrase = `cal-notice-${Date.now()}`;
  const first = `notice one ${Date.now()}`;
  const second = `notice two ${Date.now()}`;
  await createVault(page, passphrase);

  // Save once: explicit confirmation appears.
  await page.goto("/tools/calendar");
  await page.getByPlaceholder("Title").fill(first);
  await page.getByRole("button", { name: "🔒 Save event" }).click();
  await expect(page.getByRole("status")).toHaveText("Event saved to your encrypted vault.");

  // Starting a new edit clears the confirmation - it never lingers over new input.
  await page.getByPlaceholder("Title").fill("typing");
  await expect(page.getByRole("status")).toHaveCount(0);

  // Write succeeds but the refresh read fails: the wording must say SAVED (no
  // duplicate-tempting failure hint) AND that the list couldn't refresh.
  await page.evaluate(() => {
    const original = IDBIndex.prototype.getAll;
    (window as unknown as { __restoreGetAll: () => void }).__restoreGetAll = () => {
      IDBIndex.prototype.getAll = original;
    };
    IDBIndex.prototype.getAll = function () {
      throw new DOMException("injected read failure", "UnknownError");
    } as typeof IDBObjectStore.prototype.getAll;
  });
  await page.getByPlaceholder("Title").fill(second);
  await page.getByRole("button", { name: "🔒 Save event" }).click();
  await expect(page.getByRole("status")).toHaveText("Event saved to your encrypted vault, but the list couldn't refresh.");
  // The form still cleared - the write landed - so a retry cannot duplicate the record.
  await expect(page.getByPlaceholder("Title")).toHaveValue("");

  // Real persistence: clear the fault, reload fully, both events are sealed in the vault.
  await page.evaluate(() => (window as unknown as { __restoreGetAll: () => void }).__restoreGetAll());
  await page.reload();
  await page.goto("/tools/calendar");
  await expect(page.getByText(first)).toBeVisible();
  await expect(page.getByText(second)).toBeVisible();
  expectCleanRuntime(watched);
});

test.describe("phone-width (390px)", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("calendar and chore chart fit the viewport with no horizontal overflow", async ({ page }) => {
    const watched = await watchRuntime(page);
    await createVault(page, `cal-390-${Date.now()}`);

    await page.goto("/tools/calendar");
    await expect(page.getByRole("gridcell").first()).toBeVisible();
    let overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, "calendar has sideways scroll").toBeLessThanOrEqual(0);

    // Seed a chore so the chart table renders at full width, then re-measure.
    await page.goto("/tools/chores");
    await page.getByPlaceholder("e.g. Water plants").fill("phone width probe");
    await page.getByRole("button", { name: "🔒 Save chore" }).click();
    await expect(page.getByText("phone width probe")).toBeVisible();
    overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, "chore chart has sideways scroll").toBeLessThanOrEqual(0);

    // Bottom content scrolls fully clear of the fixed taskbar on both tools.
    const taskbarBox = await page.locator("footer").boundingBox();
    if (!taskbarBox) throw new Error("taskbar has no bounding box");
    await page.goto("/tools/calendar");
    const backLink = page.getByRole("link", { name: "Back to tools" });
    await backLink.scrollIntoViewIfNeeded();
    let box = await backLink.boundingBox();
    if (!box) throw new Error("calendar back link has no bounding box");
    expect(box.y + box.height, "calendar bottom clears the taskbar").toBeLessThanOrEqual(taskbarBox.y);
    const saveButton = page.getByRole("button", { name: "🔒 Save event" });
    await saveButton.scrollIntoViewIfNeeded();
    box = await saveButton.boundingBox();
    if (!box) throw new Error("save button has no bounding box");
    expect(box.y + box.height, "save button clears the taskbar").toBeLessThanOrEqual(taskbarBox.y);

    await page.goto("/tools/chores");
    const choreBack = page.getByRole("link", { name: "Back to tools" });
    await choreBack.scrollIntoViewIfNeeded();
    box = await choreBack.boundingBox();
    if (!box) throw new Error("chores back link has no bounding box");
    expect(box.y + box.height, "chore chart bottom clears the taskbar").toBeLessThanOrEqual(taskbarBox.y);
    expectCleanRuntime(watched);
  });
});

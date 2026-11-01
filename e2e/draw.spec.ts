import { expect, test, type Page } from "@playwright/test";

/**
 * Paint editing and discoverability. Canvas behavior is asserted by counting inked
 * (non-white) pixels through the real 2d context - a rendered-pixel check, not a
 * DOM-state proxy - so undo/redo and text placement are proven on the actual bitmap.
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

async function createVault(page: Page) {
  vaultCounter += 1;
  const passphrase = `ci-paint-passphrase-${Date.now()}-${vaultCounter}`;
  await page.goto("/");
  await page.getByRole("link", { name: "Create or open your vault" }).first().click();
  await page.getByLabel("Passphrase", { exact: true }).fill(passphrase);
  await page.getByLabel("Confirm passphrase").fill(passphrase);
  await page.getByRole("button", { name: "Create vault" }).click();
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
}

async function inkPixels(page: Page): Promise<number> {
  return page.locator("canvas").first().evaluate((node) => {
    const canvas = node as HTMLCanvasElement;
    const context = canvas.getContext("2d");
    if (!context) return -1;
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let inked = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] < 250 || data[i + 1] < 250 || data[i + 2] < 250) inked += 1;
    }
    return inked;
  });
}

async function drawStroke(page: Page) {
  const canvas = page.locator("canvas").first();
  const box = await canvas.boundingBox();
  if (!box) throw new Error("canvas has no bounding box");
  await page.mouse.move(box.x + 20, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 20, box.y + box.height - 20, { steps: 8 });
  await page.mouse.up();
}

test("brush stroke can be undone and redone", async ({ page }) => {
  const watched = watchRuntime(page);
  await createVault(page);
  await page.goto("/draw");

  expect(await inkPixels(page)).toBe(0);
  await expect(page.getByRole("button", { name: "Undo" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Redo" })).toBeDisabled();

  await drawStroke(page);
  expect(await inkPixels(page)).toBeGreaterThan(0);
  await expect(page.getByRole("button", { name: "Undo" })).toBeEnabled();

  await page.getByRole("button", { name: "Undo" }).click();
  expect(await inkPixels(page)).toBe(0);
  await expect(page.getByRole("button", { name: "Redo" })).toBeEnabled();

  await page.getByRole("button", { name: "Redo" }).click();
  expect(await inkPixels(page)).toBeGreaterThan(0);
  expectCleanRuntime(watched);
});

test("a new stroke clears the redo lane", async ({ page }) => {
  const watched = watchRuntime(page);
  await createVault(page);
  await page.goto("/draw");

  await drawStroke(page);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByRole("button", { name: "Redo" })).toBeEnabled();

  await drawStroke(page);
  await expect(page.getByRole("button", { name: "Redo" })).toBeDisabled();
  // The new stroke holds exactly one undo entry; undoing it returns to the blank canvas
  // and leaves nothing else to undo (the pre-undo lane was consumed, not duplicated).
  await page.getByRole("button", { name: "Undo" }).click();
  expect(await inkPixels(page)).toBe(0);
  await expect(page.getByRole("button", { name: "Undo" })).toBeDisabled();
  expectCleanRuntime(watched);
});

test("text tool places text on the canvas and undo removes it", async ({ page }) => {
  const watched = watchRuntime(page);
  await createVault(page);
  await page.goto("/draw");

  await page.getByRole("button", { name: "Text", exact: true }).click();
  // Nothing to place yet: no anchor and no text.
  await expect(page.getByRole("button", { name: "Place text" })).toBeDisabled();

  const canvas = page.locator("canvas").first();
  const box = await canvas.boundingBox();
  if (!box) throw new Error("canvas has no bounding box");
  await page.mouse.click(box.x + box.width / 4, box.y + box.height / 4);
  await page.getByLabel("Text to place").fill("eic");
  await page.getByRole("button", { name: "Place text" }).click();

  expect(await inkPixels(page)).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Undo" }).click();
  expect(await inkPixels(page)).toBe(0);
  await page.getByRole("button", { name: "Redo" }).click();
  expect(await inkPixels(page)).toBeGreaterThan(0);
  expectCleanRuntime(watched);
});

test("uncommitted text preview never enters the undo history", async ({ page }) => {
  const watched = watchRuntime(page);
  await createVault(page);
  await page.goto("/draw");

  await drawStroke(page);
  const inkAfterStroke = await inkPixels(page);
  expect(inkAfterStroke).toBeGreaterThan(0);

  // Arm the text tool and type a preview, but switch back to the brush without placing.
  await page.getByRole("button", { name: "Text", exact: true }).click();
  const canvas = page.locator("canvas").first();
  const box = await canvas.boundingBox();
  if (!box) throw new Error("canvas has no bounding box");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.getByLabel("Text to place").fill("preview");
  await page.getByRole("button", { name: "Brush" }).click();

  // The preview is gone and the single undo still targets only the brush stroke.
  expect(await inkPixels(page)).toBe(inkAfterStroke);
  await page.getByRole("button", { name: "Undo" }).click();
  expect(await inkPixels(page)).toBe(0);
  await expect(page.getByRole("button", { name: "Undo" })).toBeDisabled();
  expectCleanRuntime(watched);
});

test("tools page lists Paint and links into the canvas", async ({ page }) => {
  const watched = watchRuntime(page);
  await createVault(page);
  await page.goto("/tools");

  await expect(page.getByRole("link", { name: "Journal" })).toBeVisible();
  // The desktop nav also links to Paint; assert the one in the Tools list.
  const paintLink = page.getByRole("list").getByRole("link", { name: "Paint" });
  await expect(paintLink).toBeVisible();
  await paintLink.click();
  await expect(page).toHaveURL(/\/draw$/);
  await expect(page.locator("canvas").first()).toBeVisible();
  expectCleanRuntime(watched);
});

test("desktop nav and feed header both reach Paint", async ({ page }) => {
  const watched = watchRuntime(page);
  await createVault(page);
  // The desktop shell (with the Paint tab) mounts on app routes like /feed; the
  // unlocked landing page carries its own navigation.
  await page.goto("/feed");

  const nav = page.getByRole("navigation", { name: "Main navigation" });
  await nav.getByRole("link", { name: "Paint" }).click();
  await expect(page).toHaveURL(/\/draw$/);
  await expect(nav.getByRole("link", { name: "Paint" })).toHaveAttribute("aria-current", "page");

  await page.goto("/feed");
  await page.getByRole("link", { name: "🎨 Paint" }).click();
  await expect(page).toHaveURL(/\/draw$/);
  expectCleanRuntime(watched);
});

test("keyboard shortcut ctrl+z undoes a stroke outside text fields", async ({ page }) => {
  const watched = watchRuntime(page);
  await createVault(page);
  await page.goto("/draw");

  await drawStroke(page);
  expect(await inkPixels(page)).toBeGreaterThan(0);

  // Focus sits on the page body after the stroke; clicking the canvas would add a dot.
  await page.keyboard.press("Control+z");
  expect(await inkPixels(page)).toBe(0);
  await page.keyboard.press("Control+Shift+z");
  expect(await inkPixels(page)).toBeGreaterThan(0);
  expectCleanRuntime(watched);
});

test.describe("phone-width (390px)", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("paint fits the viewport with no horizontal overflow", async ({ page }) => {
    const watched = watchRuntime(page);
    await createVault(page);
    await page.goto("/draw");

    // No sideways scroll: page content never exceeds the 390px viewport.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);

    // Canvas shrinks to fit and keeps working at its scaled display size.
    const canvasBox = await page.locator("canvas").first().boundingBox();
    if (!canvasBox) throw new Error("canvas has no bounding box");
    expect(canvasBox.x + canvasBox.width).toBeLessThanOrEqual(390);
    expect(canvasBox.width).toBeLessThan(320);

    await drawStroke(page);
    expect(await inkPixels(page)).toBeGreaterThan(0);
    await page.getByRole("button", { name: "Undo" }).click();
    expect(await inkPixels(page)).toBe(0);

    // Text tool works at the scaled size too.
    await page.getByRole("button", { name: "Text", exact: true }).click();
    await page.mouse.click(canvasBox.x + canvasBox.width / 4, canvasBox.y + canvasBox.height / 4);
    await page.getByLabel("Text to place").fill("eic");
    await page.getByRole("button", { name: "Place text" }).click();
    expect(await inkPixels(page)).toBeGreaterThan(0);
    await page.getByRole("button", { name: "Undo" }).click();
    expect(await inkPixels(page)).toBe(0);
    expectCleanRuntime(watched);
  });

  test("bottom actions scroll fully clear of the fixed taskbar", async ({ page }) => {
    const watched = watchRuntime(page);
    await createVault(page);
    await page.goto("/draw");

    const cancel = page.getByRole("button", { name: "Cancel" });
    await cancel.scrollIntoViewIfNeeded();
    const actionBox = await cancel.boundingBox();
    const taskbarBox = await page.locator("footer").boundingBox();
    if (!actionBox || !taskbarBox) throw new Error("missing action row or taskbar box");
    expect(actionBox.y + actionBox.height).toBeLessThanOrEqual(taskbarBox.y);
    expectCleanRuntime(watched);
  });

  test("feed header link fits and reaches paint", async ({ page }) => {
    const watched = watchRuntime(page);
    await createVault(page);
    await page.goto("/feed");

    const link = page.getByRole("link", { name: "🎨 Paint" });
    const box = await link.boundingBox();
    if (!box) throw new Error("feed paint link has no bounding box");
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    await link.click();
    await expect(page).toHaveURL(/\/draw$/);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    expectCleanRuntime(watched);
  });
});

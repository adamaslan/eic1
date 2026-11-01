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

test("eraser removes ink without adding any, and undo restores it", async ({ page }) => {
  const watched = watchRuntime(page);
  await createVault(page);
  await page.goto("/draw");

  // Erasing a blank canvas adds nothing: the eraser paints the white background color.
  await page.getByRole("button", { name: "Eraser" }).click();
  await drawStroke(page);
  expect(await inkPixels(page)).toBe(0);

  await page.getByRole("button", { name: "Brush" }).click();
  await drawStroke(page);
  expect(await inkPixels(page)).toBeGreaterThan(0);

  // Erase over the same path with the widest tip: the stroke is fully covered.
  await page.getByRole("button", { name: "Eraser" }).click();
  await page.getByRole("button", { name: "14px" }).click();
  await drawStroke(page);
  expect(await inkPixels(page)).toBe(0);

  // The erase is an ordinary undoable stroke; redo re-erases.
  await page.getByRole("button", { name: "Undo" }).click();
  expect(await inkPixels(page)).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Redo" }).click();
  expect(await inkPixels(page)).toBe(0);
  expectCleanRuntime(watched);
});

test("text crosshairs aim placement without touching the bitmap or history", async ({ page }) => {
  const watched = watchRuntime(page);
  await createVault(page);
  await page.goto("/draw");

  const canvas = page.locator("canvas").first();
  const box = await canvas.boundingBox();
  if (!box) throw new Error("canvas has no bounding box");

  // No guides while a paint tool is armed.
  await expect(page.getByTestId("text-crosshair-v")).toHaveCount(0);

  await page.getByRole("button", { name: "Text", exact: true }).click();
  const aimX = box.x + box.width / 4;
  const aimY = box.y + box.height / 3;
  await page.mouse.move(aimX, aimY);

  const vline = page.getByTestId("text-crosshair-v");
  const hline = page.getByTestId("text-crosshair-h");
  await expect(vline).toBeVisible();
  await expect(hline).toBeVisible();
  const vbox = await vline.boundingBox();
  const hbox = await hline.boundingBox();
  if (!vbox || !hbox) throw new Error("crosshair lines have no bounding box");
  expect(Math.abs(vbox.x + vbox.width / 2 - aimX)).toBeLessThanOrEqual(3);
  expect(Math.abs(hbox.y + hbox.height / 2 - aimY)).toBeLessThanOrEqual(3);

  // The guides are an overlay: no ink, no undo history, and moving them changes nothing.
  expect(await inkPixels(page)).toBe(0);
  await expect(page.getByRole("button", { name: "Undo" })).toBeDisabled();

  // Clicking sets the anchor: a fixed cross appears at the click point.
  await page.mouse.click(aimX, aimY);
  const anchor = page.getByTestId("text-anchor-cross");
  await expect(anchor).toBeVisible();
  const abox = await anchor.boundingBox();
  if (!abox) throw new Error("anchor cross has no bounding box");
  expect(Math.abs(abox.x + abox.width / 2 - aimX)).toBeLessThanOrEqual(4);
  expect(Math.abs(abox.y + abox.height / 2 - aimY)).toBeLessThanOrEqual(4);
  expect(await inkPixels(page)).toBe(0);

  // Placement still lands where aimed; undo removes it cleanly.
  await page.getByLabel("Text to place").fill("aim");
  await page.getByRole("button", { name: "Place text" }).click();
  expect(await inkPixels(page)).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Undo" }).click();
  expect(await inkPixels(page)).toBe(0);
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

test("saving never bakes an uncommitted text preview into the post", async ({ page }) => {
  const watched = watchRuntime(page);
  await createVault(page);
  await page.goto("/draw");

  await drawStroke(page);
  const strokeInk = await inkPixels(page);
  expect(strokeInk).toBeGreaterThan(0);

  // Arm the text tool and type a preview, but do NOT place it.
  await page.getByRole("button", { name: "Text", exact: true }).click();
  const canvas = page.locator("canvas").first();
  const box = await canvas.boundingBox();
  if (!box) throw new Error("canvas has no bounding box");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.getByLabel("Text to place").fill("unsaved preview");
  const previewInk = await inkPixels(page);
  expect(previewInk).toBeGreaterThan(strokeInk);

  // Save: the preview is discarded first, so the stored image holds the stroke only.
  await page.getByLabel("Title").fill("preview-check");
  await page.getByRole("button", { name: /Encrypt & save/ }).click();
  await expect(page).toHaveURL(/\/feed$/);

  const savedInk = await page.locator("main img").first().evaluate((node) => {
    const img = node as HTMLImageElement;
    const probe = document.createElement("canvas");
    probe.width = img.naturalWidth;
    probe.height = img.naturalHeight;
    const context = probe.getContext("2d");
    if (!context || probe.width === 0) return -1;
    context.drawImage(img, 0, 0);
    const data = context.getImageData(0, 0, probe.width, probe.height).data;
    let inked = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] < 250 || data[i + 1] < 250 || data[i + 2] < 250) inked += 1;
    }
    return inked;
  });
  expect(savedInk).toBeGreaterThan(0);
  // The full image is the 192px canvas (the thumbnail is smaller); text would add a
  // large block of ink. Compare proportionally: stroke-only ink scales with area.
  expect(savedInk).toBeLessThan(previewInk);
  expectCleanRuntime(watched);
});

// --- PR A: paper color, multiline/wrapped text, tiny text, exact-bytes preview ---

async function countColor(page: Page, r: number, g: number, b: number): Promise<number> {
  return page.locator("canvas").first().evaluate(
    (node, [tr, tg, tb]) => {
      const canvas = node as HTMLCanvasElement;
      const context = canvas.getContext("2d");
      if (!context) return -1;
      const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let count = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] === tr && data[i + 1] === tg && data[i + 2] === tb) count += 1;
      }
      return count;
    },
    [r, g, b] as const,
  );
}

async function inkHeight(page: Page): Promise<number> {
  return page.locator("canvas").first().evaluate((node) => {
    const canvas = node as HTMLCanvasElement;
    const context = canvas.getContext("2d");
    if (!context) return -1;
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let minY = -1;
    let maxY = -1;
    for (let y = 0; y < canvas.height; y += 1) {
      for (let x = 0; x < canvas.width; x += 1) {
        const i = (y * canvas.width + x) * 4;
        if (data[i] < 250 || data[i + 1] < 250 || data[i + 2] < 250) {
          if (minY === -1) minY = y;
          maxY = y;
        }
      }
    }
    return minY === -1 ? 0 : maxY - minY + 1;
  });
}

test("fill background paints the paper color as one undoable edit", async ({ page }) => {
  const watched = watchRuntime(page);
  await createVault(page);
  await page.goto("/draw");

  expect(await countColor(page, 255, 255, 0)).toBe(0);
  await page.getByLabel("Paper color #ffff00").click();
  await page.getByRole("button", { name: "Fill background" }).click();
  expect(await countColor(page, 255, 255, 0)).toBe(192 * 192);
  await expect(page.getByRole("button", { name: "Undo" })).toBeEnabled();

  // One undo entry: the canvas is white again, and redo repaints it yellow.
  await page.getByRole("button", { name: "Undo" }).click();
  expect(await countColor(page, 255, 255, 0)).toBe(0);
  expect(await inkPixels(page)).toBe(0);
  await page.getByRole("button", { name: "Redo" }).click();
  expect(await countColor(page, 255, 255, 0)).toBe(192 * 192);
  expectCleanRuntime(watched);
});

test("eraser reveals the paper color, not fixed white", async ({ page }) => {
  const watched = watchRuntime(page);
  await createVault(page);
  await page.goto("/draw");

  await page.getByLabel("Paper color #ffff00").click();
  await page.getByRole("button", { name: "Fill background" }).click();

  // Black stroke over the yellow paper.
  await drawStroke(page);
  expect(await countColor(page, 0, 0, 0)).toBeGreaterThan(0);

  // Erasing over the same path restores yellow, never white.
  await page.getByRole("button", { name: "Eraser" }).click();
  await page.getByRole("button", { name: "14px" }).click();
  await drawStroke(page);
  expect(await countColor(page, 0, 0, 0)).toBe(0);
  expect(await countColor(page, 255, 255, 0)).toBe(192 * 192);
  // No white leaked in: the eraser painted paper, not the old fixed white.
  expect(await countColor(page, 255, 255, 255)).toBe(0);

  // Undoing the erase brings the stroke back; undoing again restores blank paper.
  await page.getByRole("button", { name: "Undo" }).click();
  expect(await countColor(page, 0, 0, 0)).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Undo" }).click();
  expect(await countColor(page, 0, 0, 0)).toBe(0);
  expect(await countColor(page, 255, 255, 255)).toBe(0);
  expectCleanRuntime(watched);
});

test("multiline text stacks lines and undo removes the whole placement", async ({ page }) => {
  const watched = watchRuntime(page);
  await createVault(page);
  await page.goto("/draw");

  await page.getByRole("button", { name: "Text", exact: true }).click();
  const canvas = page.locator("canvas").first();
  const box = await canvas.boundingBox();
  if (!box) throw new Error("canvas has no bounding box");
  await page.mouse.click(box.x + box.width / 8, box.y + box.height / 8);

  await page.getByLabel("Text to place").fill("hello\nworld");
  await page.getByRole("button", { name: "Place text" }).click();

  // Two stacked lines are much taller than one 12px line.
  expect(await inkHeight(page)).toBeGreaterThan(16);
  expect(await inkPixels(page)).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Undo" }).click();
  expect(await inkPixels(page)).toBe(0);
  expectCleanRuntime(watched);
});

test("word wrap narrows and tallies text, wider wrap flattens it", async ({ page }) => {
  const watched = watchRuntime(page);
  await createVault(page);
  await page.goto("/draw");

  await page.getByRole("button", { name: "Text", exact: true }).click();
  const canvas = page.locator("canvas").first();
  const box = await canvas.boundingBox();
  if (!box) throw new Error("canvas has no bounding box");
  await page.mouse.click(box.x + box.width / 8, box.y + box.height / 8);

  // Tight wrap: a long sentence must break into several lines (12px text so the
  // heights are predictable: a 12px line is 15px tall with its line height).
  await page.getByRole("button", { name: "12px" }).click();
  await page.getByLabel("Text wrap width").fill("32");
  await page.getByLabel("Text to place").fill("aaaa bbbb cccc dddd");
  await page.getByRole("button", { name: "Place text" }).click();
  const wrappedHeight = await inkHeight(page);
  expect(wrappedHeight).toBeGreaterThan(24);

  await page.getByRole("button", { name: "Undo" }).click();
  expect(await inkPixels(page)).toBe(0);

  // Wide wrap: the same sentence fits on fewer, flatter lines.
  await page.getByRole("button", { name: "Text", exact: true }).click();
  await page.mouse.click(box.x + box.width / 8, box.y + box.height / 8);
  await page.getByRole("button", { name: "12px" }).click();
  await page.getByLabel("Text wrap width").fill("192");
  await page.getByLabel("Text to place").fill("aaaa bbbb cccc dddd");
  await page.getByRole("button", { name: "Place text" }).click();
  const flatHeight = await inkHeight(page);
  expect(flatHeight).toBeLessThan(wrappedHeight);
  // One 12px line: ~12px of glyph ink, well under the multi-line wrapped height.
  expect(flatHeight).toBeLessThanOrEqual(15);
  expectCleanRuntime(watched);
});

test("tiny 8px text marks fewer pixels than large text and undoes cleanly", async ({ page }) => {
  const watched = watchRuntime(page);
  await createVault(page);
  await page.goto("/draw");

  await page.getByRole("button", { name: "Text", exact: true }).click();
  const canvas = page.locator("canvas").first();
  const box = await canvas.boundingBox();
  if (!box) throw new Error("canvas has no bounding box");

  await page.mouse.click(box.x + box.width / 8, box.y + box.height / 8);
  await page.getByRole("button", { name: "8px" }).click();
  await page.getByLabel("Text to place").fill("eic");
  await page.getByRole("button", { name: "Place text" }).click();
  const tinyInk = await inkPixels(page);
  expect(tinyInk).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Undo" }).click();
  expect(await inkPixels(page)).toBe(0);

  await page.getByRole("button", { name: "Text", exact: true }).click();
  await page.mouse.click(box.x + box.width / 8, box.y + box.height / 8);
  await page.getByRole("button", { name: "32px" }).click();
  await page.getByLabel("Text to place").fill("eic");
  await page.getByRole("button", { name: "Place text" }).click();
  const largeInk = await inkPixels(page);
  expect(largeInk).toBeGreaterThan(tinyInk);
  expectCleanRuntime(watched);
});

test("save preview shows the exact encoded bytes and skips uncommitted text", async ({ page }) => {
  const watched = watchRuntime(page);
  await createVault(page);
  await page.goto("/draw");

  await drawStroke(page);
  const strokeInk = await inkPixels(page);
  expect(strokeInk).toBeGreaterThan(0);

  // Arm the text tool with an uncommitted preview, then open the save preview:
  // the preview encodes the drawing only, so the floating text must not appear.
  await page.getByRole("button", { name: "Text", exact: true }).click();
  const canvas = page.locator("canvas").first();
  const box = await canvas.boundingBox();
  if (!box) throw new Error("canvas has no bounding box");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.getByLabel("Text to place").fill("floating");
  expect(await inkPixels(page)).toBeGreaterThan(strokeInk);

  await page.getByRole("button", { name: "Preview save" }).click();
  const full = page.getByRole("img", { name: "Full-size preview of the encoded drawing" });
  const thumb = page.getByRole("img", { name: "Thumbnail preview of the encoded drawing" });
  await expect(full).toBeVisible();
  await expect(thumb).toBeVisible();

  // The preview is the real encoded output: 192px full image, 128px thumbnail.
  const dimensions = await full.evaluate((node) => {
    const img = node as HTMLImageElement;
    return { width: img.naturalWidth, height: img.naturalHeight };
  });
  expect(dimensions).toEqual({ width: 192, height: 192 });
  const thumbDimensions = await thumb.evaluate((node) => {
    const img = node as HTMLImageElement;
    return { width: img.naturalWidth, height: img.naturalHeight };
  });
  expect(thumbDimensions).toEqual({ width: 128, height: 128 });

  // Ink inside the encoded preview matches the stroke-only bitmap: the uncommitted
  // text never entered it.
  const previewInk = await full.evaluate((node) => {
    const img = node as HTMLImageElement;
    const probe = document.createElement("canvas");
    probe.width = img.naturalWidth;
    probe.height = img.naturalHeight;
    const context = probe.getContext("2d");
    if (!context) return -1;
    context.drawImage(img, 0, 0);
    const data = context.getImageData(0, 0, probe.width, probe.height).data;
    let inked = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] < 250 || data[i + 1] < 250 || data[i + 2] < 250) inked += 1;
    }
    return inked;
  });
  expect(previewInk).toBeGreaterThan(0);
  expect(previewInk).toBeLessThanOrEqual(strokeInk + 8);

  // Closing the panel removes it; the live drawing is untouched.
  await page.getByRole("button", { name: "Close preview" }).click();
  await expect(full).toHaveCount(0);
  expect(await inkPixels(page)).toBe(strokeInk);
  expectCleanRuntime(watched);
});

test("text overflow warns visibly instead of silently clipping", async ({ page }) => {
  const watched = watchRuntime(page);
  await createVault(page);
  await page.goto("/draw");

  const warning = page.getByText(/runs past the canvas edge/);
  await expect(warning).toHaveCount(0);

  await page.getByRole("button", { name: "Text", exact: true }).click();
  const canvas = page.locator("canvas").first();
  const box = await canvas.boundingBox();
  if (!box) throw new Error("canvas has no bounding box");

  // Anchor near the bottom with three lines: the block runs past the bottom edge.
  await canvas.click({ position: { x: 20, y: Math.round(box.height * 0.9) } });
  await page.getByLabel("Text to place").fill("one\ntwo\nthree");
  await expect(warning).toBeVisible();
  // The warning persists while the overflow persists - typing more must not clear it,
  // and resizing smaller (still overflowing at this anchor) keeps it visible too.
  await page.getByLabel("Text to place").fill("one\ntwo\nthree\nfour");
  await expect(warning).toBeVisible();
  await page.getByRole("button", { name: "8px" }).click();
  await expect(warning).toBeVisible();
  await page.getByRole("button", { name: "12px" }).click();

  // Move the anchor to the top: the same text fits and the warning clears.
  await canvas.click({ position: { x: 20, y: 8 } });
  await expect(warning).toHaveCount(0);

  // Right-edge overflow: wide wrap with a long word from a right-side anchor.
  await canvas.click({ position: { x: Math.round(box.width * 0.8), y: 8 } });
  await page.getByLabel("Text wrap width").fill("192");
  await page.getByLabel("Text to place").fill("supercalifragilistic");
  await expect(warning).toBeVisible();
  expectCleanRuntime(watched);
});

test("classic toggle hides the new options and the original flow still works", async ({ page }) => {
  const watched = watchRuntime(page);
  await createVault(page);
  await page.goto("/draw");

  // New options are on by default.
  await expect(page.getByRole("button", { name: "Fill background" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Preview save" })).toBeVisible();
  await page.getByRole("button", { name: "Text", exact: true }).click();
  await expect(page.getByRole("button", { name: "8px" })).toBeVisible();
  await expect(page.getByLabel("Text wrap width")).toBeVisible();

  await page.getByLabel(/Classic tools/).check();
  await expect(page.getByRole("button", { name: "Fill background" })).toBeHidden();
  await expect(page.getByRole("button", { name: "Preview save" })).toBeHidden();
  await expect(page.getByRole("button", { name: "8px" })).toBeHidden();
  await expect(page.getByLabel("Text wrap width")).toBeHidden();

  // The original workflow is untouched: stroke, undo, single-line text placement.
  await page.getByRole("button", { name: "Brush" }).click();
  await drawStroke(page);
  expect(await inkPixels(page)).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Undo" }).click();
  expect(await inkPixels(page)).toBe(0);

  await page.getByRole("button", { name: "Text", exact: true }).click();
  const canvas = page.locator("canvas").first();
  const box = await canvas.boundingBox();
  if (!box) throw new Error("canvas has no bounding box");
  await canvas.click({ position: { x: 20, y: 20 } });
  await page.getByLabel("Text to place").fill("classic");
  await page.getByRole("button", { name: "Place text" }).click();
  expect(await inkPixels(page)).toBeGreaterThan(0);

  // Toggling back restores the new options.
  await page.getByLabel(/Classic tools/).uncheck();
  await expect(page.getByRole("button", { name: "Fill background" })).toBeVisible();
  expectCleanRuntime(watched);
});

test("classic toggle preserves paper semantics: eraser still reveals paper", async ({ page }) => {
  const watched = watchRuntime(page);
  await createVault(page);
  await page.goto("/draw");

  // Paint yellow paper, draw black, THEN hide the new options behind Classic tools.
  // Classic hides controls, not behavior: the eraser still reveals the paper color,
  // so no fixed-white semantics sneak back in for an in-progress drawing.
  await page.getByLabel("Paper color #ffff00").click();
  await page.getByRole("button", { name: "Fill background" }).click();
  await drawStroke(page);
  expect(await countColor(page, 0, 0, 0)).toBeGreaterThan(0);

  await page.getByLabel(/Classic tools/).check();
  await expect(page.getByRole("button", { name: "Fill background" })).toBeHidden();

  await page.getByRole("button", { name: "Eraser" }).click();
  await page.getByRole("button", { name: "14px" }).click();
  await drawStroke(page);
  expect(await countColor(page, 0, 0, 0)).toBe(0);
  expect(await countColor(page, 255, 255, 0)).toBe(192 * 192);
  expect(await countColor(page, 255, 255, 255)).toBe(0);

  // Saved output is unaffected by the toggle: the drawing encrypts and renders in feed.
  await page.getByLabel("Title").fill("classic-paper");
  await page.getByRole("button", { name: /Encrypt & save/ }).click();
  await expect(page).toHaveURL(/\/feed$/);
  await expect(page.getByRole("img", { name: "classic-paper" })).toBeVisible();
  expectCleanRuntime(watched);
});

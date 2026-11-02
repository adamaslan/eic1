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


type Pt = [number, number];

// Drag in canvas pixel coordinates (the canvas is 192x192 shown scaled).
async function drag(page: Page, from: Pt, to: Pt, via?: Pt) {
  const canvas = page.locator("canvas").first();
  await canvas.scrollIntoViewIfNeeded();
  const box = await canvas.boundingBox();
  if (!box) throw new Error("canvas has no bounding box");
  const at = ([x, y]: Pt) => [box.x + (x / 192) * box.width, box.y + (y / 192) * box.height] as const;
  await page.mouse.move(...at(from));
  await page.mouse.down();
  if (via) await page.mouse.move(...at(via), { steps: 4 });
  await page.mouse.move(...at(to), { steps: 4 });
  await page.mouse.up();
}

async function colorAt(page: Page, x: number, y: number): Promise<string> {
  return page.locator("canvas").first().evaluate((node, point) => {
    const canvas = node as HTMLCanvasElement;
    const d = canvas.getContext("2d")!.getImageData(point.x, point.y, 1, 1).data;
    return `#${[d[0], d[1], d[2]].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
  }, { x, y });
}

const tool = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const swatch = (page: Page, hex: string) => page.getByRole("button", { name: `Color ${hex}` }).first();

async function open(page: Page) {
  await createVault(page);
  await page.goto("/draw");
  // No hydration wait: goto resolves on load and the toolbar is interactive by then (measured
  // identical on base and patch). The earlier dropped strokes came from scroll, see drag().
}

test("fill bucket floods a closed shape only, and undo restores it", async ({ page }) => {
  const watched = watchRuntime(page);
  await open(page);
  await tool(page, "Rect").click();
  await tool(page, "2px").click();
  await drag(page, [40, 40], [120, 120]);
  const wallInk = await inkPixels(page);
  expect(wallInk).toBeGreaterThan(0);

  await swatch(page, "#ff0000").click();
  await tool(page, "Fill").click();
  await drag(page, [80, 80], [80, 80]);
  expect(await colorAt(page, 80, 80)).toBe("#ff0000");
  expect(await colorAt(page, 5, 5)).toBe("#ffffff");
  expect(await colorAt(page, 150, 150)).toBe("#ffffff");
  expect(await colorAt(page, 40, 80)).toBe("#000000");

  await page.getByRole("button", { name: "Undo" }).click();
  expect(await colorAt(page, 80, 80)).toBe("#ffffff");
  expect(await inkPixels(page)).toBe(wallInk);
  expectCleanRuntime(watched);
});

test("negative control: fill leaks across an open shape and a fill on same color adds no undo step", async ({ page }) => {
  const watched = watchRuntime(page);
  await open(page);
  await tool(page, "Line").click();
  await drag(page, [40, 40], [120, 120]);
  await swatch(page, "#0000ff").click();
  await tool(page, "Fill").click();
  await drag(page, [10, 100], [10, 100]);
  // Open line: both sides are one region, so the far corner is flooded too.
  expect(await colorAt(page, 180, 20)).toBe("#0000ff");
  expect(await colorAt(page, 100, 20)).toBe("#0000ff");
  // Filling the already-blue region again changes nothing and must not push history.
  await drag(page, [180, 20], [180, 20]);
  await page.getByRole("button", { name: "Undo" }).click();
  expect(await colorAt(page, 180, 20)).toBe("#ffffff");
  await expect(page.getByRole("button", { name: "Undo" })).toBeEnabled(); // the line stroke remains
  await page.getByRole("button", { name: "Undo" }).click();
  expect(await inkPixels(page)).toBe(0);
  expectCleanRuntime(watched);
});

test("eyedropper picks a drawn color; picking paper picks white; brush then uses it", async ({ page }) => {
  const watched = watchRuntime(page);
  await open(page);
  await swatch(page, "#ff0000").click();
  await drag(page, [20, 96], [172, 96]);
  await swatch(page, "#0000ff").click();
  await tool(page, "Pick").click();
  await drag(page, [96, 96], [96, 96]);
  await expect(page.getByRole("status").filter({ hasText: "Picked #ff0000" })).toBeVisible();
  await expect(tool(page, "Brush")).toHaveAttribute("aria-pressed", "true");
  await drag(page, [20, 30], [172, 30]);
  expect(await colorAt(page, 96, 30)).toBe("#ff0000");
  expect(await colorAt(page, 96, 30)).not.toBe("#0000ff");

  // Control: picking blank paper picks white, and picking changes no pixels.
  const ink = await inkPixels(page);
  await tool(page, "Pick").click();
  await drag(page, [96, 170], [96, 170]);
  await expect(page.getByRole("status").filter({ hasText: "Picked #ffffff" })).toBeVisible();
  expect(await inkPixels(page)).toBe(ink);
  expectCleanRuntime(watched);
});

test("spray is sparser than the brush, sprays in the chosen color, and undoes in one step", async ({ page }) => {
  const watched = watchRuntime(page);
  await open(page);
  await tool(page, "Brush").click();
  await tool(page, "14px").click();
  await drag(page, [30, 96], [160, 96]);
  const brushInk = await inkPixels(page);
  await page.getByRole("button", { name: "Undo" }).click();

  await swatch(page, "#008000").click();
  await tool(page, "Spray").click();
  await drag(page, [30, 96], [160, 96], [90, 96]);
  const sprayInk = await inkPixels(page);
  expect(sprayInk).toBeGreaterThan(20);
  expect(sprayInk).toBeLessThan(brushInk / 2);
  const palette = await page.locator("canvas").first().evaluate((node) => {
    const c = node as HTMLCanvasElement;
    const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    const seen = new Set<string>();
    for (let i = 0; i < d.length; i += 4) seen.add(`${d[i]},${d[i + 1]},${d[i + 2]}`);
    return [...seen];
  });
  expect(palette.sort()).toEqual(["0,128,0", "255,255,255"]);
  await page.getByRole("button", { name: "Undo" }).click();
  expect(await inkPixels(page)).toBe(0);
  expectCleanRuntime(watched);
});

test("shapes: filled marks more than outline, drag preview leaves no trail, one undo per shape", async ({ page }) => {
  const watched = watchRuntime(page);
  await open(page);
  await tool(page, "Rect").click();
  await tool(page, "2px").click();
  await drag(page, [30, 30], [130, 110]);
  const outline = await inkPixels(page);
  await page.getByRole("button", { name: "Undo" }).click();
  expect(await inkPixels(page)).toBe(0);

  await expect(tool(page, "Fill shapes")).toHaveAttribute("aria-pressed", "false");
  await tool(page, "Fill shapes").click();
  await expect(tool(page, "Fill shapes")).toHaveAttribute("aria-pressed", "true");
  await drag(page, [30, 30], [130, 110]);
  const filled = await inkPixels(page);
  expect(filled).toBeGreaterThan(outline * 3);
  await page.getByRole("button", { name: "Undo" }).click();

  // Rubber band: sweep far out then pull back; final ink must equal a direct small drag.
  await tool(page, "Ellipse").click();
  await expect(tool(page, "Fill shapes")).toHaveAttribute("aria-pressed", "true");
  await drag(page, [60, 60], [90, 90], [180, 180]);
  const pulledBack = await inkPixels(page);
  await page.getByRole("button", { name: "Undo" }).click();
  expect(await inkPixels(page)).toBe(0);
  await drag(page, [60, 60], [90, 90]);
  expect(await inkPixels(page)).toBe(pulledBack);
  expect(pulledBack).toBeGreaterThan(600);
  expect(pulledBack).toBeLessThan(800);
  expectCleanRuntime(watched);
});

test("ellipse defaults to an outline (hollow centre) and Fill shapes makes it solid", async ({ page }) => {
  const watched = watchRuntime(page);
  await open(page);
  await swatch(page, "#0000ff").click();
  await tool(page, "Ellipse").click();
  await drag(page, [40, 40], [150, 150]);
  expect(await colorAt(page, 95, 95)).toBe("#ffffff");
  expect(await colorAt(page, 40, 95)).toBe("#0000ff");
  await page.getByRole("button", { name: "Undo" }).click();
  await tool(page, "Fill shapes").click();
  await drag(page, [40, 40], [150, 150]);
  expect(await colorAt(page, 95, 95)).toBe("#0000ff");
  expectCleanRuntime(watched);
});

test("fine 1px brush marks less than 14px and classic mode hides every new tool", async ({ page }) => {
  const watched = watchRuntime(page);
  await open(page);
  await tool(page, "1px").click();
  await drag(page, [20, 96], [172, 96]);
  const fine = await inkPixels(page);
  await page.getByRole("button", { name: "Undo" }).click();
  await tool(page, "14px").click();
  await drag(page, [20, 96], [172, 96]);
  expect(await inkPixels(page)).toBeGreaterThan(fine * 5);
  expect(fine).toBeGreaterThan(100);

  await tool(page, "Spray").click();
  await page.getByLabel(/Classic tools/).check();
  for (const name of ["Fill", "Pick", "Spray", "Line", "Rect", "Ellipse", "1px", "2px"]) {
    await expect(tool(page, name)).toBeHidden();
  }
  // Falls back to the brush, so a stroke still marks the canvas.
  await expect(tool(page, "Brush")).toHaveAttribute("aria-pressed", "true");
  await expect(tool(page, "14px")).toBeVisible();
  await drag(page, [20, 40], [172, 40]);
  expect(await colorAt(page, 96, 40)).toBe("#000000");
  await page.getByLabel(/Classic tools/).uncheck();
  await expect(tool(page, "Rect")).toBeVisible();
  expectCleanRuntime(watched);
});

test.describe("phone-width (390px) drawing tools", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("new tools fit with no sideways scroll and still draw", async ({ page }) => {
    const watched = watchRuntime(page);
    await open(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    for (const name of ["Fill", "Pick", "Spray", "Line", "Rect", "Ellipse"]) {
      await expect(tool(page, name)).toBeVisible();
    }
    const canvasBox = await page.locator("canvas").first().boundingBox();
    if (!canvasBox) throw new Error("no canvas");
    expect(canvasBox.x + canvasBox.width).toBeLessThanOrEqual(390);
    await tool(page, "Ellipse").click();
    await drag(page, [30, 30], [150, 150]);
    expect(await inkPixels(page)).toBeGreaterThan(100);
    await page.screenshot({ path: "/tmp/shots/phone-tools.png", fullPage: true });
    expectCleanRuntime(watched);
  });
});

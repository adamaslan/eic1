import { expect, test } from "@playwright/test";
import { watchRuntime } from "./fixtures/runtime-watch";

/**
 * Negative control for the shared clean-runtime watcher: blocking the Netlify preview
 * analytics bootstrap must never swallow genuine app errors. A real app-origin
 * console.error and an uncaught page error are still collected, and the standard
 * zero-error assertion shape every spec uses still throws on them.
 */

test("an app-origin console error is still collected and still fails the zero-error assertion", async ({ page }) => {
  const watched = await watchRuntime(page);
  await page.goto("/");
  await page.evaluate(() => console.error("app blew up: Failed to fetch"));
  expect(watched.consoleErrors).toContain("app blew up: Failed to fetch");
  expect(() => {
    const unexpected = watched.consoleErrors.filter((text) => !text.startsWith("Failed to load resource"));
    expect(unexpected, "console errors").toEqual([]);
  }).toThrow();
  expect(watched.pageErrors).toEqual([]);
});

test("an uncaught page error is still collected and still fails the zero-error assertion", async ({ page }) => {
  const watched = await watchRuntime(page);
  await page.goto("/");
  await page.evaluate(() => setTimeout(() => { throw new Error("app exploded"); }, 0));
  await expect.poll(() => watched.pageErrors.length).toBe(1);
  expect(watched.pageErrors[0]).toContain("app exploded");
  expect(() => expect(watched.pageErrors, "uncaught page errors").toEqual([])).toThrow();
});

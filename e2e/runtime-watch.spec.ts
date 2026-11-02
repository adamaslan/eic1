import { expect, test } from "@playwright/test";
import { isKnownPreviewNoise, unexpectedConsoleErrors, watchRuntime } from "./fixtures/runtime-watch";

/**
 * Negative control for the shared clean-runtime watcher: the preview-noise isolation
 * must never swallow genuine app errors. Proves both directions: an app-origin asset
 * 404, an app-origin console.error and an uncaught page error are collected and fail
 * the zero-error assertion, while the aborted Netlify injection chain is excluded by
 * source URL, never by bare text.
 */

test("noise classification is by source URL and fails closed without one", () => {
  const appChunk404 = { text: "Failed to load resource: the server responded with a status of 404 ()", url: "https://deploy-preview-70--everybodyiscool.netlify.app/assets/root-deadbeef.js" };
  const previewBootstrap = { text: "Failed to load resource: net::ERR_FAILED", url: "https://deploy-preview-70--everybodyiscool.netlify.app/.netlify/scripts/cdp" };
  const prodBranding = { text: "Failed to load resource: net::ERR_FAILED", url: "https://everybodyiscool.netlify.app/.netlify/scripts/hud?variant=public" };
  const drawerIframe = { text: "Failed to fetch", url: "https://app.netlify.com/cdp/?deployID=6ae8c4ccdde5a8318cd1f22a&siteID=9b9341be-256b-405a-85e8-b16037e7d3a6&vcs=github" };
  const segmentLoader = { text: "[analytics.js] Failed to load Analytics.js TypeError: Failed to fetch", url: "https://cdn.segment.com/analytics.js/v1/bHbADSxnRvrpFMYP6pMNP38JC4J7Av75/analytics.min.js" };
  const segmentEvents = { text: "Failed to fetch", url: "https://api.segment.io/v1/t" };
  const bareFailedToFetch = { text: "Failed to fetch", url: "" };
  const unrelatedNetlifyAppPage = { text: "Failed to fetch", url: "https://app.netlify.com/teams/adamaslan/projects" };

  expect(isKnownPreviewNoise(appChunk404)).toBe(false);
  expect(isKnownPreviewNoise(previewBootstrap)).toBe(true);
  expect(isKnownPreviewNoise(prodBranding)).toBe(true);
  expect(isKnownPreviewNoise(drawerIframe)).toBe(true);
  expect(isKnownPreviewNoise(segmentLoader)).toBe(true);
  expect(isKnownPreviewNoise(segmentEvents)).toBe(true);
  expect(isKnownPreviewNoise(bareFailedToFetch)).toBe(false);
  expect(isKnownPreviewNoise(unrelatedNetlifyAppPage)).toBe(false);
});

test("a genuine app chunk 404 is collected with its URL and still fails the zero-error assertion", async ({ page }) => {
  const watched = await watchRuntime(page);
  // Netlify's SPA fallback answers missing paths with 200 HTML, so the genuinely
  // missing app asset is simulated at the network layer: the URL is the app's own
  // origin and the 404 is real to the page. This is the review hole - the same
  // "Failed to load resource" text class as preview noise, but an app-asset URL.
  await page.route("**/assets/__missing-chunk-9f4c2a.png", (route) => route.fulfill({ status: 404, body: "not found" }));
  await page.goto("/");
  await page.evaluate(() => {
    const img = new Image();
    img.src = "/assets/__missing-chunk-9f4c2a.png";
    document.body.appendChild(img);
  });
  await expect
    .poll(() => watched.consoleErrors.some((entry) => entry.url.endsWith("/assets/__missing-chunk-9f4c2a.png")))
    .toBe(true);
  const unexpected = unexpectedConsoleErrors(watched.consoleErrors);
  expect(
    unexpected.some((entry) => entry.text.startsWith("Failed to load resource") && entry.url.endsWith("/assets/__missing-chunk-9f4c2a.png")),
    "the app-origin 404 keeps its text class but is not noise, because its URL is an app asset",
  ).toBe(true);
  expect(() => expect(unexpected, "console errors").toEqual([])).toThrow();
});

test("the aborted Netlify injection chain is excluded by source URL", async ({ page }) => {
  const watched = await watchRuntime(page);
  await page.goto("/");
  for (const src of [
    "/.netlify/scripts/cdp",
    "https://cdn.segment.com/analytics.js/v1/test-key/analytics.min.js",
    "https://app.netlify.com/cdp/?deployID=negative-control",
  ]) {
    await page.evaluate((source) => {
      const script = document.createElement("script");
      script.src = source;
      document.head.appendChild(script);
    }, src);
  }
  // Every aborted tag logs "Failed to load resource" with the tag URL as its source.
  await expect
    .poll(() => watched.consoleErrors.filter((entry) => entry.url.includes("cdn.segment.com") || entry.url.includes("app.netlify.com")).length)
    .toBe(2);
  expect(watched.consoleErrors.some((entry) => entry.url.includes("/.netlify/scripts/"))).toBe(true);
  expect(unexpectedConsoleErrors(watched.consoleErrors), "console errors").toEqual([]);
});

test("an app-origin console error is still collected and still fails the zero-error assertion", async ({ page }) => {
  const watched = await watchRuntime(page);
  await page.goto("/");
  await page.evaluate(() => console.error("app blew up: Failed to fetch"));
  const unexpected = unexpectedConsoleErrors(watched.consoleErrors);
  expect(unexpected.map((entry) => entry.text)).toContain("app blew up: Failed to fetch");
  expect(() => expect(unexpected, "console errors").toEqual([])).toThrow();
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

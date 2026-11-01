import { expect, test } from "@playwright/test";
import { watchRuntime } from "./fixtures/runtime-watch";

/**
 * Post-publish production gate (#418 class). Netlify's production free tier rewrites the
 * served HTML (branding comment in <head>, HUD script after </html>); deploy previews never
 * get that rewrite, so preview CI structurally cannot catch a production-only hydration
 * break. This suite runs against the DEPLOYED site after each publish (prod-verify.yml)
 * or by hand with `npm run verify:prod`.
 *
 * It runs only when EIC_TARGET_URL points at a deployed instance; preview CI and local
 * dev runs skip it. EXPECT_BUILD_SHA (the just-published commit) makes the first test
 * double as the deploy wait: the footer's client-rendered build stamp must reach that
 * commit, which proves the served build, not Netlify's claim of it.
 *
 * The error bar is identical to the transition smoke: zero console errors and zero
 * uncaught page errors, filtering only favicon-style failed resource loads. Hydration
 * failures (#418) fall back to a client re-render, so visible UI alone proves nothing -
 * the clean-runtime assertion is the detector.
 */

const expectedSha = process.env.EXPECT_BUILD_SHA?.slice(0, 7);

test.skip(!process.env.EIC_TARGET_URL, "production gate runs only with EIC_TARGET_URL set");

function expectCleanRuntime(watched: { consoleErrors: string[]; pageErrors: string[] }) {
  // Failed resource loads (e.g. favicon) are network noise, not runtime failures.
  const unexpected = watched.consoleErrors.filter((text) => !text.startsWith("Failed to load resource"));
  expect(watched.pageErrors, "uncaught page errors").toEqual([]);
  expect(unexpected, "console errors").toEqual([]);
}

test("deployed build stamp reaches the published commit", async ({ page }) => {
  test.skip(!expectedSha, "EXPECT_BUILD_SHA not set");
  test.setTimeout(15 * 60_000);
  // Netlify publishes asynchronously after the merge; poll hard loads of the landing
  // until the stamp shows the published commit's short sha.
  await expect
    .poll(
      async () => {
        await page.goto("/");
        return (await page.getByText(/build [0-9a-f]{7}/).first().textContent().catch(() => null)) ?? "";
      },
      { timeout: 12 * 60_000, intervals: [15_000, 30_000, 60_000] },
    )
    .toContain(`build ${expectedSha}`);
});

test("production routes hard-load with zero console/page errors", async ({ page }) => {
  const watched = await watchRuntime(page);
  // Hard loads (full document hydration) across the main routes - the #418 failure mode
  // fired on every route, and only a hard load exercises document hydration.
  await page.goto("/");
  await expect(page).toHaveTitle("Everybody is Cool — a private marketplace that lives on your device");

  // Desktop routes redirect locked sessions to /unlock, so open a fresh vault first.
  // The vault lives in this browser's IndexedDB only; nothing is written server-side.
  const passphrase = `prod-gate-passphrase-${Date.now()}`;
  await page.getByRole("link", { name: "Create or open your vault" }).first().click();
  await page.getByLabel("Passphrase", { exact: true }).fill(passphrase);
  await page.getByLabel("Confirm passphrase").fill(passphrase);
  await page.getByRole("button", { name: "Create vault" }).click();
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();

  const routes: Array<[string, string]> = [
    ["/tools", "Tools — Everybody is Cool"],
    ["/feed", "Feed — Everybody is Cool"],
    ["/draw", "untitled - Paint — Everybody is Cool"],
  ];
  for (const [path, title] of routes) {
    await page.goto(path);
    await expect(page, `route ${path} mounted`).toHaveTitle(title);
  }
  expectCleanRuntime(watched);
});

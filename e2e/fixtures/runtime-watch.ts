import type { Page } from "@playwright/test";

/**
 * Shared clean-runtime watcher: collects console errors and uncaught page errors for the
 * per-spec zero-error assertions, and isolates specs from preview analytics noise at the
 * network boundary.
 *
 * Netlify deploy previews inject a CDP bootstrap (<script async src="/.netlify/scripts/cdp">)
 * that loads Segment analytics. When the Segment fetch fails (CI egress), the loader logs
 * "[analytics.js] Failed to load Analytics.js TypeError: Failed to fetch" as a console
 * error, flaking the zero-error assertions (CI run 41391023003: graph.spec, routes.spec).
 * Aborting cdn.segment.com alone was not enough: the loader still runs and still logs.
 * Blocking the bootstrap itself removes the loader; the aborted script tag only yields a
 * "Failed to load resource" line, which every spec already filters. Genuine app console
 * errors - including any app-origin "Failed to fetch" - still fail the spec.
 * Negative control: e2e/runtime-watch.spec.ts proves an app-origin console.error fails.
 * Precedent: the journal-share watchRuntime (0824743).
 */
export async function watchRuntime(page: Page) {
  // Keep this isolation limited to deploy-preview runs. The production gate uses the same
  // watcher and must observe the production page as served, including analytics.
  if (process.env.DEPLOY_PREVIEW_URL && !process.env.EIC_TARGET_URL) {
    await page.route("**/.netlify/scripts/**", (route) => route.abort());
    await page.route("https://cdn.segment.com/**", (route) => route.abort());
  }
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  return { consoleErrors, pageErrors };
}

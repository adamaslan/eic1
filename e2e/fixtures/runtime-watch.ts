import type { Page } from "@playwright/test";

/**
 * Shared clean-runtime watcher: collects console errors and uncaught page errors for the
 * per-spec zero-error assertions, and isolates specs from preview analytics noise at the
 * network boundary.
 *
 * Netlify deploy previews inject Segment analytics (cdn.segment.com) via the CDP preview
 * widget. Its loader's console errors ("[analytics.js] Failed to load Analytics.js
 * TypeError: Failed to fetch") flaked seeded CI across graph, calendar, and draw specs
 * (iterator trace). Aborting the external script keeps the boundary narrow: genuine app
 * console errors - including any app-origin "Failed to fetch" - still fail the spec.
 * Negative control: an injected app-origin console.error("Failed to fetch") fails specs
 * using this watcher. Precedent: the journal-share watchRuntime (0824743).
 */
export async function watchRuntime(page: Page) {
  await page.route("https://cdn.segment.com/**", (route) => route.abort());
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  return { consoleErrors, pageErrors };
}

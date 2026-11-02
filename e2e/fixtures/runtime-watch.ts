import type { Page } from "@playwright/test";

/**
 * Shared clean-runtime watcher: collects console errors with their source URL and
 * uncaught page errors for the per-spec zero-error assertions, and isolates specs from
 * preview analytics noise at the network boundary.
 *
 * Netlify deploy previews inject a CDP bootstrap (<script async src="/.netlify/scripts/cdp">)
 * that iframes https://app.netlify.com/cdp/?deployID=..., which loads Segment analytics
 * (cdn.segment.com loader and bundles, api.segment.io event endpoints). Production
 * injects /.netlify/scripts/hud?variant=public instead. When the Segment fetch fails
 * (CI egress), the loader logs "[analytics.js] Failed to load Analytics.js TypeError:
 * Failed to fetch" plus a bare "Failed to fetch" (CI run 41391023003: graph.spec,
 * routes.spec; run 41489160233: share-link-import-error.spec). Blocking the bootstrap -
 * and, belt-and-braces, the drawer iframe and the Segment CDN - removes that chain; the
 * aborted requests still log "Failed to load resource" console errors.
 *
 * Classification is by source URL, never bare text: message.location().url names the
 * resource or script behind every console error, and only errors proven to come from
 * the injected chain above are noise. A genuine app chunk or media 404 logs the same
 * "Failed to load resource" text but carries the app-origin asset URL, so it still
 * fails the spec. An error without a usable source URL cannot be proven to be noise
 * and fails closed.
 * Negative control: e2e/runtime-watch.spec.ts proves an app-origin 404, an app-origin
 * console.error and an uncaught page error all still fail, while the aborted injected
 * chain is excluded.
 * Precedent: the journal-share watchRuntime (0824743).
 */
export interface ConsoleErrorEntry {
  /** Console message text, e.g. "Failed to load resource: the server responded with a status of 404 ()". */
  text: string;
  /** message.location().url: the resource or script that logged the error; "" when the runtime provides none. */
  url: string;
}

export interface WatchedRuntime {
  consoleErrors: ConsoleErrorEntry[];
  pageErrors: string[];
}

/**
 * Origins and paths only Netlify's preview/prod injection chain can produce, grounded
 * in the deploy-preview network capture and CI run 41489160233: the injected
 * /.netlify/scripts/ bootstrap (any origin), the app.netlify.com/cdp drawer iframe it
 * injects, and the Segment analytics the drawer loads. Anything else - including an
 * unprovenanced bare "Failed to fetch" - is a genuine error and fails the spec.
 */
export function isKnownPreviewNoise(entry: ConsoleErrorEntry): boolean {
  let url: URL;
  try {
    url = new URL(entry.url);
  } catch {
    return false;
  }
  if (url.pathname.startsWith("/.netlify/scripts/")) return true;
  if (url.hostname === "app.netlify.com" && url.pathname.startsWith("/cdp")) return true;
  return url.hostname === "cdn.segment.com" || url.hostname === "api.segment.io";
}

/** Console errors not proven to come from Netlify's injection chain; these must fail the spec. */
export function unexpectedConsoleErrors(entries: ConsoleErrorEntry[]): ConsoleErrorEntry[] {
  return entries.filter((entry) => !isKnownPreviewNoise(entry));
}

export async function watchRuntime(page: Page): Promise<WatchedRuntime> {
  await page.route("**/.netlify/scripts/**", (route) => route.abort());
  await page.route("https://cdn.segment.com/**", (route) => route.abort());
  await page.route("https://app.netlify.com/cdp**", (route) => route.abort());
  const consoleErrors: ConsoleErrorEntry[] = [];
  const pageErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push({ text: message.text(), url: message.location().url ?? "" });
  });
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  return { consoleErrors, pageErrors };
}

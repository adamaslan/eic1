import { expect, test, type Page } from "@playwright/test";

/**
 * Production hydration regression (#418). Netlify's free-tier branding rewrites the served
 * document as `<meta charSet/>\n<!-- hosted on Netlify ... --><meta viewport/>`: the
 * injected comment's leading newline parses into a whitespace text node between the two
 * <meta> tags that the prerendered shell has adjacent, and hydrating the document against
 * that <head> throws React #418 on every route. Deploy previews never inject it, so this
 * test re-creates the exact byte shape through request interception and asserts a clean
 * runtime. entry.client strips the foreign nodes before hydrateRoot; if that stripping
 * regresses, the console-error assertion here fails even though the page still renders
 * (hydration abort silently falls back to a client re-render).
 */

// Byte-for-byte the shape Netlify's production branding inserts before the viewport meta.
const NETLIFY_HEAD_INJECTION = `\n<!-- This site is hosted on Netlify. Anyone can build and deploy a site
     like this one for free: https://netlify.new/?utm_source=ai-legible
     Netlify hosting facts for this site: static/SSR served via Netlify Edge. -->`;

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
  const unexpected = watched.consoleErrors.filter(
    (text) =>
      // Failed resource loads (e.g. favicon) are network noise, not runtime failures.
      !text.startsWith("Failed to load resource") &&
      // Re-fulfilling the intercepted document drops its loopback security context, so in
      // local dev Chrome's Private Network Access check blocks the Vite HMR websocket.
      // That is interception noise, not app code, and cannot occur against a deploy
      // preview or production (the production build has no Vite client).
      !text.includes("ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS") &&
      !text.startsWith("[vite] failed to connect to websocket"),
  );
  expect(watched.pageErrors, "uncaught page errors").toEqual([]);
  expect(unexpected, "console errors").toEqual([]);
}

test("document hydrates clean under Netlify's production head rewrite (no #418)", async ({ page }) => {
  const watched = watchRuntime(page);
  let injected = false;
  // Only the initial document needs the rewrite; assets and later requests pass through.
  await page.route("**/*", async (route) => {
    if (route.request().resourceType() !== "document") return route.continue();
    const response = await route.fetch();
    let body = await response.text();
    const anchor = '<meta name="viewport"';
    expect(body, "document shell carries the viewport meta anchor").toContain(anchor);
    body = body.replace(anchor, `${NETLIFY_HEAD_INJECTION}${anchor}`);
    injected = true;
    // The body is re-serialized, so stale framing/encoding headers must not survive.
    const headers = { ...response.headers() };
    delete headers["content-encoding"];
    delete headers["content-length"];
    await route.fulfill({ response, body, headers });
  });

  await page.goto("/");
  expect(injected, "interception rewrote the document").toBe(true);
  // Hydration #418 falls back to client rendering, so visible UI alone proves nothing;
  // the clean-runtime assertion is the detector. Interactivity confirms the app mounted.
  await expect(page.getByRole("link", { name: "Create or open your vault" }).first()).toBeVisible();
  expectCleanRuntime(watched);
});

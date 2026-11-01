import { expect, test, type Page } from "@playwright/test";

/**
 * All-routes render smoke. Every route mounts and renders its own content - no crash
 * swallowed by the route error boundary ("Oops!"), zero console/page errors. This exists
 * because a hook-order regression (#310) once shipped a route that crashed only when
 * mounted, and CI at the time visited only a subset of routes.
 *
 * Scope: UNLOCKED mounts of every desktop route, in PR CI (the prod gate hard-loads a
 * 3-route subset after deploy; this suite covers the rest on every pull request).
 * /chat/:authorId is covered by chat-link.spec.ts (two-context); /profile/:authorId and
 * /profile share one component, mounted here via /profile.
 */

const REACT_HOOKS_SIGNATURE = /Rendered (more|fewer) hooks|error #310|error #418/i;
const CRASH_HEADING = "Oops!";

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

async function createVault(page: Page) {
  const passphrase = `ci-routes-passphrase-${Date.now()}`;
  await page.goto("/");
  await page.getByRole("link", { name: "Create or open your vault" }).first().click();
  await page.getByLabel("Passphrase", { exact: true }).fill(passphrase);
  await page.getByLabel("Confirm passphrase").fill(passphrase);
  await page.getByRole("button", { name: "Create vault" }).click();
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
}

test("signed-out routes render clean; a bad route gets the honest 404, not a crash", async ({ page }) => {
  const watched = watchRuntime(page);

  await page.goto("/");
  await expect(page).toHaveTitle("Everybody is Cool — a private marketplace that lives on your device");

  await page.goto("/unlock");
  await expect(page.getByRole("button", { name: "Create vault" })).toBeVisible();

  await page.goto("/showcase");
  await expect(page.getByText("Everybody is Cool — primitives")).toBeVisible();

  // Bad-route control: an unknown path renders the real 404 boundary...
  await page.goto("/definitely-not-a-real-eic-route");
  await expect(page.getByRole("heading", { name: "404" })).toBeVisible();
  await expect(page.getByText("The requested page could not be found.")).toBeVisible();
  // ...and none of the signed-out mounts hit the crash boundary.
  await expect(page.getByRole("heading", { name: CRASH_HEADING })).toHaveCount(0);
  expectCleanRuntime(watched);
});

test("every desktop route mounts clean on an unlocked vault", async ({ page }) => {
  const watched = watchRuntime(page);
  await createVault(page);

  const routes: Array<[string, string | RegExp]> = [
    ["/feed", "Feed — Everybody is Cool"],
    ["/market", "Market — Everybody is Cool"],
    ["/compose", "New post — Everybody is Cool"],
    ["/draw", "untitled - Paint — Everybody is Cool"],
    ["/connections", "Connections — Everybody is Cool"],
    ["/tools", "Tools — Everybody is Cool"],
    ["/tools/journal", "Journal — Everybody is Cool"],
    ["/tools/calendar", "Calendar — Everybody is Cool"],
    ["/tools/chores", "Chore chart — Everybody is Cool"],
    ["/vault", "Vault — Everybody is Cool"],
    ["/profile", "Profile — Everybody is Cool"],
  ];
  for (const [path, title] of routes) {
    await page.goto(path);
    await expect(page, `route ${path} mounted with its own document`).toHaveTitle(title);
    await expect(page.getByRole("heading", { name: CRASH_HEADING }), `route ${path} did not crash`).toHaveCount(0);
  }

  // Parameterized item route: seed a listing, open its card link, land on /item/<id>.
  await page.goto("/compose");
  await page.getByRole("radio", { name: "Marketplace listing" }).click();
  const title = `route smoke listing ${Date.now()}`;
  await page.getByLabel("Title").fill(title);
  await page.getByRole("button", { name: /Encrypt & save/ }).click();
  await expect(page).toHaveURL(/\/market$/);
  await page.getByRole("link", { name: title }).first().click();
  await expect(page).toHaveURL(/\/item\/.+/);
  await expect(page).toHaveTitle("Item — Everybody is Cool");
  await expect(page.getByText(`${title}`, { exact: false }).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: CRASH_HEADING })).toHaveCount(0);
  expectCleanRuntime(watched);
});

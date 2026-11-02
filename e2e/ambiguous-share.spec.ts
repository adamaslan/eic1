import { expect, test } from "@playwright/test";

// Feature-gated like share-relay.spec.ts and share-relay-recovery.spec.ts: the app
// path needs VITE_EIC_SHARE_RELAY=on and the functions need EIC_SHARE_RELAY=on; locally
// both are set by playwright.config, and against a remote target this spec runs only
// when EIC_SHARE_RELAY_E2E=on says the relay has been activated there - previews stay
// gated and skip. (Relay-inactive negative control is a separate concern, not skipped
// coverage: it asserts the gated bundle-copy fallback and zero /api/share calls.)
const remoteTarget = process.env.EIC_TARGET_URL ?? process.env.DEPLOY_PREVIEW_URL;

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

test("ambiguous publish shows the honest note, retry reuses the same link", async ({ browser }) => {
  test.skip(Boolean(remoteTarget) && process.env.EIC_SHARE_RELAY_E2E !== "on", "relay gated off on remote targets until activation");
  const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const page = await context.newPage();
  // First publish attempt: abort the POST after it is sent (response lost).
  let intercepted = 0;
  const seenIds: string[] = [];
  await page.route("**/api/share", async (route) => {
    intercepted += 1;
    if (route.request().method() === "POST") seenIds.push(String(route.request().headers()["x-share-id"]));
    if (intercepted === 1) return route.abort();
    return route.continue();
  });
  await page.goto("/");
  await page.getByRole("link", { name: "Create or open your vault" }).first().click();
  await page.getByLabel("Passphrase", { exact: true }).fill("ambiguous-test-pass");
  await page.getByLabel("Confirm passphrase").fill("ambiguous-test-pass");
  await page.getByRole("button", { name: "Create vault" }).click();
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
  await page.goto("/connections");
  await page.getByLabel("Handle").fill("ambig");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Handle saved.")).toBeVisible();
  await page.goto("/compose");
  await page.getByLabel("Title").fill("ambiguous post");
  await page.getByLabel("Notes").fill("body text");
  await page.getByLabel("Choose photos").setInputFiles({ name: "p.png", mimeType: "image/png", buffer: TINY_PNG });
  await page.getByRole("button", { name: /Encrypt & save/ }).click();
  await page.waitForURL("**/feed");
  await page.getByText("ambiguous post").click();
  await page.waitForURL("**/item/**");
  await page.getByRole("button", { name: "↗ Share" }).click();
  // Corrected behavior: the honest ambiguous note (no file fallback) and the pending
  // link's Revoke affordance stays available.
  await expect(page.getByText(/the link may already be live/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Revoke link" })).toBeVisible();
  await page.screenshot({ path: "/downloads/ambiguous-share-note.png", fullPage: true });
  // Retry: same link reused (same id - the pending intent is not retired), success note.
  await page.getByRole("button", { name: "↗ Share" }).click();
  await expect(page.getByText(/Link copied\. It shows this post's photo and text/)).toBeVisible();
  await page.screenshot({ path: "/downloads/ambiguous-share-retry-ok.png", fullPage: true });
  const shareUrl = await page.evaluate(() => navigator.clipboard.readText());
  expect(shareUrl).toMatch(/\/s\/[A-Za-z0-9_-]{16}$/);
  expect(seenIds.length).toBeGreaterThanOrEqual(2);
  expect(new Set(seenIds).size).toBe(1); // both attempts used the SAME provisioned id
});

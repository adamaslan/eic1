import { expect, test, type Page } from "@playwright/test";

/**
 * Share-relay round trip (feature-gated: the app path needs VITE_EIC_SHARE_RELAY=on and
 * the functions need EIC_SHARE_RELAY=on; locally both are set by playwright.config, and
 * against a remote target this spec runs only when EIC_SHARE_RELAY_E2E=on says the relay
 * has been activated there - previews stay gated and skip).
 *
 * Flow under test: the item page's Share publishes the single-post bundle and hands out
 * a short /s/<id> link; the served page carries per-post og:* tags (the iMessage card)
 * and auto-opens the app's READ-ONLY view of the shared post - no import required to
 * read it. Saving is the reader's explicit tap, which runs the standard import prompt.
 * Revoke deletes the share; the link and the in-app view both go honestly dead.
 *
 * Locally the relay is e2e/support/local-relay-server.mjs (same share-core.ts as the
 * Netlify functions). Two isolated browser contexts stand in for sender and recipient.
 * Error bar: zero console errors and zero uncaught page errors in both contexts,
 * filtering favicon-style failed resource loads.
 */

const remoteTarget = process.env.EIC_TARGET_URL ?? process.env.DEPLOY_PREVIEW_URL;

// Real (nonsensitive) photo fixture: a 480x360 rendered scene - sky gradient, sun,
// reflection - generated for this spec, inlined so the branch stays text-only. Distinct
// regions make crop/render regressions visible in screenshots and to the eye.
const SHARE_PHOTO = Buffer.from(
  "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",
  "base64",
);

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
  // Failed resource loads (e.g. favicon) are network noise, not runtime failures.
  const unexpected = watched.consoleErrors.filter((text) => !text.startsWith("Failed to load resource"));
  expect(watched.pageErrors, "uncaught page errors").toEqual([]);
  expect(unexpected, "console errors").toEqual([]);
}

async function createVault(page: Page, passphrase: string) {
  await page.goto("/");
  await page.getByRole("link", { name: "Create or open your vault" }).first().click();
  await page.getByLabel("Passphrase", { exact: true }).fill(passphrase);
  await page.getByLabel("Confirm passphrase").fill(passphrase);
  await page.getByRole("button", { name: "Create vault" }).click();
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
}

async function chooseHandle(page: Page, handle: string) {
  await page.goto("/connections");
  await page.getByLabel("Handle").fill(handle);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Handle saved.")).toBeVisible();
}

test("shared post link previews photo and text, opens read-only in the app, saves on tap, revokes", async ({ browser }) => {
  test.skip(Boolean(remoteTarget) && process.env.EIC_SHARE_RELAY_E2E !== "on", "relay gated off on remote targets until activation");
  const title = `relay share ${Date.now()}`;

  // Sender: vault, handle, a photo post with a real (nonsensitive) photo fixture.
  const contextA = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const pageA = await contextA.newPage();
  const watchedA = watchRuntime(pageA);
  await createVault(pageA, `relay-sender-${Date.now()}`);
  await chooseHandle(pageA, "relaysender");
  await pageA.goto("/compose");
  await pageA.getByLabel("Title").fill(title);
  await pageA.getByLabel("Notes").fill("a photo post travelling by short link");
  await pageA.getByLabel("Choose photos").setInputFiles({ name: "share-photo.png", mimeType: "image/png", buffer: SHARE_PHOTO });
  await expect(pageA.getByText("share-photo.png")).toBeVisible();
  await pageA.getByRole("button", { name: /Encrypt & save/ }).click();
  await pageA.waitForURL("**/feed");
  await pageA.getByText(title).click();
  await pageA.waitForURL("**/item/**");
  await pageA.getByRole("button", { name: "↗ Share" }).click();
  // Desktop chromium has no share sheet: the flow copies the short link.
  await expect(pageA.getByText(/Link copied\. It shows this post's photo and text/)).toBeVisible();
  const shareUrl = await pageA.evaluate(() => navigator.clipboard.readText());
  expect(shareUrl).toMatch(/\/s\/[A-Za-z0-9_-]{16}$/);
  const shareId = shareUrl.split("/s/")[1];
  const relayOrigin = new URL(shareUrl).origin;

  // The crawler-facing page (what iMessage reads): per-post og tags. Asserted on the
  // served HTML - no JavaScript - because preview fetchers do not run any.
  const pageResponse = await pageA.request.get(shareUrl);
  expect(pageResponse.status()).toBe(200);
  const html = await pageResponse.text();
  expect(html).toContain(`property="og:title" content="${title} - from @relaysender on eic"`);
  expect(html).toContain(`property="og:image" content="${relayOrigin}/s/${shareId}/photo"`);
  expect(html).toContain("a photo post travelling by short link");
  // Browsers auto-continue into the app's read-only view.
  expect(html).toContain("/shared/");
  const photoResponse = await pageA.request.get(`${shareUrl}/photo`);
  expect(photoResponse.status()).toBe(200);
  // The app recompresses uploads, so assert an image, not a codec.
  expect(photoResponse.headers()["content-type"]).toMatch(/^image\//);

  // Negative control: a never-published id renders the missing page, not a post.
  const missing = await pageA.request.get(`${relayOrigin}/s/aaaaaaaaaaaaaaah`);
  expect(missing.status()).toBe(404);
  expect(await missing.text()).toContain("That shared post is gone");

  // Recipient: the tap opens eic DIRECTLY to the shared post, read-only - no import.
  const contextB = await browser.newContext();
  const pageB = await contextB.newPage();
  const watchedB = watchRuntime(pageB);
  await createVault(pageB, `relay-recipient-${Date.now()}`);
  await chooseHandle(pageB, "relayfriend");
  await pageB.goto(shareUrl);
  await pageB.waitForURL(/\/shared\//);
  await expect(pageB.getByRole("heading", { name: title })).toBeVisible();
  await expect(pageB.getByRole("img", { name: title })).toBeVisible();
  await expect(pageB.getByText("a photo post travelling by short link")).toBeVisible();
  await expect(pageB.getByText(/from @relaysender/)).toBeVisible();
  await expect(pageB.getByText("Anyone with this link can read this post.")).toBeVisible();
  // Read without saving: the post must NOT be in the recipient's vault yet.
  await pageB.goto("/feed");
  await expect(pageB.getByText(title)).toHaveCount(0);

  // Saving is the explicit tap: back to the shared view, Save, standard import prompt.
  await pageB.goto(`/shared/${shareId}`);
  await expect(pageB.getByRole("heading", { name: title })).toBeVisible();
  await pageB.getByRole("button", { name: "Save to my vault" }).click();
  await expect(pageB.getByText("A friend shared a post with you")).toBeVisible();
  await pageB.getByRole("button", { name: "Import", exact: true }).click();
  await expect(pageB.getByRole("status")).toContainText("Chat unlocked with @relaysender");
  await pageB.getByRole("button", { name: "Close" }).click();
  await pageB.goto("/feed");
  await expect(pageB.getByText(title)).toBeVisible();

  // Revoke: the sender's item page carries the live link; revoking kills both surfaces.
  await pageA.getByRole("button", { name: "Revoke link" }).click();
  await expect(pageA.getByText("Shared link revoked")).toBeVisible();
  const revoked = await pageA.request.get(shareUrl);
  expect(revoked.status()).toBe(404);
  await pageB.goto(`/shared/${shareId}`);
  await expect(pageB.getByText("That shared post is no longer available - it may have been revoked or expired.")).toBeVisible();

  expectCleanRuntime(watchedA);
  expectCleanRuntime(watchedB);
  await contextA.close();
  await contextB.close();
});

import { expect, test, type Page } from "@playwright/test";

/**
 * Recoverable publish UX (feature-gated like share-relay.spec): a lost publish response
 * must never orphan a live link. The first POST is aborted at the network layer - the
 * app's honest "may already be live" note appears and the pending intent stays
 * revocable; the retry reuses the SAME link (server-side idempotent no-op); revoke
 * then kills the link. Screenshots land in test-results for the review pack.
 */

const remoteTarget = process.env.EIC_TARGET_URL ?? process.env.DEPLOY_PREVIEW_URL;

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

test("lost publish response keeps the link revocable and the retry reuses it", async ({ browser }) => {
  test.skip(Boolean(remoteTarget) && process.env.EIC_SHARE_RELAY_E2E !== "on", "relay gated off on remote targets until activation");
  const title = `relay recovery ${Date.now()}`;

  const contextA = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const pageA = await contextA.newPage();
  const watchedA = watchRuntime(pageA);
  await createVault(pageA, `relay-recover-${Date.now()}`);
  await chooseHandle(pageA, "relayrecover");
  await pageA.goto("/compose");
  await pageA.getByLabel("Title").fill(title);
  await pageA.getByLabel("Notes").fill("a post whose first publish answer gets lost");
  await pageA.getByLabel("Choose photos").setInputFiles({
    name: "share-photo.png",
    mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"),
  });
  await expect(pageA.getByText("share-photo.png")).toBeVisible();
  await pageA.getByRole("button", { name: /Encrypt & save/ }).click();
  await pageA.waitForURL("**/feed");
  await pageA.getByText(title).click();
  await pageA.waitForURL("**/item/**");

  // First publish: the request is sent but the response never arrives (network abort).
  let publishedIds: string[] = [];
  await pageA.route("**/api/share", async (route) => {
    if (route.request().method() === "POST") {
      publishedIds.push(String(route.request().headers()["x-share-id"]));
      await route.abort();
    } else {
      await route.continue();
    }
  });
  await pageA.getByRole("button", { name: "↗ Share" }).click();
  // Honest ambiguous outcome: the link may be live; it stays revocable from here.
  await expect(pageA.getByText(/the link may already be live/i)).toBeVisible();
  await expect(pageA.getByRole("button", { name: "Revoke link" })).toBeVisible();
  await pageA.screenshot({ path: "test-results/recovery-1-ambiguous-note.png", fullPage: true });
  expect(publishedIds).toHaveLength(1);

  // Retry: the SAME id is reused (no second link), and the share completes.
  await pageA.unroute("**/api/share");
  await pageA.getByRole("button", { name: "↗ Share" }).click();
  await expect(pageA.getByText(/Link copied\. It shows this post's photo and text/)).toBeVisible();
  const shareUrl = await pageA.evaluate(() => navigator.clipboard.readText());
  expect(shareUrl).toContain(`/s/${publishedIds[0]}`);
  await pageA.screenshot({ path: "test-results/recovery-2-retry-success.png", fullPage: true });

  // The retried link really works for a recipient.
  const pageResponse = await pageA.request.get(shareUrl);
  expect(pageResponse.status()).toBe(200);
  expect(await pageResponse.text()).toContain(`property="og:title" content="${title} - from @relayrecover on eic"`);

  // Revoke after recovery: the link goes honestly dead.
  await pageA.getByRole("button", { name: "Revoke link" }).click();
  await expect(pageA.getByText(/Shared link revoked/)).toBeVisible();
  await pageA.screenshot({ path: "test-results/recovery-3-revoked.png", fullPage: true });
  const gone = await pageA.request.get(shareUrl);
  expect(gone.status()).toBe(404);

  expectCleanRuntime(watchedA);
  await contextA.close();
});

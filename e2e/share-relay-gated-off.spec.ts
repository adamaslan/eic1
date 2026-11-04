import { expect, test } from "@playwright/test";

/**
 * Relay-OFF negative control (the inverse gate of share-relay.spec.ts): on remote
 * targets where the relay has NOT been activated the app must never attempt a publish -
 * the item's Share falls back to the honest bundle copy ("paste it into a message"),
 * and zero requests reach /api/share. Where the function is deployed but gated (deploy
 * previews), a direct API probe answers 404; production serves the SPA shell instead
 * (different contract), so the 404 assertion is preview-only.
 *
 * Runs ONLY on gated remote targets: skipped locally (the local relay is on) and once
 * EIC_SHARE_RELAY_E2E=on marks the target activated. This is what keeps previews green
 * WITHOUT a blind skip of the relay suite - the gated behavior itself is asserted here.
 */

const remoteTarget = process.env.EIC_TARGET_URL ?? process.env.DEPLOY_PREVIEW_URL;
const isDeployPreview = Boolean(remoteTarget && remoteTarget.includes("deploy-preview"));

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

test("relay gated off: share falls back to bundle copy and never calls the relay API", async ({ browser, baseURL, request }) => {
  test.skip(!remoteTarget || process.env.EIC_SHARE_RELAY_E2E === "on", "negative control runs only on gated remote targets");

  const relayCalls: string[] = [];
  const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const page = await context.newPage();
  await page.route("**/api/share**", async (route) => {
    relayCalls.push(`${route.request().method()} ${route.request().url()}`);
    return route.continue();
  });

  await page.goto("/");
  await page.getByRole("link", { name: "Create or open your vault" }).first().click();
  await page.getByLabel("Passphrase", { exact: true }).fill("gated-off-probe-pass");
  await page.getByLabel("Confirm passphrase").fill("gated-off-probe-pass");
  await page.getByRole("button", { name: "Create vault" }).click();
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
  await page.goto("/connections");
  await page.getByLabel("Handle").fill("gatedprobe");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Handle saved.")).toBeVisible();
  await page.goto("/compose");
  await page.getByLabel("Title").fill("gated off post");
  await page.getByLabel("Notes").fill("body text");
  await page.getByLabel("Choose photos").setInputFiles({ name: "p.png", mimeType: "image/png", buffer: TINY_PNG });
  await page.getByRole("button", { name: /Encrypt & save/ }).click();
  await page.waitForURL("**/feed");
  await page.getByText("gated off post").click();
  await page.waitForURL("**/item/**");

  await page.getByRole("button", { name: "↗ Share" }).click();
  // Gated contract: the honest bundle copy, NOT a relay publish (no /s/<id> link, no
  // ambiguous note), and zero relay API traffic observed end to end.
  await expect(page.getByText(/Copied\. Paste it into a message/)).toBeVisible();
  await expect(page.getByText(/the link may already be live/)).toHaveCount(0);
  expect(relayCalls).toEqual([]);

  // Where the function is deployed but gated (deploy previews), the API itself refuses:
  // POST answers 404 JSON. Production serves the SPA shell here instead, so this probe
  // is asserted only against preview targets.
  if (isDeployPreview) {
    const post = await request.post(`${baseURL}/api/share`, {
      headers: { "content-type": "application/json" },
      data: {},
    });
    expect(post.status()).toBe(404);
    expect((await post.json()).error).toBeTruthy();
    const get = await request.get(`${baseURL}/api/share/probe-gated-off`);
    expect(get.status()).toBe(404);
    expect((await get.json()).error).toBeTruthy();
  }
});

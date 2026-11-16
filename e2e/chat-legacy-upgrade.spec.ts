import { expect, test } from "@playwright/test";

test("unsigned chat offers its signed reimport path on desktop and phone", async ({ page }, testInfo) => {
  const passphrase = `legacy-upgrade-${Date.now()}`;
  await page.goto("/unlock");
  await page.getByLabel("Passphrase", { exact: true }).fill(passphrase);
  await page.getByLabel("Confirm passphrase").fill(passphrase);
  await page.getByRole("button", { name: "Create vault" }).click();
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();

  await page.goto("/connections");
  await page.getByLabel("Handle").fill("tester");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Handle saved.")).toBeVisible();
  const legacyBundle = JSON.stringify({
    format: "eic-share", version: 1, exportedAt: "2026-11-01T14:00:00Z",
    author: { id: "sunny01", handle: "sunny" }, posts: [], likes: [], likesComplete: true,
  });
  await page.getByPlaceholder("Paste a shared post here, or drop a .json file anywhere in this box").fill(legacyBundle);
  await page.getByRole("button", { name: "Import pasted text" }).click();
  await expect(page.getByText(/Unsigned file - trust the sender \(@sunny\)/)).toBeVisible();

  await page.goto("/chat/sunny01");
  const warning = page.getByRole("alert");
  await expect(warning).toContainText("chat is read-only");
  await expect(warning).toContainText("relay sync progress restarts when you re-import");
  const upgrade = warning.getByRole("link", { name: "Open Connections to upgrade" });
  await expect(upgrade).toBeVisible();
  await expect(upgrade).toHaveAttribute("href", "/connections");
  await page.evaluate(() => Promise.all(document.getAnimations().filter(animation =>
    animation.effect?.getComputedTiming().iterations !== Infinity
  ).map(animation => animation.finished.catch(() => {}))));
  await page.screenshot({ path: testInfo.outputPath("unsigned-chat-desktop.png"), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(upgrade).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("unsigned-chat-phone.png"), fullPage: true });
  await upgrade.click();
  await expect(page).toHaveURL(/\/connections$/);
});

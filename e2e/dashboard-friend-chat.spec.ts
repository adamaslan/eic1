import { expect, test } from "@playwright/test";

test("dashboard separates private notes from friend chat and keeps notes after reload", async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    window.addEventListener("DOMContentLoaded", () => {
      const label = document.createElement("div");
      label.textContent = "LOCAL PREVIEW · SYNTHETIC VAULT · NOT HOSTED DELIVERY";
      Object.assign(label.style, { position: "fixed", top: "0", left: "0", right: "0", zIndex: "999999", background: "#ffff00", color: "#000", padding: "5px", font: "bold 12px sans-serif", textAlign: "center" });
      document.body.append(label);
    });
  });
  await page.goto("/unlock");
  await page.getByLabel("Passphrase", { exact: true }).fill("local-ui-synthetic-vault-1356");
  await page.getByLabel("Confirm passphrase").fill("local-ui-synthetic-vault-1356");
  await page.getByRole("button", { name: "Create vault" }).click();
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Friend chats", exact: true })).toBeVisible();
  await expect(page.getByText("No connections yet. Add a friend in Connections to open a chat.")).toBeVisible();
  await page.getByLabel("New note", { exact: true }).fill("Synthetic private note, kept locally");
  await page.getByRole("button", { name: "Save note", exact: true }).click();
  await expect(page.getByLabel("New note", { exact: true })).toHaveValue("");
  await expect(page.locator("li").filter({ hasText: "Synthetic private note, kept locally" })).toBeVisible();
  await page.reload();
  await expect(page.locator("li").filter({ hasText: "Synthetic private note, kept locally" })).toBeVisible();
  await page.getByRole("link", { name: "Add or manage connections", exact: true }).click();
  await page.getByLabel("Handle", { exact: true }).fill("local-tester");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Handle saved.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Text my connect link", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Export share file/ })).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Import a share file…", exact: true })).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Copy my chat key link", exact: true })).not.toBeVisible();
  await page.bringToFront();
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    await Promise.all(document.getAnimations().filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity).map((animation) => animation.finished.catch(() => {})));
  });
  await page.screenshot({ path: testInfo.outputPath("simple-connections-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.bringToFront();
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    await Promise.all(document.getAnimations().filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity).map((animation) => animation.finished.catch(() => {})));
  });
  await page.screenshot({ path: testInfo.outputPath("simple-connections-phone.png"), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByText("Older imports and exports", { exact: true }).click();
  await page.getByPlaceholder("Paste a shared post here, or drop a .json file anywhere in this box").fill(JSON.stringify({
    format: "eic-share", version: 1, exportedAt: "2026-11-01T14:00:00Z",
    author: { id: "synthetic-sunny", handle: "sunny" }, posts: [], likes: [], likesComplete: true,
  }));
  await page.getByRole("button", { name: "Import pasted text", exact: true }).click();
  await expect(page.getByText(/Unsigned file - trust the sender/)).toBeVisible();
  await page.goto("/");
  const chat = page.getByRole("link", { name: "Open chat with @sunny", exact: true });
  await expect(chat).toBeVisible();
  await expect(chat).toHaveAttribute("href", "/chat/synthetic-sunny");
  await expect(page.getByText("Read-only until chat key is added", { exact: true })).toBeVisible();
  await expect(page.getByText("Opening a chat does not mean a message was delivered.", { exact: true })).not.toBeVisible();
  await page.getByText("About delivery", { exact: true }).click();
  await expect(page.getByText("Opening a chat does not mean a message was delivered.", { exact: true })).toBeVisible();
  await page.getByText("About delivery", { exact: true }).click();
  await page.bringToFront();
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    await Promise.all(document.getAnimations().filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity).map((animation) => animation.finished.catch(() => {})));
  });
  await page.screenshot({ path: testInfo.outputPath("friend-chat-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await chat.scrollIntoViewIfNeeded();
  await page.bringToFront();
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    await Promise.all(document.getAnimations().filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity).map((animation) => animation.finished.catch(() => {})));
  });
  await page.screenshot({ path: testInfo.outputPath("friend-chat-phone.png"), fullPage: true });
  await chat.click();
  await expect(page).toHaveURL(/\/chat\/synthetic-sunny$/);
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  await expect(page.getByRole("alert")).toContainText("Chat is read-only");
  await expect(page.getByText("Privacy and delivery details", { exact: true })).toBeVisible();
  await expect(page.getByText(/Messages are sealed for @sunny/)).not.toBeVisible();
  await page.bringToFront();
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    await Promise.all(document.getAnimations().filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity).map((animation) => animation.finished.catch(() => {})));
  });
  await page.screenshot({ path: testInfo.outputPath("concise-chat-phone.png"), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.bringToFront();
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    await Promise.all(document.getAnimations().filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity).map((animation) => animation.finished.catch(() => {})));
  });
  await page.screenshot({ path: testInfo.outputPath("concise-chat-desktop.png"), fullPage: true });
});

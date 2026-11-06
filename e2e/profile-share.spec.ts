import { expect, test, type Page } from "@playwright/test";
import { unexpectedConsoleErrors, watchRuntime, type WatchedRuntime } from "./fixtures/runtime-watch";

/**
 * Share profile = the connect link plus a display-only preview of the SELECTED feed fields.
 * Owner sees exactly what is included before sharing; the recipient sees the preview before
 * the explicit connect tap. The private (unselected) draft bio never leaves the vault.
 */

function expectCleanRuntime(watched: WatchedRuntime) {
  const unexpected = unexpectedConsoleErrors(watched.consoleErrors);
  expect(watched.pageErrors, "uncaught page errors").toEqual([]);
  expect(unexpected, "console errors").toEqual([]);
}

test.setTimeout(240_000);

let vaultCounter = 0;

async function createVault(page: Page, handle: string) {
  vaultCounter += 1;
  const passphrase = `profile-share-passphrase-${Date.now()}-${vaultCounter}`;
  if (new URL(page.url()).pathname !== "/") await page.goto("/");
  await page.getByRole("link", { name: "Create or open your vault" }).first().click();
  await page.getByLabel("Passphrase", { exact: true }).fill(passphrase);
  await page.getByLabel("Confirm passphrase").fill(passphrase);
  await page.getByRole("button", { name: "Create vault" }).click();
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
  await page.goto("/connections");
  await page.getByLabel("Handle").fill(handle);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Handle saved.")).toBeVisible();
}

async function stubShareCapture(page: Page) {
  await page.addInitScript(() => {
    const shared: string[] = [];
    (window as unknown as { __shared: string[] }).__shared = shared;
    Object.defineProperty(navigator.clipboard, "writeText", { value: async (text: string) => { shared.push(text); }, configurable: true });
  });
}

async function lastCopiedLink(page: Page): Promise<string> {
  const text = await page.evaluate(() => (window as unknown as { __shared: string[] }).__shared.at(-1));
  expect(text).toBeTruthy();
  const link = text!.split(/\s+/).find((token) => token.startsWith("http"));
  expect(link).toBeTruthy();
  return link!;
}

function decodeConnectCard(link: string): { author: { handle: string }; profile?: { displayName: string; bio: string } } {
  const payload = link.split("#connect=")[1];
  const base64 = payload.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(padded), (c) => c.charCodeAt(0))));
}

async function setStudioBio(page: Page, displayName: string, bio: string, selectBio: boolean) {
  await page.goto("/profile");
  await page.getByRole("button", { name: "Customize profile" }).click();
  await page.getByLabel("Display name (always in feed profile)").fill(displayName);
  await page.getByLabel(/^Bio \(/).fill(bio);
  if (selectBio) await page.getByRole("checkbox", { name: "Bio", exact: true }).check();
  await page.getByRole("button", { name: "Save private draft", exact: true }).click();
  await expect(page.getByRole("status").first()).toBeVisible();
}

test("owner shares selected profile fields; recipient sees the preview and connects explicitly", async ({ browser }) => {
  const ownerContext = await browser.newContext();
  const friendContext = await browser.newContext();
  const owner = await ownerContext.newPage();
  const friend = await friendContext.newPage();
  const watchedOwner = await watchRuntime(owner);
  const watchedFriend = await watchRuntime(friend);
  await stubShareCapture(owner);

  await createVault(owner, "ada-owner");
  await setStudioBio(owner, "Ada Lovelink", "Selected bio for sharing", true);

  // The owner sees exactly what is included before anything leaves the vault.
  await expect(owner.getByText("What the link includes:")).toBeVisible();
  await expect(owner.getByText(/plus your selected bio/)).toBeVisible();
  await owner.getByRole("button", { name: "Share profile" }).click();
  await expect(owner.getByText(/Profile link copied/)).toBeVisible();
  const link = await lastCopiedLink(owner);
  expect(link).toContain("#connect=");
  const card = decodeConnectCard(link);
  expect(card.profile).toEqual({ displayName: "Ada Lovelink", bio: "Selected bio for sharing" });
  expect(card.author.handle).toBe("ada-owner");

  // The recipient (existing user, handle already set) sees the preview before the explicit tap.
  await createVault(friend, "fynn-friend");
  await friend.goto(link, { waitUntil: "domcontentloaded" });
  await expect(friend.getByText("A friend wants to connect")).toBeVisible();
  await expect(friend.getByText("Ada Lovelink")).toBeVisible();
  await expect(friend.getByText("Selected bio for sharing")).toBeVisible();
  await expect(friend.getByText(/NOT signed, not verified/)).toBeVisible();
  await expect(friend.getByText(/Nothing else: no posts/)).not.toBeVisible();
  await friend.getByRole("button", { name: "Add and open chat" }).click();
  await expect(friend).toHaveURL(/\/chat\//);

  // The connection actually exists afterwards.
  await friend.goto("/connections");
  await expect(friend.getByText("@ada-owner")).toBeVisible();

  expectCleanRuntime(watchedOwner);
  expectCleanRuntime(watchedFriend);
  await ownerContext.close();
  await friendContext.close();
});

test("an unselected private bio never leaves the vault through the share link", async ({ page }) => {
  const watched = await watchRuntime(page);
  await stubShareCapture(page);
  await createVault(page, "pam-private");
  await setStudioBio(page, "Pam Private", "private-unselected-marker", false);

  await expect(page.getByText(/plus your selected bio/)).toHaveCount(0);
  await page.getByRole("button", { name: "Share profile" }).click();
  await expect(page.getByText(/Profile link copied/)).toBeVisible();
  const link = await lastCopiedLink(page);
  expect(link).not.toContain("private-unselected-marker");
  const card = decodeConnectCard(link);
  expect(card.profile?.displayName).toBe("Pam Private");
  expect(card.profile?.bio ?? "").toBe("");
  expectCleanRuntime(watched);
});

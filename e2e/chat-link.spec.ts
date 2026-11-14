import { expect, test, type Page } from "@playwright/test";
import { SubtleCryptoPort } from "@veil/crypto";
import { createVault } from "@veil/vault";
import { MemoryStore } from "../packages/vault/src/memory-store";
import { buildChatShareLink, buildConnectLink, importConnectCard, readConnectLink } from "../packages/features/src/chat-link";
import { defaultSettings, listConnections, saveSettings } from "../packages/features/src/social";
import { sendChatMessage } from "../packages/features/src/chat";

/**
 * Current relay-only chat contract at a real phone viewport. Signed connect links
 * still add connections; an endpoint-unset build must never claim remote delivery.
 * Incoming legacy fragments are exercised below through the real root/pending-slot UI;
 * package unit tests separately cover decoding/crypto details.
 * signed two-vault delivery is covered by the opt-in memory-backed relay E2E fixture.
 * navigator.share/clipboard are stubbed so the test can capture the link a user would text.
 */

test.use({ viewport: { width: 390, height: 844 } });
test.setTimeout(240_000);

let vaultCounter = 0;

async function stubShareCapture(page: Page) {
  await page.addInitScript(() => {
    const shared: string[] = [];
    (window as unknown as { __shared: string[] }).__shared = shared;
    Object.defineProperty(navigator, "share", { value: async ({ text }: { text: string }) => { shared.push(text); }, configurable: true });
    Object.defineProperty(navigator.clipboard, "writeText", { value: async (text: string) => { shared.push(text); }, configurable: true });
  });
}

async function createVaultWithHandle(page: Page, handle: string) {
  vaultCounter += 1;
  const passphrase = `chat-link-passphrase-${Date.now()}-${vaultCounter}`;
  await page.goto("/");
  await page.getByRole("link", { name: "Create or open your vault" }).first().click();
  await page.getByLabel("Passphrase", { exact: true }).fill(passphrase);
  await page.getByLabel("Confirm passphrase").fill(passphrase);
  await page.getByRole("button", { name: "Create vault" }).click();
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
  await page.goto("/connections");
  await page.getByLabel("Handle").fill(handle);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Handle saved.")).toBeVisible();
}

async function lastSharedLink(page: Page): Promise<string> {
  const text = await page.evaluate(() => (window as unknown as { __shared: string[] }).__shared.at(-1));
  expect(text).toBeTruthy();
  const match = text!.match(/https?:\/\/\S+/);
  expect(match, "shared text ends in one link").toBeTruthy();
  return match![0];
}

test("signed connect links open the right chat; endpoint-unset sends stay local", async ({ browser }, testInfo) => {
  const aliceContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const bobContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    const alice = await aliceContext.newPage(), bob = await bobContext.newPage();
    await stubShareCapture(alice); await stubShareCapture(bob);
    await Promise.all([createVaultWithHandle(alice, "alice"), createVaultWithHandle(bob, "bob")]);
    await alice.getByRole("button", { name: "Text my connect link" }).click();
    await expect(alice.getByText(/Connect link shared/)).toBeVisible();
    const aliceLink = await lastSharedLink(alice);
    await bob.goto(aliceLink);
    await expect(bob.getByText("A friend wants to connect")).toBeVisible();
    await bob.getByRole("button", { name: "Add and open chat" }).click();
    await expect(bob.getByText("Chat with @alice")).toBeVisible();
    await expect(bob.getByText(/This build has no relay endpoint/)).toBeVisible();
    await expect(bob.getByRole("button", { name: "Text a chat link" })).toHaveCount(0);
    await bob.getByLabel("Message", { exact: true }).fill("synthetic endpoint-unset local message");
    await bob.getByRole("button", { name: "Send", exact: true }).click();
    await expect(bob.getByText("synthetic endpoint-unset local message", { exact: true })).toHaveCount(1);
    await expect(bob.getByText(/cannot reach your friend until the relay is set up/)).toBeVisible();
    await bob.reload();
    await expect(bob.getByText("synthetic endpoint-unset local message", { exact: true })).toHaveCount(1);
    const options = bob.locator('details').filter({ has: bob.getByText("Relay options", { exact: true }) });
    await options.locator("summary").click();
    for (const name of ["Set up relay feed", "Check for messages", "Retry relay send"]) {
      await bob.getByRole("button", { name, exact: true }).click();
      await expect(bob.getByText(/This build has no relay endpoint/)).toBeVisible();
    }
    await bob.screenshot({ path: testInfo.outputPath("endpoint-unset-mobile.png"), fullPage: true });
    await bob.goto("/connections");
    await bob.getByRole("button", { name: "Text my connect link" }).click();
    await expect(bob.getByText(/Connect link shared/)).toBeVisible();
    await alice.goto(await lastSharedLink(bob));
    await alice.getByRole("button", { name: "Add and open chat" }).click();
    await expect(alice.getByText("Chat with @bob")).toBeVisible();
    await expect(alice.getByText("synthetic endpoint-unset local message", { exact: true })).toHaveCount(0);
    await expect(alice.getByRole("button", { name: "Text a chat link" })).toHaveCount(0);
  } finally { await aliceContext.close(); await bobContext.close(); }
});


test("incoming legacy chat fragment: stranger stash binds after resume, connect opens it, second tap is idempotent", async ({ page }, testInfo) => {
  await stubShareCapture(page);
  await createVaultWithHandle(page, "carol");
  await page.getByRole("button", { name: "Text my connect link" }).click();
  await expect(page.getByText(/Connect link shared/)).toBeVisible();
  const recipientLink = await lastSharedLink(page);

  // Only the retired outgoing UI is bypassed. Use the exported production builder to
  // seal a real synthetic message to this browser vault's signed public key.
  const now = new Date();
  const sender = await createVault({ store: new MemoryStore(), crypto: new SubtleCryptoPort(), now: () => now }, "synthetic-legacy-sender-only");
  try {
    const settings = { ...defaultSettings(), authorId: "legacy-bob", handle: "bob" };
    await saveSettings(sender, settings);
    await importConnectCard(sender, readConnectLink(new URL(recipientLink).hash)!, { settings, newId: () => "legacy-connect", now });
    const connection = (await listConnections(sender))[0];
    expect(connection).toBeTruthy();
    const message = "synthetic incoming compatibility message";
    await sendChatMessage(sender, connection, message, { newId: () => "legacy-message", now: () => now });
    const baseUrl = `${new URL(page.url()).origin}/`;
    const { link } = await buildChatShareLink(sender, connection, baseUrl);
    const connectLink = await buildConnectLink(sender, baseUrl, now);
    expect(link).toContain("#chat=");
    expect(link).not.toContain(message);

    // Fresh navigation exercises hash watcher + session slot + vault rehydration.
    await page.goto(link);
    await expect(page.getByText(/not a connection yet/)).toBeVisible();
    await expect.poll(() => page.evaluate(() => {
      const raw = sessionStorage.getItem("eic.pendingLink.v2.chat");
      return raw ? JSON.parse(raw).forAuthorId : null;
    }), { message: "stranger fragment binds to the resumed recipient vault" }).toBeTruthy();
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page.goto(connectLink);
    await page.getByRole("button", { name: "Add and open chat" }).click();
    await expect(page).toHaveURL(/\/chat\/legacy-bob$/);
    await expect(page.getByText("Chat with @bob")).toBeVisible();
    await expect(page.getByText(message, { exact: true })).toHaveCount(1);
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem("eic.pendingLink.v2.chat"))).toBeNull();
    await page.goto(link);
    await expect(page).toHaveURL(/\/chat\/legacy-bob$/);
    await expect(page.getByText(message, { exact: true })).toHaveCount(1);
    await expect(page.locator(".fixed.inset-0.z-50")).toHaveCount(0);
    // The route and window entrance animations change opacity after the overlay is gone.
    // Wait only finite animations, not any decorative infinite animation.
    await page.evaluate(() => Promise.all(document.getAnimations().filter(animation =>
      animation.effect?.getComputedTiming().iterations !== Infinity
    ).map(animation => animation.finished.catch(() => {}))));
    await page.screenshot({ path: testInfo.outputPath("incoming-legacy-mobile.png"), fullPage: true });
  } finally { sender.lock(); }
});

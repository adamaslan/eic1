import { expect, test, type Browser, type Page } from "@playwright/test";

/**
 * The cute phone-text flow, end to end at a real phone viewport: a connect link adds a
 * connection with no JSON file, and a chat link opens eic straight into the conversation.
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

test("connect link + chat link: tap opens straight into the conversation", async ({ browser }) => {
  const aliceContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const bobContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const alice = await aliceContext.newPage();
  const bob = await bobContext.newPage();
  await stubShareCapture(alice);
  await stubShareCapture(bob);

  await Promise.all([createVaultWithHandle(alice, "alice"), createVaultWithHandle(bob, "bob")]);

  // 1. Alice texts her connect link; bob taps it, confirms, lands in the chat with her.
  await alice.getByRole("button", { name: "Text my connect link" }).click();
  await expect(alice.getByText(/Connect link shared/)).toBeVisible();
  const aliceConnectLink = await lastSharedLink(alice);
  await bob.goto(aliceConnectLink);
  await expect(bob.getByText("A friend wants to connect")).toBeVisible();
  await bob.screenshot({ path: "/downloads/eic-chat-link-shots/1-connect-confirm.png" });
  await bob.getByRole("button", { name: "Add and open chat" }).click();
  await expect(bob).toHaveURL(/\/chat\/.+/);
  await expect(bob.getByText("Chat with @alice")).toBeVisible();
  const bobChatWithAlice = bob.url();

  // 2. Bob texts his connect link back; alice taps it and lands in the chat with him.
  await bob.goto("/connections");
  await bob.getByRole("button", { name: "Text my connect link" }).click();
  await expect(bob.getByText(/Connect link shared/)).toBeVisible();
  const bobConnectLink = await lastSharedLink(bob);
  await alice.goto(bobConnectLink);
  await alice.getByRole("button", { name: "Add and open chat" }).click();
  await expect(alice).toHaveURL(/\/chat\/.+/);
  await expect(alice.getByText("Chat with @bob")).toBeVisible();
  const aliceChatWithBob = alice.url();

  // 3. Bob writes a message and texts the chat link.
  await bob.goto(bobChatWithAlice);
  await bob.getByLabel("Message").fill("hi alice - one tap and you are right here 💌");
  await bob.getByRole("button", { name: "Send", exact: true }).click();
  await expect(bob.getByText("hi alice - one tap and you are right here 💌")).toBeVisible();
  await bob.getByRole("button", { name: "Text a chat link" }).click();
  await expect(bob.getByText(/Shared - one tap opens right into this chat/)).toBeVisible();
  await bob.screenshot({ path: "/downloads/eic-chat-link-shots/2-bob-chat-mobile.png", fullPage: true });
  const chatLink = await lastSharedLink(bob);
  expect(chatLink).toContain("#chat=");

  // 4. Alice taps the link in her text thread: eic opens straight into the conversation.
  await alice.goto(chatLink);
  await expect(alice).toHaveURL(aliceChatWithBob);
  await expect(alice.getByText("hi alice - one tap and you are right here 💌")).toBeVisible();
  await alice.screenshot({ path: "/downloads/eic-chat-link-shots/3-alice-chat-opened.png", fullPage: true });

  // 5. A second tap of the same link is idempotent: still one copy of the message.
  await alice.goto(chatLink);
  await expect(alice).toHaveURL(aliceChatWithBob);
  await expect(alice.getByText("hi alice - one tap and you are right here 💌")).toHaveCount(1);

  await aliceContext.close();
  await bobContext.close();
});

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

test("connect link + chat link: tap opens straight into the conversation", async ({ browser }, testInfo) => {
  const aliceContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const bobContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const alice = await aliceContext.newPage();
  const bob = await bobContext.newPage();
  await alice.clock.install();
  await stubShareCapture(alice);
  await stubShareCapture(bob);

  await Promise.all([createVaultWithHandle(alice, "alice"), createVaultWithHandle(bob, "bob")]);

  // 1. Alice texts her connect link; bob taps it, confirms, lands in the chat with her.
  await alice.getByRole("button", { name: "Text my connect link" }).click();
  await expect(alice.getByText(/Connect link shared/)).toBeVisible();
  const aliceConnectLink = await lastSharedLink(alice);
  await bob.goto(aliceConnectLink);
  await expect(bob.getByText("A friend wants to connect")).toBeVisible();
  await bob.screenshot({ path: testInfo.outputPath("1-connect-confirm.png") });
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
  await expect(bob.getByText(/Shared through your phone's share sheet/)).toBeVisible();
  await bob.screenshot({ path: testInfo.outputPath("2-bob-chat-mobile.png"), fullPage: true });
  const chatLink = await lastSharedLink(bob);
  expect(chatLink).toContain("#chat=");

  // More than the previous one-hour session, but within the new fixed eight hours.
  for (let halfHour = 0; halfHour < 4; halfHour += 1) {
    await alice.clock.fastForward(30 * 60_000);
    await alice.mouse.click(380, 700);
  }

  // 4. Alice taps the link in her text thread: eic opens straight into the conversation.
  await alice.goto(chatLink);
  await expect(alice).toHaveURL(aliceChatWithBob);
  await expect(alice.getByText("hi alice - one tap and you are right here 💌")).toBeVisible();
  await alice.screenshot({ path: testInfo.outputPath("3-alice-chat-opened.png"), fullPage: true });

  // 5. A second tap of the same link is idempotent: still one copy of the message.
  await alice.goto(chatLink);
  await expect(alice).toHaveURL(aliceChatWithBob);
  await expect(alice.getByText("hi alice - one tap and you are right here 💌")).toHaveCount(1);

  await aliceContext.close();
  await bobContext.close();
});

test("chat link before connecting: kept, then opens on its own once connected", async ({ browser }) => {
  // The core one-tap flow for a brand-new friend: the chat link arrives first, cannot apply
  // yet (sender not a connection), and must NOT be consumed - after the connect link lands,
  // the stashed chat link applies without a re-tap.
  const bobContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const carolContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const bob = await bobContext.newPage();
  const carol = await carolContext.newPage();
  await stubShareCapture(bob);
  await stubShareCapture(carol);
  await Promise.all([createVaultWithHandle(bob, "bob"), createVaultWithHandle(carol, "carol")]);

  // Carol texts bob her connect link so he has her key and can seal messages to her.
  await carol.getByRole("button", { name: "Text my connect link" }).click();
  await expect(carol.getByText(/Connect link shared/)).toBeVisible();
  const carolConnectLink = await lastSharedLink(carol);
  await bob.goto(carolConnectLink);
  await bob.getByRole("button", { name: "Add and open chat" }).click();
  await expect(bob).toHaveURL(/\/chat\/.+/);

  // Bob writes carol a message and texts BOTH his connect link and the chat link.
  await bob.getByLabel("Message").fill("hi carol - no file, just a tap 💌");
  await bob.getByRole("button", { name: "Send", exact: true }).click();
  await expect(bob.getByText("hi carol - no file, just a tap 💌")).toBeVisible();
  await bob.getByRole("button", { name: "Text a chat link" }).click();
  await expect(bob.getByText(/Shared through your phone's share sheet/)).toBeVisible();
  const chatLink = await lastSharedLink(bob);
  expect(chatLink).toContain("#chat=");
  await bob.goto("/connections");
  await bob.getByRole("button", { name: "Text my connect link" }).click();
  await expect(bob.getByText(/Connect link shared/)).toBeVisible();
  const bobConnectLink = await lastSharedLink(bob);

  // Carol taps the chat link first: honest not-a-connection message, and the link is kept.
  await carol.goto(chatLink);
  await expect(carol.getByText(/not a connection yet/)).toBeVisible();
  // Regression: the tap is a fresh page load, so the slot starts unbound (forAuthorId null)
  // while the vault rehydrates - it MUST bind to carol's vault once the handler reads it,
  // or the cross-vault guard never engages on the primary tap path.
  const slot = await carol.evaluate(() => sessionStorage.getItem("eic.pendingLink.v2.chat"));
  expect(slot, "chat link kept in its slot").toBeTruthy();
  // Binding is async: the vault finishes resuming after the tap stashed the link, then the
  // slot binds. Poll so the assertion checks the guarantee, not the timing.
  await expect
    .poll(
      async () =>
        carol.evaluate(() => {
          const raw = sessionStorage.getItem("eic.pendingLink.v2.chat");
          return raw ? (JSON.parse(raw).forAuthorId as string | null) : null;
        }),
      { message: "slot bound to the resumed vault, not left null" },
    )
    .toBeTruthy();
  await carol.getByRole("button", { name: "Close" }).click();

  // Then the connect link: one confirm, and the waiting chat link applies on its own -
  // the message appears without carol re-tapping the first link.
  await carol.goto(bobConnectLink);
  await carol.getByRole("button", { name: "Add and open chat" }).click();
  await expect(carol).toHaveURL(/\/chat\/.+/);
  await expect(carol.getByText("Chat with @bob")).toBeVisible();
  await expect(carol.getByText("hi carol - no file, just a tap 💌")).toBeVisible();

  await bobContext.close();
  await carolContext.close();
});

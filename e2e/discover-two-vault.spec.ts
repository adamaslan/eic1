import { test, expect, type Page, type BrowserContext, type Route } from '@playwright/test';
import { createRelayHttpHandler } from '../packages/features/src/relay-http';
import type { RelayAtomicStore, StoreEntry } from '../packages/features/src/relay-adapter';
import { createMemoryRelayMembership } from '../packages/features/src/relay-enroll';
import { DirectoryService, admitDirectoryPrincipal, emptyDirectory, type DirectoryAtomicStore, type DirectoryDatabase } from '../packages/features/src/discover-directory';
import { unexpectedConsoleErrors, watchRuntime } from './fixtures/runtime-watch';

// Synthetic-data proof of Discover -> request -> accept -> chat. Every vault, key, relay row and message is
// created here and discarded with the browser contexts. The relay is an in-memory handler behind route
// interception: this is NOT hosted Supabase and proves nothing about the deployed relay.
test.skip(process.env.EIC_LOCAL_RELAY_TEST !== '1', 'Opt-in local memory-backed relay fixture, not deployed Supabase evidence');
test.setTimeout(420_000);
test.use({ actionTimeout: 60_000 });

const ENDPOINT = 'http://127.0.0.1:54321/functions/v1/eic-relay';
const PASS = 'local-test-only-vault-20261120';
const shots = (name: string) => `${process.env.EIC_PROOF_DIR ?? 'test-results'}/${name}.png`;

class MemoryDirectory implements DirectoryAtomicStore {
  generation = 0; value: DirectoryDatabase = emptyDirectory();
  async read() { return { generation: String(this.generation), value: structuredClone(this.value) }; }
  async compareAndSet(expected: string, next: DirectoryDatabase) {
    if (expected !== String(this.generation)) return false;
    this.value = structuredClone(next); this.generation += 1; return true;
  }
}

function relayFixture(appOrigin: string) {
  const rows = new Map<string, StoreEntry>(); let generation = 0;
  const store: RelayAtomicStore = {
    async get(key) { return rows.get(key) ?? null; },
    async compareAndSet(key, data, condition) {
      const old = rows.get(key);
      if ('createOnly' in condition ? !!old : old?.generation !== condition.generation) return null;
      const next = String(++generation); rows.set(key, { data, generation: next }); return next;
    },
    async putObject(key, data) { const old = rows.get(key); if (old && old.data !== data) throw Error('immutable'); rows.set(key, { data, generation: String(++generation) }); },
    async list(prefix, options) { return { keys: [...rows.keys()].filter((k) => k.startsWith(prefix) && (!options?.cursor || k > options.cursor)).sort().slice(0, options?.limit ?? 100) }; },
    async delete(key) { rows.delete(key); },
  };
  const membership = createMemoryRelayMembership([]);
  const directoryStore = new MemoryDirectory();
  const usedTokens = new Set<string>();
  const control = {
    offline: false,
    sawOffline: false,
    /** Added to the relay's clock, kept equal to how far the page clocks were fast-forwarded. */
    skewMs: 0,
    /** Store the request, then drop the response: the client cannot tell whether it landed. */
    dropResponseFor: null as null | 'publish' | 'directory',
    dropped: 0,
    counts: { publish: 0, read: 0, chunk: 0, enroll: 0, directory: 0 } as Record<string, number>,
    directoryActions: [] as string[],
    turnstileChecks: 0,
    /** Every directory response body, to prove what a third party can and cannot see. */
    directoryReplies: [] as { principal: string; body: string }[],
  };
  const directory = new DirectoryService(directoryStore, (principal, pubkey) => admitDirectoryPrincipal((pk) => membership.isMember(pk), principal, pubkey), () => Date.now() + control.skewMs);
  async function handle(route: Route) {
    const request = route.request();
    const action = request.url().split('/').pop() ?? '';
    if (action in control.counts) control.counts[action]++;
    if (control.offline) { control.sawOffline = true; await route.abort('internetdisconnected'); return; }
    const body = request.postData() ?? '';
    let directoryPrincipal = '';
    if (action === 'directory') { try { const parsed = JSON.parse(body) as { command: { action: string; principal: string } }; control.directoryActions.push(parsed.command.action); directoryPrincipal = parsed.command.principal; } catch { /* bad body is the handler's problem */ } }
    const response = await createRelayHttpHandler(store, {
      enabled: true, membership, origins: [appOrigin], maxPublishesPerWindow: 50, windowMs: 60_000, now: () => new Date(Date.now() + control.skewMs), directory,
      selfEnroll: {
        async verifyTurnstile(token) { control.turnstileChecks++; if (!/^synthetic-token-[a-z0-9-]+-\d+$/.test(token) || usedTokens.has(token)) return false; usedTokens.add(token); return true; },
        async claimDailySlot() { return true; },
      },
    })(new Request(request.url(), { method: request.method(), headers: request.headers(), body: request.method() === 'GET' ? undefined : body }));
    const text = await response.text();
    if (process.env.EIC_PROOF_DEBUG) { let who = ''; try { const b = JSON.parse(body) as { pubkey?: string; feedPath?: string; chunkId?: string }; who = `reader=${(b.pubkey ?? '').slice(0, 6)} feed=${(b.feedPath ?? '').slice(-8)} chunk=${b.chunkId ?? '-'}`; } catch { /* not json */ } console.log(`relay ${action} ${who} -> ${response.status} ${action === 'publish' ? text.slice(0, 80) : ''}`); }
    if (action === 'directory') control.directoryReplies.push({ principal: directoryPrincipal, body: text });
    if (control.dropResponseFor === action) { control.dropResponseFor = null; control.dropped++; await route.abort('connectionreset'); return; }
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: text });
  }
  return { rows, membership, directoryStore, control, handle };
}

// Stands in for Cloudflare's script: hands out single-use tokens, and a reset yields a fresh one.
const turnstileStub = (tag: string) => `(() => { let n = 0; window.turnstile = {
  render(el, o) { el.setAttribute('data-synthetic-turnstile', '1'); window.__ts = o; setTimeout(() => o.callback('synthetic-token-${tag}-' + (++n)), 30); return 'w1'; },
  reset() { setTimeout(() => window.__ts.callback('synthetic-token-${tag}-' + (++n)), 30); },
  remove() {},
}; })();`;

async function person(browser: import('@playwright/test').Browser, fx: ReturnType<typeof relayFixture>, handle: string, viewport: { width: number; height: number }) {
  // Reduced motion: windows render at full opacity at once, so captures show the UI rather than a frame of a fade.
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce' });
  const page = await context.newPage();
  await page.clock.install();
  const watched = await watchRuntime(page);
  const counter = { relayRequests: 0 };
  page.on('request', (r) => { if (r.url().startsWith('http://127.0.0.1:54321')) counter.relayRequests++; });
  await context.route('http://127.0.0.1:54321/**', fx.handle);
  await context.route('https://challenges.cloudflare.com/**', (route) => route.fulfill({ contentType: 'application/javascript', body: turnstileStub(handle) }));
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'connection', { value: { type: 'wifi' }, configurable: true });
  });
  await page.goto('/');
  await page.getByRole('link', { name: 'Create or open your vault' }).first().click();
  await page.getByLabel('Passphrase', { exact: true }).fill(PASS);
  await page.getByLabel('Confirm passphrase').fill(PASS);
  await page.getByRole('button', { name: 'Create vault' }).click();
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
  await page.goto('/connections');
  await page.getByLabel('Handle').fill(handle);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Handle saved.')).toBeVisible();
  return { context, page, watched, counter, handle };
}
type Person = Awaited<ReturnType<typeof person>>;

/** Client-side navigation: a full page.goto would lock the vault (it lives in memory). */
async function goto(page: Page, path: string) {
  await page.evaluate((p) => { window.history.pushState({}, '', p); window.dispatchEvent(new PopStateEvent('popstate')); }, path);
}

async function openRelayOptions(page: Page) {
  const details = page.locator('details:has(summary:text("Relay options"))');
  if (!(await details.evaluate((el) => (el as HTMLDetailsElement).open))) await details.locator('summary').click();
}

/** Fast-forwards every page's timers and the relay's clock together, so signed timestamps stay valid. */
async function advance(fx: ReturnType<typeof relayFixture>, people: Person[], ms: number) {
  fx.control.skewMs += ms;
  for (const p of people) await p.page.clock.fastForward(ms);
}
/** Advances the foreground relay timers until the condition holds: this is the automatic path, no manual tap. */
async function untilAutomatic(fx: ReturnType<typeof relayFixture>, people: Person[], condition: () => Promise<boolean>, label = 'condition') {
  for (let i = 0; i < 8; i++) {
    if (process.env.EIC_PROOF_DEBUG) console.log(`${label} try ${i} counts=${JSON.stringify(fx.control.counts)}`);
    if (await condition()) return;
    await advance(fx, people, 70_000);
    await new Promise((r) => setTimeout(r, 600));
  }
  const ok = await condition();
  if (!ok) console.log(`DIAG ${label} counts=${JSON.stringify(fx.control.counts)} pages=${JSON.stringify(await Promise.all(people.map(async (p) => ({ h: p.handle, url: p.page.url(), status: await p.page.getByRole('status').allTextContents() }))))}`);
  expect(ok, `never became true: ${label}`).toBe(true);
}

/** Windows fade in through `motion`, which needs frames to run before the page is worth capturing. */
async function snap(p: Person, name: string, fullPage = false) {
  // Under the mocked clock the `motion` fade-in never leaves its initial opacity 0 (the DOM is laid out and visible
  // to assertions, but unpainted). That is a test-clock artifact, so captures only force those wrappers visible.
  // Frozen frames sit at any inline opacity (0, 0.4, ...); disabled states use classes, not inline styles.
  await p.page.addStyleTag({ content: '[style*="opacity"] { opacity: 1 !important; }' });
  await p.page.screenshot({ path: shots(name), fullPage });
}

async function openChat(p: Person) {
  // Right after a reload the click can land before hydration; retry until the route really is a chat.
  await expect(async () => {
    await goto(p.page, '/connections');
    await p.page.getByRole('link', { name: 'Chat' }).first().click({ timeout: 5000 });
    await expect(p.page).toHaveURL(/\/chat\//, { timeout: 5000 });
  }).toPass({ timeout: 45_000 });
  await expect(p.page.getByLabel('Message', { exact: true })).toBeVisible();
}
async function send(p: Person, text: string) {
  await p.page.getByLabel('Message', { exact: true }).fill(text);
  await p.page.getByRole('button', { name: 'Send', exact: true }).click();
}
const count = (p: Person, text: string) => p.page.getByText(text, { exact: true }).count();
const statusOf = (p: Person, re: RegExp) => p.page.getByRole('status', { name: re });
async function unlock(p: Person) {
  await expect(p.page.getByText('Enter your passphrase to unlock the vault.')).toBeVisible();
  await p.page.getByLabel('Passphrase', { exact: true }).fill(PASS);
  await p.page.getByRole('button', { name: 'Unlock' }).click();
  await expect(p.page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
}
/** A page that scrolls sideways at 390px is a layout defect, whatever the screenshot looks like. */
async function noHorizontalOverflow(p: Person) {
  const { scroll, inner } = await p.page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
  expect(scroll, `horizontal overflow ${scroll} > ${inner}`).toBeLessThanOrEqual(inner);
}

async function join(p: Person) {
  await goto(p.page, '/discover');
  await expect(p.page.getByRole('button', { name: 'Join', exact: true })).toBeEnabled();
  await p.page.getByRole('button', { name: 'Join', exact: true }).click();
  // Joined people do not keep a Join panel: it goes away once Discover has loaded.
  await expect(p.page.getByRole('region', { name: 'Join the encrypted relay' })).toHaveCount(0);
  await expect(p.page.getByText('Visibility not confirmed').or(p.page.getByText('You are hidden from Discover'))).toBeVisible();
  // The route used to wrap the directory's own window, so two "Discover" title bars showed.
  await expect(p.page.locator('.w95-title span.truncate', { hasText: /^Discover$/ })).toHaveCount(1);
}

async function list(p: Person, name: string, bio: string) {
  await p.page.getByRole('button', { name: 'Show me in Discover' }).click();
  await p.page.getByLabel('Public name').fill(name);
  await p.page.getByLabel('Public handle').fill(p.handle);
  await p.page.getByLabel('Short bio (optional)').fill(bio);
  await p.page.getByRole('button', { name: 'List this card' }).click();
  await expect(p.page.getByText('Your chosen card is visible in this directory.')).toBeVisible();
}

test('Discover to chat: two isolated vaults, honest states, privacy, recovery', async ({ browser }) => {
  const appOrigin = process.env.EIC_APP_ORIGIN ?? 'http://localhost:5193';
  const fx = relayFixture(appOrigin);
  const alice = await person(browser, fx, 'disc-alice', { width: 1280, height: 900 });
  const bob = await person(browser, fx, 'disc-bob', { width: 390, height: 844 });

  // Not a member yet: Discover must say so plainly rather than show an empty directory.
  await goto(alice.page, '/discover');
  await expect(alice.page.getByText(/Couldn't load Discover/)).toBeVisible();
  await snap(alice, '01-alice-not-joined-desktop');

  await join(alice); await join(bob);
  expect(fx.control.turnstileChecks).toBe(2);

  await list(alice, 'Synthetic Alice', 'Synthetic bio A');
  await snap(alice, '02-alice-listed-desktop');
  await list(bob, 'Synthetic Bob', 'Synthetic bio B');
  await snap(bob, '03-bob-listed-mobile', true);

  // Bob finds Alice and sends a request, which must not open a chat.
  await goto(bob.page, '/connections'); await goto(bob.page, '/discover');
  await bob.page.getByLabel('Search people').fill('Synthetic Alice');
  await bob.page.getByRole('button', { name: 'View Synthetic Alice' }).click();
  await bob.page.getByRole('button', { name: 'Add Synthetic Alice' }).click();
  await expect(bob.page.getByText('Request sent. This does not open a chat or allow messages.')).toBeVisible();
  await snap(bob, '04-bob-requested-mobile', true);

  await goto(alice.page, '/connections'); await goto(alice.page, '/discover');
  await expect(alice.page.getByText(/wants to connect with you/)).toBeVisible();
  await snap(alice, '05-alice-incoming-desktop');
  await alice.page.getByRole('button', { name: 'Accept', exact: true }).click();
  await expect(alice.page.getByText(/Accepted\./)).toBeVisible();

  // Chat A -> B.
  await goto(alice.page, '/connections');
  await alice.page.getByRole('link', { name: 'Chat' }).first().click();
  await alice.page.getByLabel('Message', { exact: true }).fill('synthetic hello from alice');
  await alice.page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(alice.page.getByRole('status', { name: /Message status: .*Sent to relay/ })).toBeVisible();
  await snap(alice, '06-alice-sent-desktop');

  // Bob's next Discover read imports Alice's accepted connect. Only then does a chat exist for him.
  await goto(bob.page, '/connections'); await goto(bob.page, '/discover');
  await expect(bob.page.getByText('Synthetic Alice').first()).toBeVisible();
  await goto(bob.page, '/connections');
  await bob.page.getByRole('link', { name: 'Chat' }).first().click();

  // Nobody taps anything. Bob's automatic pass must pull Alice's message AND publish his receipt, though he never replies.
  const people = [alice, bob];
  await untilAutomatic(fx, people, async () => (await bob.page.getByText('synthetic hello from alice', { exact: true }).count()) > 0, 'bob-receives');
  await snap(bob, '07-bob-received-mobile', true);
  await untilAutomatic(fx, people, async () => (await alice.page.getByRole('status', { name: /Message status: .*Delivered/ }).count()) > 0, 'alice-delivered-live');
  await snap(alice, '08-alice-delivered-no-reply-desktop');
  // Delivered must come from Bob's receipt, not from Bob typing: he sent nothing.
  expect(await bob.page.locator('li:has-text("You")').count()).toBe(0);
  await noHorizontalOverflow(bob);

  await test.step('reply, then reload and unlock: nothing is lost', async () => {
    await send(bob, 'synthetic reply from bob');
    await expect(statusOf(bob, /Message status: .*Sent to relay/)).toBeVisible();
    await untilAutomatic(fx, people, async () => (await count(alice, 'synthetic reply from bob')) > 0, 'alice-gets-reply');
    // An unsent draft is saved encrypted in the vault, so the reload must not lose it.
    await alice.page.getByLabel('Message', { exact: true }).fill('synthetic unsent draft');
    // The save is debounced by a page timer, and the page clock is mocked: move it past the debounce.
    await advance(fx, people, 1_000);
    await new Promise((r) => setTimeout(r, 500));
    await alice.page.reload();
    // A reload resumes the saved session; if it ever asks for the passphrase instead, unlock honestly.
    const asked = await alice.page.getByText('Enter your passphrase to unlock the vault.').waitFor({ timeout: 8000 }).then(() => true, () => false);
    console.log(`PROBE reload-asks-for-passphrase=${asked}`);
    await snap(alice, '09-alice-after-reload-desktop');
    if (asked) await unlock(alice);
    await expect(alice.page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
    await openChat(alice);
    expect(await count(alice, 'synthetic hello from alice')).toBe(1);
    expect(await count(alice, 'synthetic reply from bob')).toBe(1);
    await expect(statusOf(alice, /Message status: .*Delivered/)).toBeVisible();
    await expect(alice.page.getByLabel('Message', { exact: true })).toHaveValue('synthetic unsent draft');
    await snap(alice, '10-alice-after-reload-desktop');
    await alice.page.getByLabel('Message', { exact: true }).fill('');
  });

  await test.step('offline: saved locally, retries never duplicate, reconnect sends exactly once', async () => {
    fx.control.offline = true;
    await send(alice, 'synthetic offline message');
    await expect(statusOf(alice, /Message status: .*Saved on this device/)).toBeVisible();
    await openRelayOptions(alice.page);
    for (let i = 0; i < 3; i++) await alice.page.getByRole('button', { name: 'Retry relay send' }).click();
    expect(await count(alice, 'synthetic offline message')).toBe(1);
    await expect(statusOf(alice, /Message status: .*Saved on this device/)).toBeVisible();
    await snap(alice, '11-alice-offline-desktop');
    fx.control.offline = false;
    await untilAutomatic(fx, people, async () => (await count(bob, 'synthetic offline message')) > 0, 'bob-gets-offline-msg');
    expect(await count(bob, 'synthetic offline message')).toBe(1);
    await untilAutomatic(fx, people, async () => (await statusOf(alice, /Message status: .*(Sent to relay|Delivered)/).count()) >= 2, 'alice-all-accepted');
    // Nothing is queued any more, so the old "confirmation is pending" notice must be gone too.
    await expect(alice.page.getByText(/Relay confirmation is pending/)).toHaveCount(0);
  });

  await test.step('ambiguous publish: the response is lost, the message still arrives once and is never claimed early', async () => {
    fx.control.dropResponseFor = 'publish';
    await send(alice, 'synthetic ambiguous message');
    await expect.poll(() => fx.control.dropped).toBe(1);
    expect(await count(alice, 'synthetic ambiguous message')).toBe(1);
    await untilAutomatic(fx, people, async () => (await count(bob, 'synthetic ambiguous message')) > 0, 'bob-gets-ambiguous');
    expect(await count(bob, 'synthetic ambiguous message')).toBe(1);
    await untilAutomatic(fx, people, async () => (await statusOf(alice, /Message status: .*Saved on this device/).count()) === 0, 'alice-ambiguous-resolved');
  });

  // Carol is the third person. She lists a card and asks Alice; Alice declines.
  const carol = await person(browser, fx, 'disc-carol', { width: 390, height: 844 });
  people.push(carol);
  await test.step('decline: nothing is shared, and a retry does not resurrect the request', async () => {
    // Carol arrives late: catch her page clock up to the relay's, or her signed requests look stale.
    await carol.page.clock.fastForward(fx.control.skewMs);
    await join(carol); await list(carol, 'Synthetic Carol', 'Synthetic bio C');
    await goto(carol.page, '/connections'); await goto(carol.page, '/discover');
    await carol.page.getByRole('button', { name: 'View Synthetic Alice' }).click();
    await carol.page.getByRole('button', { name: 'Add Synthetic Alice' }).click();
    await expect(carol.page.getByText('Request sent. This does not open a chat or allow messages.')).toBeVisible();
    await goto(alice.page, '/connections'); await goto(alice.page, '/discover');
    // A search that does not match the requester must not hide who is asking.
    await alice.page.getByLabel('Search people').fill('Synthetic Bob');
    await expect(alice.page.getByText('Synthetic Carol').first()).toBeVisible();
    await expect(alice.page.getByText('Someone on Discover')).toHaveCount(0);
    await snap(alice, '12-alice-incoming-while-searching-desktop');
    await alice.page.getByRole('button', { name: 'Decline', exact: true }).click();
    await expect(alice.page.getByText('Declined. Nothing was shared with them.')).toBeVisible();
    const aliceId = Object.keys(fx.directoryStore.value.cards).find((id) => fx.directoryStore.value.cards[id]!.handle === 'disc-alice')!;
    const carolId = Object.keys(fx.directoryStore.value.cards).find((id) => fx.directoryStore.value.cards[id]!.handle === 'disc-carol')!;
    const request = fx.directoryStore.value.requests[`${carolId}:${aliceId}`]!;
    expect(request.status).toBe('declined');
    expect(request.requestSealed).toBeNull();
    expect(request.acceptSealed).toBeNull();
    await goto(alice.page, '/connections');
    await expect(alice.page.getByRole('link', { name: 'Chat' })).toHaveCount(1);
    await goto(carol.page, '/connections');
    await expect(carol.page.getByRole('link', { name: 'Chat' })).toHaveCount(0);
    await goto(carol.page, '/discover');
    await carol.page.getByRole('button', { name: 'View Synthetic Alice' }).click();
    await snap(carol, '13-carol-after-decline-mobile', true);
    expect(fx.directoryStore.value.requests[`${carolId}:${aliceId}`]!.status).toBe('declined');
  });

  await test.step('third-person privacy: Carol sees nothing of Alice and Bob', async () => {
    const ids = Object.fromEntries(Object.entries(fx.directoryStore.value.cards).map(([id, c]) => [c.handle, id]));
    for (const reply of fx.control.directoryReplies.filter((r) => r.principal === ids['disc-carol'])) {
      const parsed = JSON.parse(reply.body) as { requests?: { from: string; to: string }[] };
      for (const r of parsed.requests ?? []) expect([r.from, r.to]).toContain(ids['disc-carol']);
      expect(reply.body).not.toContain('synthetic');
    }
    const everything = JSON.stringify([...fx.rows.values()].map((r) => r.data));
    for (const plain of ['synthetic hello from alice', 'synthetic reply from bob', 'synthetic offline message', 'synthetic ambiguous message']) expect(everything).not.toContain(plain);
    for (const text of ['synthetic hello', 'synthetic reply', 'disc-bob request']) expect(await carol.page.getByText(text).count()).toBe(0);
  });

  await test.step('hide: the card disappears for others, chats and friends are kept', async () => {
    await goto(alice.page, '/connections'); await goto(alice.page, '/discover');
    await alice.page.getByRole('button', { name: 'Hide me from Discover' }).click();
    await expect(alice.page.getByText('Hidden from Discover. Your existing friends and chats are unchanged.')).toBeVisible();
    await snap(alice, '14-alice-hidden-desktop');
    await goto(carol.page, '/connections'); await goto(carol.page, '/discover');
    await expect(carol.page.getByRole('button', { name: 'View Synthetic Bob' })).toBeVisible();
    await expect(carol.page.getByRole('button', { name: 'View Synthetic Alice' })).toHaveCount(0);
    await openChat(alice);
    expect(await count(alice, 'synthetic hello from alice')).toBe(1);
    await send(alice, 'synthetic after hide');
    await untilAutomatic(fx, people, async () => (await count(bob, 'synthetic after hide')) > 0, 'bob-gets-after-hide');
  });

  await test.step('block: local only, their card goes, their later request ends declined, chats are kept', async () => {
    await goto(bob.page, '/connections'); await goto(bob.page, '/discover');
    await bob.page.getByRole('button', { name: 'View Synthetic Carol' }).click();
    await bob.page.getByRole('button', { name: 'Block Synthetic Carol' }).click();
    await expect(bob.page.getByText(/^Blocked on this device\. You won't see their card or requests/)).toBeVisible();
    await expect(bob.page.getByRole('button', { name: 'View Synthetic Carol' })).toHaveCount(0);
    await expect(bob.page.getByText('Blocked on this device (1)')).toBeVisible();
    // Nothing about the block reached the relay: Carol still sees Bob's card and can ask.
    await goto(carol.page, '/connections'); await goto(carol.page, '/discover');
    await carol.page.getByRole('button', { name: 'View Synthetic Bob' }).click();
    await carol.page.getByRole('button', { name: 'Add Synthetic Bob' }).click();
    await expect(carol.page.getByText('Request sent. This does not open a chat or allow messages.')).toBeVisible();
    await goto(bob.page, '/connections'); await goto(bob.page, '/discover');
    await expect(bob.page.getByText('Blocked on this device (1)')).toBeVisible();
    await expect(bob.page.getByRole('region', { name: 'Incoming requests' })).toHaveCount(0);
    const ids = Object.fromEntries(Object.entries(fx.directoryStore.value.cards).map(([id, c]) => [c.handle, id]));
    await expect.poll(() => fx.directoryStore.value.requests[`${ids['disc-carol']}:${ids['disc-bob']}`]?.status).toBe('declined');
    expect(fx.directoryStore.value.requests[`${ids['disc-carol']}:${ids['disc-bob']}`]!.requestSealed).toBeNull();
    await snap(bob, '15a-bob-blocked-carol-mobile');
    await goto(carol.page, '/connections');
    await expect(carol.page.getByRole('link', { name: 'Chat' })).toHaveCount(0);
    await openChat(bob);
    await send(bob, 'synthetic after block');
    await untilAutomatic(fx, people, async () => (await count(alice, 'synthetic after block')) > 0, 'alice-gets-after-block');
  });

  await test.step('locked vault: no relay traffic while locked, and work resumes after unlock', async () => {
    await alice.page.getByRole('button', { name: 'Lock' }).click();
    await alice.page.waitForURL('**/unlock', { timeout: 20_000 });
    const before = alice.counter.relayRequests;
    for (let i = 0; i < 3; i++) { await advance(fx, people, 70_000); await new Promise((r) => setTimeout(r, 400)); }
    expect(alice.counter.relayRequests).toBe(before);
    await snap(alice, '15-alice-locked-desktop');
    await unlock(alice);
  });

  for (const p of [alice, bob, carol]) {
    const unexpected = unexpectedConsoleErrors(p.watched.consoleErrors).filter((e) => !(fx.control.sawOffline && /127\.0\.0\.1:54321/.test(e.url + e.text)));
    expect(p.watched.pageErrors, `${p.handle} page errors`).toEqual([]);
    expect(unexpected, `${p.handle} console errors`).toEqual([]);
  }
  await carol.context.close();
  await alice.context.close(); await bob.context.close();
});

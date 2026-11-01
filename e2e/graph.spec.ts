import { expect, test, type Page } from "@playwright/test";

/**
 * Social graph: maps the vault's connections, posts, and listings; proves edge facts and
 * hidden-connection exclusion. Seeds ONLY through production UI (compose, share-file import) -
 * the "Load demo items" button exists only in dev builds, never on deploy previews.
 */

const REACT_HOOKS_SIGNATURE = /Rendered (more|fewer) hooks|error #310|error #418/i;

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
  expect([...watched.pageErrors, ...unexpected].join("\n")).not.toMatch(REACT_HOOKS_SIGNATURE);
}

let vaultCounter = 0;

async function createVault(page: Page) {
  vaultCounter += 1;
  const passphrase = `ci-graph-passphrase-${Date.now()}-${vaultCounter}`;
  await page.goto("/");
  await page.getByRole("link", { name: "Create or open your vault" }).first().click();
  await page.getByLabel("Passphrase", { exact: true }).fill(passphrase);
  await page.getByLabel("Confirm passphrase").fill(passphrase);
  await page.getByRole("button", { name: "Create vault" }).click();
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
}

// 1x1 transparent PNG: enough for the compose photo pipeline to compress and store.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

async function composePost(page: Page, kind: "photo" | "listing", title: string) {
  await page.goto("/compose");
  if (kind === "listing") await page.getByRole("radio", { name: "Marketplace listing" }).check();
  await page.getByLabel("Title").fill(title);
  await page.getByLabel("Notes").fill("seeded by the graph e2e");
  if (kind === "photo") {
    await page.getByLabel("Choose photos").setInputFiles({
      name: "tiny.png",
      mimeType: "image/png",
      buffer: TINY_PNG,
    });
    await expect(page.getByText("tiny.png")).toBeVisible();
  }
  await page.getByRole("button", { name: /Encrypt & save/ }).click();
  await page.waitForURL(kind === "photo" ? "**/feed" : "**/market");
  await expect(page.getByText(title)).toBeVisible();
}

test("graph maps composed posts and listings, selects nodes, and switches views", async ({ page }) => {
  const watched = watchRuntime(page);
  await createVault(page);

  await composePost(page, "photo", "Bridge at dawn");
  await composePost(page, "listing", "Milk crate shelves");

  await page.goto("/graph");
  await expect(page.getByText("Social graph")).toBeVisible();
  // Me + the composed photo post and listing.
  await expect(page.getByText("0 people · 1 post · 1 listing · 0 likes.")).toBeVisible();

  // Nodes render as keyboard-focusable buttons once the layout publishes positions.
  const me = page.getByRole("button", { name: "You (You)" });
  const post = page.getByRole("button", { name: /Bridge at dawn/ });
  await expect(me).toBeVisible();
  await expect(post).toBeVisible();
  await expect(page.getByRole("button", { name: /Milk crate shelves/ })).toBeVisible();

  // Keyboard selection opens the detail window with real edge facts.
  await post.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Details — Feed post")).toBeVisible();
  await expect(page.getByText(/was authored by/)).toBeVisible();

  // Preset and list toggles run without runtime errors.
  await page.getByRole("button", { name: "Free", exact: true }).click();
  await expect(me).toBeVisible();
  await page.getByRole("button", { name: "List", exact: true }).click();
  await expect(page.getByRole("link", { name: "Bridge at dawn" })).toBeVisible();

  // List rows open the same Details window the map shows - selection parity for keyboard
  // and screen-reader users who cannot use the SVG map. The pressed row marks itself.
  // (The bridge post is still selected from the map view; the listing row starts unpressed.)
  const crateDetails = page.getByRole("button", { name: "Details for Milk crate shelves" });
  await expect(crateDetails).toHaveAttribute("aria-pressed", "false");
  await crateDetails.click();
  await expect(crateDetails).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("Details — Market listing")).toBeVisible();
  await expect(page.getByText("Details — Feed post")).toHaveCount(0);
  await crateDetails.click();
  await expect(page.getByText("Details — Market listing")).toHaveCount(0);

  // Keyboard-only: Tab reaches the distinctly-named button, focus is visibly outlined,
  // and Enter/Space activate it without a mouse.
  const youDetails = page.getByRole("button", { name: "Details for You" });
  await youDetails.focus();
  await expect(youDetails).toBeFocused();
  const outline = await youDetails.evaluate((el) => {
    const style = getComputedStyle(el);
    return `${style.outlineStyle} ${style.outlineWidth}`;
  });
  expect(outline).not.toContain("none");
  await page.keyboard.press("Enter");
  await expect(youDetails).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("Details — You")).toBeVisible();
  await page.keyboard.press("Space");
  await expect(page.getByText("Details — You")).toHaveCount(0);

  // Filters narrow the list rows too.
  await page.getByLabel("Filter by name or title").fill("crate");
  await expect(page.getByRole("link", { name: "Bridge at dawn" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Milk crate shelves" })).toBeVisible();
  await page.getByLabel("Filter by name or title").fill("");

  await page.getByRole("button", { name: "Graph", exact: true }).click();
  await expect(me).toBeVisible();

  expectCleanRuntime(watched);
});

const V1_BUNDLE = JSON.stringify({
  format: "eic-share",
  version: 1,
  exportedAt: "2026-11-01T14:00:00Z",
  author: { id: "sunny01", handle: "sunny" },
  posts: [
    {
      id: "sp1",
      type: "photo",
      title: "Sunny's fire escape garden",
      category: "general",
      priceCents: null,
      description: "Tomatoes, finally.",
      createdAt: "2026-10-31T20:00:00Z",
      likes: 4,
      likedBy: [],
      media: [],
      thumb: null,
    },
    {
      id: "sl1",
      type: "listing",
      title: "Sunny's milk crate shelves",
      category: "general",
      priceCents: 2500,
      description: "Three crates, zip-tied.",
      createdAt: "2026-10-30T20:00:00Z",
      likes: 1,
      likedBy: [],
      media: [],
      thumb: null,
    },
  ],
  likes: [],
  likesComplete: true,
});

test("graph maps a connection's authorship and likes, and honors hiding", async ({ page }) => {
  const watched = watchRuntime(page);
  await createVault(page);

  // My own items via the production compose UI.
  await composePost(page, "photo", "My rooftop tomatoes");
  await composePost(page, "listing", "My zip-tied crates");

  // Handle first (imports need one), then import a friend's share file by paste.
  await page.goto("/connections");
  await page.getByLabel("Handle").fill("tester");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Handle saved.")).toBeVisible();
  await page.getByPlaceholder("Paste a shared post here, or drop a .json file anywhere in this box").fill(V1_BUNDLE);
  await page.getByRole("button", { name: "Import pasted text" }).click();
  await expect(page.getByText(/Unsigned file - trust the sender \(@sunny\)/)).toBeVisible();

  // Like one of sunny's posts for a likes edge.
  await page.goto("/feed");
  await page.getByRole("link", { name: /Sunny's fire escape garden/ }).click();
  await page.getByRole("button", { name: "♡ Like" }).click();
  await expect(page.getByRole("button", { name: "♥ Liked" })).toBeVisible();

  await page.goto("/graph");
  await expect(page.getByText("1 person · 2 posts · 2 listings · 1 like.")).toBeVisible();
  const sunny = page.getByRole("button", { name: "sunny (Connection)" });
  await expect(sunny).toBeVisible();
  await expect(page.getByRole("button", { name: /Sunny's milk crate shelves/ })).toBeVisible();

  // The connection's detail window lists real authorship edges.
  await sunny.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Details — Connection")).toBeVisible();
  await expect(page.getByText(/is your connection/)).toBeVisible();
  await expect(page.getByText(/authored/)).toHaveCount(2);

  // Hiding removes the connection, everything they authored, and every edge naming them.
  await page.goto("/connections");
  await page.getByRole("button", { name: "Hide", exact: true }).click();
  // The confirmation renders only after the hide write and refresh commit; navigating
  // before it can race the async vault write and show a stale map.
  await expect(page.getByText("@sunny hidden. Their posts are still in your vault.")).toBeVisible();
  await page.goto("/graph");
  await expect(page.getByText("0 people · 1 post · 1 listing · 0 likes.")).toBeVisible();
  await expect(page.getByText("1 hidden connection stays out of the map.")).toBeVisible();
  await expect(page.getByRole("button", { name: /Sunny's/ })).toHaveCount(0);

  expectCleanRuntime(watched);
});

test("graph shows an honest error, not an empty map, when the vault read fails", async ({ page }) => {
  const watched = watchRuntime(page);
  await createVault(page);
  await composePost(page, "photo", "Bridge at dawn");

  // Test-only fault injection: fail ONLY the item listing (records/kind index, "item" query).
  // Session resume, settings, and connections use other keys and keep working.
  await page.addInitScript(() => {
    // Test-scoped kill switch the app never reads; the test flips it to simulate recovery.
    (window as unknown as { __eicTestFaultItems: boolean }).__eicTestFaultItems = true;
    const original = IDBIndex.prototype.getAll;
    IDBIndex.prototype.getAll = function (query?: IDBValidKey | IDBKeyRange | null, count?: number) {
      if ((window as unknown as { __eicTestFaultItems: boolean }).__eicTestFaultItems
        && this.name === "kind" && query === "item") {
        return Promise.reject(new DOMException("Injected test fault: item listing failed", "AbortError"));
      }
      return original.call(this, query, count);
    };
  });

  await page.goto("/graph");
  // The loading state is its own render, then the error surfaces honestly with a retry.
  await expect(page.getByText("This vault could not be read.")).toBeVisible();
  await expect(page.getByText("Nothing to map yet.", { exact: false })).toHaveCount(0);
  const retry = page.getByRole("button", { name: "Try again" });
  await expect(retry).toBeVisible();

  // Retrying with the fault still present fails again - no fake recovery, no empty-map lie.
  await retry.click();
  await expect(page.getByText("This vault could not be read.")).toBeVisible();

  // Clear the fault and retry: the real items render on the graph, proving recovery.
  await page.evaluate(() => {
    (window as unknown as { __eicTestFaultItems: boolean }).__eicTestFaultItems = false;
  });
  await retry.click();
  await expect(page.getByText("0 people · 1 post · 0 listings · 0 likes.")).toBeVisible();
  await expect(page.getByRole("button", { name: /Bridge at dawn/ })).toBeVisible();

  // The injected rejection may be logged; hook-order and uncaught errors are still forbidden.
  expect(watched.pageErrors, "uncaught page errors").toEqual([]);
  expect([...watched.pageErrors, ...watched.consoleErrors].join("\n")).not.toMatch(REACT_HOOKS_SIGNATURE);
});

test("graph filters and search narrow the map honestly, and clear restores it", async ({ page }) => {
  const watched = watchRuntime(page);
  await createVault(page);

  await composePost(page, "photo", "My rooftop tomatoes");
  await composePost(page, "listing", "My zip-tied crates");
  await page.goto("/connections");
  await page.getByLabel("Handle").fill("tester");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Handle saved.")).toBeVisible();
  await page.getByPlaceholder("Paste a shared post here, or drop a .json file anywhere in this box").fill(V1_BUNDLE);
  await page.getByRole("button", { name: "Import pasted text" }).click();
  await expect(page.getByText(/Unsigned file - trust the sender \(@sunny\)/)).toBeVisible();

  await page.goto("/graph");
  // Baseline: me + sunny + my two items + sunny's two items.
  await expect(page.getByText("1 person · 2 posts · 2 listings · 0 likes.")).toBeVisible();

  // Kind toggle removes posts and every edge that named them; footer stays honest.
  await page.getByRole("button", { name: "Posts", exact: true }).click();
  await expect(page.getByText("1 of 1 person · 0 of 2 posts · 2 of 2 listings · 0 likes.")).toBeVisible();
  await expect(page.getByRole("button", { name: /rooftop tomatoes/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /zip-tied crates/ })).toBeVisible();

  // Selecting a node, then filtering its kind away, closes the details window.
  const crates = page.getByRole("button", { name: /My zip-tied crates/ });
  await crates.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Details — Market listing")).toBeVisible();
  await page.getByRole("button", { name: "Listings", exact: true }).click();
  await expect(page.getByText("Details — Market listing")).toHaveCount(0);
  await page.getByRole("button", { name: "Clear filter", exact: true }).click();
  await expect(page.getByText("1 person · 2 posts · 2 listings · 0 likes.")).toBeVisible();

  // Search keeps the match plus its direct neighbours only.
  await page.getByLabel("Filter by name or title").fill("garden");
  await expect(page.getByRole("button", { name: /Sunny's fire escape garden/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "sunny (Connection)" })).toBeVisible();
  await expect(page.getByRole("button", { name: /rooftop tomatoes/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /milk crate shelves/ })).toHaveCount(0);

  // A query with no matches gets its own honest state, not the empty-vault one.
  await page.getByLabel("Filter by name or title").fill("zzz-no-such-title");
  await expect(page.getByText("Nothing shows with the current filters.")).toBeVisible();
  await expect(page.getByText("Nothing to map yet.", { exact: false })).toHaveCount(0);
  await page.getByRole("button", { name: "Clear the filter", exact: true }).click();
  await expect(page.getByText("1 person · 2 posts · 2 listings · 0 likes.")).toBeVisible();

  // List view follows the same filter.
  await page.getByRole("button", { name: "Listings", exact: true }).click();
  await page.getByRole("button", { name: "List", exact: true }).click();
  await expect(page.getByRole("link", { name: "My rooftop tomatoes" })).toBeVisible();
  await expect(page.getByRole("link", { name: /zip-tied crates/ })).toHaveCount(0);

  expectCleanRuntime(watched);
});

test("connections Map link preselects the person on the graph, and hiding keeps them off it", async ({ page }) => {
  const watched = watchRuntime(page);
  await createVault(page);

  await page.goto("/connections");
  await page.getByLabel("Handle").fill("tester");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Handle saved.")).toBeVisible();
  await page.getByPlaceholder("Paste a shared post here, or drop a .json file anywhere in this box").fill(V1_BUNDLE);
  await page.getByRole("button", { name: "Import pasted text" }).click();
  await expect(page.getByText(/Unsigned file - trust the sender \(@sunny\)/)).toBeVisible();

  // The Map link lands on the graph with sunny preselected.
  const mapLink = page.getByRole("link", { name: "Map" });
  await expect(mapLink).toBeVisible();
  const href = await mapLink.getAttribute("href");
  expect(href).toMatch(/^\/graph\?focus=.+/);
  await mapLink.click();
  await expect(page).toHaveURL(/\/graph\?focus=.+/);
  await expect(page.getByText("Details — Connection")).toBeVisible();
  await expect(page.getByText(/is your connection/)).toBeVisible();

  // Hide sunny: the Map link disappears, and opening the same focus URL says so honestly.
  await page.goto("/connections");
  await page.getByRole("button", { name: "Hide", exact: true }).click();
  await expect(page.getByRole("link", { name: "Map" })).toHaveCount(0);
  await page.goto(href!);
  await expect(page.getByText("That connection is not on the map. Hidden connections stay off it.")).toBeVisible();
  await expect(page.getByText("Details — Connection")).toHaveCount(0);

  expectCleanRuntime(watched);
});

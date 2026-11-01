import { expect, test, type Page } from "@playwright/test";

/**
 * Social graph: seeded posts and listings appear as nodes on the force layout, selection
 * opens the detail window, and presets/list view work - all with a clean runtime, matching
 * the transition-smoke posture.
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

test("graph maps seeded posts and listings, selects nodes, and switches views", async ({ page }) => {
  const watched = watchRuntime(page);
  await createVault(page);

  await page.goto("/feed");
  await page.getByRole("button", { name: "Load demo items" }).click();
  await expect(page.getByText("Fog on 5th Street bridge")).toBeVisible();

  await page.goto("/graph");
  await expect(page.getByText("Social graph")).toBeVisible();
  // Me + 4 photos + 4 listings from the demo seed.
  await expect(page.getByText("0 people · 4 posts · 4 listings · 0 likes.")).toBeVisible();

  // Nodes render as keyboard-focusable buttons once the layout publishes positions.
  const me = page.getByRole("button", { name: "You (You)" });
  const post = page.getByRole("button", { name: /Fog on 5th Street bridge/ });
  await expect(me).toBeVisible();
  await expect(post).toBeVisible();
  await expect(page.getByRole("button", { name: /ThinkPad 701C/ })).toBeVisible();

  // Keyboard selection opens the detail window with real edge facts.
  await post.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Details — Feed post")).toBeVisible();
  await expect(page.getByText(/was authored by/)).toBeVisible();

  // Preset and list toggles run without runtime errors.
  await page.getByRole("button", { name: "Free", exact: true }).click();
  await expect(me).toBeVisible();
  await page.getByRole("button", { name: "List", exact: true }).click();
  await expect(page.getByRole("link", { name: "Fog on 5th Street bridge" })).toBeVisible();
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

  // My own posts via the demo seed first (the seed button only shows on an empty feed).
  await page.goto("/feed");
  await page.getByRole("button", { name: "Load demo items" }).click();
  await expect(page.getByText("Fog on 5th Street bridge")).toBeVisible();

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
  await expect(page.getByText("1 person · 5 posts · 5 listings · 1 like.")).toBeVisible();
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
  await page.goto("/graph");
  await expect(page.getByText("0 people · 4 posts · 4 listings · 0 likes.")).toBeVisible();
  await expect(page.getByText("1 hidden connection stays out of the map.")).toBeVisible();
  await expect(page.getByRole("button", { name: /Sunny's/ })).toHaveCount(0);

  expectCleanRuntime(watched);
});

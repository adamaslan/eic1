import { expect, test, type Page } from "@playwright/test";

/**
 * Same-instance transition smoke. Each test mounts a route and watches THE SAME component
 * instance move through its states (loading -> loaded, empty -> populated). Two fresh mounts
 * would not prove stable hook order - this suite exists because a hook behind an early return
 * shipped as React error #310 and crashed /connections in production.
 *
 * Console errors and uncaught page errors are collected and asserted at the end of every
 * test: React reports hook-order violations through the console, and the route error
 * boundary swallows the crash into quiet UI. A screenshot of rendered UI is not proof.
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
  // Failed resource loads (e.g. favicon) are network noise, not runtime failures.
  const unexpected = watched.consoleErrors.filter((text) => !text.startsWith("Failed to load resource"));
  expect(watched.pageErrors, "uncaught page errors").toEqual([]);
  expect(unexpected, "console errors").toEqual([]);
  expect([...watched.pageErrors, ...unexpected].join("\n")).not.toMatch(REACT_HOOKS_SIGNATURE);
}

let vaultCounter = 0;

async function createVault(page: Page) {
  vaultCounter += 1;
  const passphrase = `ci-smoke-passphrase-${Date.now()}-${vaultCounter}`;
  await page.goto("/");
  await page.getByRole("link", { name: "Create or open your vault" }).first().click();
  await page.getByLabel("Passphrase", { exact: true }).fill(passphrase);
  await page.getByLabel("Confirm passphrase").fill(passphrase);
  await page.getByRole("button", { name: "Create vault" }).click();
  // Vault creation runs the key derivation; the unlocked landing nav confirms completion.
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
}

test("landing -> create vault -> unlocked landing renders clean", async ({ page }) => {
  const watched = watchRuntime(page);
  await createVault(page);
  expectCleanRuntime(watched);
});

test("connections mounts through loading -> loaded on one component instance", async ({ page }) => {
  const watched = watchRuntime(page);
  await createVault(page);
  // Fresh navigation resumes the saved session, then mounts Connections: items load
  // async, so the one mounted instance passes loading -> loaded. The #310 crash fired
  // on exactly this transition.
  await page.goto("/connections");
  await expect(page.getByText("Your handle", { exact: true })).toBeVisible();
  await expect(page.getByText(/Connections \(\d+\)/)).toBeVisible();
  expectCleanRuntime(watched);
});

test("compose write fault shows an error and carries no saved notice", async ({ page, context }) => {
  const watched = watchRuntime(page);
  await context.addInitScript(() => {
    const original = IDBObjectStore.prototype.put;
    (window as unknown as { __eicFaultPut?: boolean }).__eicFaultPut = false;
    IDBObjectStore.prototype.put = function (value: unknown, key?: unknown) {
      if ((window as unknown as { __eicFaultPut?: boolean }).__eicFaultPut && this.name === "records") {
        return Promise.reject(new DOMException("Injected test fault: record write failed", "AbortError")) as unknown as IDBRequest;
      }
      return original.call(this, value, key as IDBValidKey);
    };
  });
  await createVault(page);
  await page.getByRole("link", { name: "+ Post" }).click();
  await page.getByRole("radio", { name: "Marketplace listing" }).check();
  const title = `CI fault listing ${Date.now()}`;
  await page.getByLabel("Title").fill(title);
  await page.getByLabel("Notes").fill("fault injection");
  await page.evaluate(() => { (window as unknown as { __eicFaultPut?: boolean }).__eicFaultPut = true; });
  await page.getByRole("button", { name: /Encrypt & save/ }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page).toHaveURL(/\/compose/);
  await page.goto("/market");
  await expect(page.getByText("Saved - encrypted in this vault.")).toHaveCount(0);
  await expect(page.getByText(title)).toHaveCount(0);
  expectCleanRuntime(watched);
});

test("compose listing -> market loads populated with the new listing", async ({ page }) => {
  const watched = watchRuntime(page);
  await createVault(page);
  await page.getByRole("link", { name: "+ Post" }).click();
  await page.getByRole("radio", { name: "Marketplace listing" }).check();
  const title = `CI smoke listing ${Date.now()}`;
  await page.getByLabel("Title").fill(title);
  await page.getByLabel("Notes").fill("listed by the transition smoke test");
  await page.getByRole("button", { name: /Encrypt & save/ }).click();
  await page.waitForURL("**/market");
  // Market mounts and passes loading -> loaded with the just-saved listing present.
  await expect(page.getByText(title)).toBeVisible();
  await expect(page.getByText("Saved - encrypted in this vault.")).toBeVisible();
  // The notice is consumed: reload, browser Back to the saved entry, and a later plain
  // navigation must not re-announce the save.
  await page.reload();
  await expect(page.getByText("Saved - encrypted in this vault.")).toHaveCount(0);
  await page.getByRole("link", { name: "Home" }).click();
  await page.goBack();
  await expect(page.getByText("Saved - encrypted in this vault.")).toHaveCount(0);
  await page.getByRole("link", { name: "Market" }).click();
  await expect(page.getByText(title)).toBeVisible();
  await expect(page.getByText("Saved - encrypted in this vault.")).toHaveCount(0);
  expectCleanRuntime(watched);
});

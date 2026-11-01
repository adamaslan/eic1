import { test, expect, type Page } from "@playwright/test";
async function setup(page: Page) {
  await page.goto("/unlock");
  await page.getByLabel("Passphrase", { exact: true }).fill("profile-studio-test-passphrase");
  await page.getByLabel("Confirm passphrase").fill("profile-studio-test-passphrase");
  await page.getByRole("button", { name: "Create vault" }).click();
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
  await page.getByRole("link", { name: "Connections", exact: true }).click();
  await page.getByLabel("Handle", { exact: true }).fill("profile-tester");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Handle saved.")).toBeVisible();
  await page.getByRole("link", { name: "Home", exact: true }).click();
  await page.getByRole("link", { name: "My profile", exact: true }).click();
  await page.getByRole("button", { name: "Customize profile" }).click();
}
test("Home opens studio; private draft persists, selection preview excludes private content, discard is reversible", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", e => errors.push(String(e)));
  await setup(page);
  await page.getByLabel("Display name (always in feed profile)").fill("Pixel Reader");
  await page.getByLabel(/^Bio \(/).fill("Private bio marker");
  await page.getByLabel("Favorite song", { exact: true }).first().fill("A private song");
  await page.getByLabel("Favorite book", { exact: true }).first().fill("Selected book");
  await page.getByLabel("Background color").selectOption("clouds");
  await page.getByRole("button", { name: "Save private draft", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Feed profile unchanged");
  await expect(page.getByText("Favorite song (private draft): A private song")).toBeVisible();
  await page.getByRole("checkbox", { name: "Favorite book", exact: true }).check();
  await page.getByRole("button", { name: "Preview selected feed profile", exact: true }).click();
  const preview = page.getByRole("region", { name: "Selected feed profile preview" });
  await expect(preview).toContainText("Favorite book: Selected book");
  await expect(preview).not.toContainText("Private bio marker");
  await expect(preview).not.toContainText("A private song");
  await page.getByRole("button", { name: "Update selected feed profile", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Nothing was uploaded");
  await page.getByLabel("Favorite book", { exact: true }).first().fill("Unsaved book");
  await page.getByRole("button", { name: "Discard unsaved changes" }).click();
  await expect(page.getByLabel("Favorite book", { exact: true }).first()).toHaveValue("Selected book");
  await page.reload();
  await page.getByRole("button", { name: "Customize profile" }).click();
  await expect(page.getByLabel("Favorite song", { exact: true }).first()).toHaveValue("A private song");
  await expect(page.getByLabel("Background color")).toHaveValue("clouds");
  expect(errors).toEqual([]);
});
test("phone controls and selected preview stay reachable above taskbar without horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await setup(page);
  await page.getByLabel("Favorite book", { exact: true }).first().fill("The Left Hand of Darkness");
  await page.getByRole("checkbox", { name: "Favorite book", exact: true }).check();
  await page.getByRole("button", { name: "Preview selected feed profile", exact: true }).click();
  const save = page.getByRole("button", { name: "Update selected feed profile", exact: true });
  await save.scrollIntoViewIfNeeded();
  const box = await save.boundingBox(); const taskbar = await page.getByRole("button", { name: "Lock", exact: true }).boundingBox();
  expect(box!.y + box!.height).toBeLessThanOrEqual(taskbar!.y);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: "/downloads/profile-studio-phone.png" });
  await previewBottom(page);
  await page.getByLabel("Background color").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "/downloads/profile-studio-editor-phone.png" });
});
test("selected content cap blocks update without truncating, while private save still works", async ({ page }) => {
  await setup(page);
  await page.getByLabel(/^Bio \(/).fill("x".repeat(500));
  await page.getByLabel("Favorite song", { exact: true }).first().fill("Another song");
  await page.getByRole("checkbox", { name: "Bio", exact: true }).check();
  await page.getByRole("checkbox", { name: "Favorite song", exact: true }).check();
  await expect(page.getByRole("alert")).toContainText("Nothing was updated");
  await expect(page.getByRole("button", { name: "Update selected feed profile", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Save private draft" }).click();
  await expect(page.getByRole("status")).toContainText("Private draft saved");
});
test("background changes persist visually, classic view hides editor without losing saved draft", async ({ page }) => {
  await setup(page);
  await page.getByLabel("Background color").selectOption("clouds");
  await page.getByRole("button", { name: "Save private draft" }).click();
  await expect(page.getByTestId("profile-canvas")).toHaveCSS("background-color", "rgb(95, 158, 160)");
  await page.getByRole("checkbox", { name: /Classic profile view/ }).check();
  await expect(page.getByRole("button", { name: "Customize profile" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Close editor" })).toHaveCount(0);
  await expect(page.getByTestId("profile-canvas")).toHaveCSS("background-color", "rgb(95, 158, 160)");
  await page.getByRole("checkbox", { name: /Classic profile view/ }).uncheck();
  await page.getByRole("button", { name: "Customize profile" }).click();
  await expect(page.getByLabel("Background color")).toHaveValue("clouds");
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.screenshot({ path: "/downloads/profile-studio-desktop.png" });
});

async function previewBottom(page: Page) {
  const preview = page.getByRole("region", { name: "Selected feed profile preview" });
  await preview.scrollIntoViewIfNeeded();
  await preview.locator("p").last().scrollIntoViewIfNeeded();
  // Preview fully inside the scroll viewport at bottom, not hidden behind the taskbar.
  const box = await preview.boundingBox();
  const taskbar = await page.getByRole("button", { name: "Lock", exact: true }).boundingBox();
  expect(box!.y + box!.height).toBeLessThanOrEqual(taskbar!.y);
  await page.screenshot({ path: "/downloads/profile-studio-preview-bottom-phone.png" });
}

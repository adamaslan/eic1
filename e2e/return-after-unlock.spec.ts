import { expect, test } from "@playwright/test";

test("a deep link survives the unlock screen", async ({ page }) => {
  // No vault yet: opening a desktop screen lands on /unlock, and creating the vault returns there.
  await page.goto("/market");
  await expect(page).toHaveURL(/\/unlock$/);
  await page.getByLabel("Passphrase", { exact: true }).fill("return-path-test-passphrase");
  await page.getByLabel("Confirm passphrase").fill("return-path-test-passphrase");
  await page.getByRole("button", { name: "Create vault", exact: true }).click();
  await expect(page).toHaveURL(/\/market$/);
});

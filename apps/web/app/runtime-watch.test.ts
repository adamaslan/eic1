import { afterEach, describe, expect, it, vi } from "vitest";
import type { Page } from "@playwright/test";
import { watchRuntime } from "../../../e2e/fixtures/runtime-watch";

function mockPage() {
  return {
    route: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
  } as unknown as Page;
}

describe("watchRuntime analytics isolation", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("blocks Segment only for deploy previews, not the production gate", async () => {
    const previewPage = mockPage();
    vi.stubEnv("EIC_TARGET_URL", "");
    vi.stubEnv("DEPLOY_PREVIEW_URL", "https://deploy-preview.example.test");
    await watchRuntime(previewPage);
    expect(previewPage.route).toHaveBeenCalledWith("https://cdn.segment.com/**", expect.any(Function));

    const productionPage = mockPage();
    vi.stubEnv("DEPLOY_PREVIEW_URL", "");
    vi.stubEnv("EIC_TARGET_URL", "https://production.example.test");
    await watchRuntime(productionPage);
    expect(productionPage.route).not.toHaveBeenCalled();
    expect(productionPage.on).toHaveBeenCalledTimes(2);

    const explicitTargetPage = mockPage();
    vi.stubEnv("DEPLOY_PREVIEW_URL", "https://deploy-preview.example.test");
    await watchRuntime(explicitTargetPage);
    expect(explicitTargetPage.route).not.toHaveBeenCalled();
  });
});

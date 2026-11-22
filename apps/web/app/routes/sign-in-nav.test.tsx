import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import React from "react";
vi.mock("~/platform/vault-service", () => ({ vaultExists: async () => true, vaultCreate: vi.fn(), vaultUnlock: vi.fn(), vaultImport: vi.fn() }));
vi.mock("~/platform/session", () => ({ useSessionStore: (select: (state: unknown) => unknown) => select({ vault: null, setVault: vi.fn() }) }));
import Unlock from "./unlock";

describe("sign-in public navigation", () => {
  it("keeps landing-style public navigation available before the vault is unlocked", () => {
    const html = renderToString(<MemoryRouter initialEntries={["/unlock"]}><Unlock /></MemoryRouter>);
    expect(html).toContain('aria-label="Sign-in navigation"');
    for (const path of ["/music-library", "/stickers", "/learn-piano"]) expect(html).toContain(`href="${path}"`);
    expect(html).toContain('aria-current="page"');
    expect(html).not.toContain('href="/connections"');
  });
});

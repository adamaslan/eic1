import { beforeEach, describe, expect, it, vi } from "vitest";
import { Children, isValidElement, type FormEvent, type ReactElement, type ReactNode } from "react";
import type { UnlockedVault } from "@veil/vault";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { defaultSettings } from "@veil/features";
import type { Social } from "./platform/use-social";

const mocks = vi.hoisted(() => ({ social: {} as Social, vault: {} as UnlockedVault | null, states: null as unknown[] | null, navigate: vi.fn() }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return {
    ...react,
    useState: (initial: unknown) => mocks.states ? [mocks.states.shift(), vi.fn()] : react.useState(initial),
    useEffect: (...args: Parameters<typeof react.useEffect>) => { if (!mocks.states) react.useEffect(...args); },
  };
});
vi.mock("~/platform/use-social", () => ({ useSocial: () => mocks.social }));
vi.mock("~/platform/session", () => ({ useSessionStore: (select: (s: unknown) => unknown) => select({ vault: mocks.vault, lock: vi.fn(), setVault: vi.fn() }) }));
vi.mock("~/platform/vault-service", () => ({ newItemId: vi.fn(), vaultExists: vi.fn(), vaultUnlock: vi.fn(), vaultCreate: vi.fn(), vaultImport: vi.fn() }));
vi.mock("react-router", async (original) => ({
  ...await original<typeof import("react-router")>(),
  Navigate: ({ to }: { to: string }) => <span data-redirect={to} />,
  useNavigate: () => mocks.navigate,
}));
import { LandingDashboard } from "./components/landing-dashboard";
import Connections from "./routes/connections";
import DesktopLayout from "./layouts/desktop";
import Unlock from "./routes/unlock";
import { vaultUnlock } from "./platform/vault-service";
const disabledButton = (html: string, label: string) => html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g)?.find((button) => button.includes(`>${label}<`))?.includes('disabled=""') ?? false;
const render = (element: React.ReactNode, path = "/") => renderToStaticMarkup(<MemoryRouter initialEntries={[path]}>{element}</MemoryRouter>);

beforeEach(() => {
  mocks.vault = {} as UnlockedVault;
  mocks.states = null;
  mocks.navigate.mockClear();
  mocks.social = { items: { status: "ready", items: [] }, settings: defaultSettings(), settingsReady: false, notes: [], connections: [], update: vi.fn(), refresh: vi.fn() };
});

describe("settings UI readiness", () => {
  it("disables dashboard swaps and picks until settings load", () => {
    const pending = render(<LandingDashboard />);
    expect(pending.match(/<select disabled=""/g)).toHaveLength(3);
    expect(disabledButton(pending, "Your picks…")).toBe(true);
    mocks.social.settingsReady = true;
    const ready = render(<LandingDashboard />);
    expect(ready).not.toContain('<select disabled=""');
    expect(disabledButton(ready, "Your picks…")).toBe(false);
  });

  it("disables handle saving until settings load", () => {
    expect(disabledButton(render(<Connections />), "Save")).toBe(true);
    mocks.social.settingsReady = true;
    expect(disabledButton(render(<Connections />), "Save")).toBe(false);
  });

  it("labels the export button with the capped post count", () => {
    mocks.social.items = { status: "ready", items: Array.from({ length: 101 }, () => ({ authorId: null, visibility: "shareable" } as never)) };
    expect(render(<Connections />)).toContain("Export share file (100 posts)");
  });
});

function findForm(node: ReactNode): ReactElement<{ onSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void> }> | undefined {
  for (const child of Children.toArray(node)) {
    if (!isValidElement<{ children?: ReactNode }>(child)) continue;
    if (child.type === "form") return child as ReturnType<typeof findForm>;
    const found = findForm(child.props.children);
    if (found) return found;
  }
}

describe("dashboard navigation", () => {
  it("links Home to / and marks it active only at the dashboard", () => {
    expect(render(<DesktopLayout />)).toMatch(/<a[^>]*aria-current="page"[^>]*href="\/"[^>]*>Home<\/a>/);
    expect(render(<DesktopLayout />, "/feed")).not.toMatch(/<a[^>]*aria-current="page"[^>]*href="\/"[^>]*>Home<\/a>/);
  });

  it("navigates to the dashboard after successfully unlocking", async () => {
    mocks.vault = null;
    mocks.states = [true, "pass phrase", "", null, false, null];
    vi.mocked(vaultUnlock).mockResolvedValue({} as UnlockedVault);
    const form = findForm(Unlock());
    expect(form).toBeDefined();
    await form!.props.onSubmit({ preventDefault: vi.fn() } as unknown as FormEvent<HTMLFormElement>);
    expect(mocks.navigate).toHaveBeenCalledWith("/", { replace: true });
  });

  it("redirects an unlocked session to the dashboard", () => {
    expect(render(<Unlock />)).toContain('data-redirect="/"');
  });
});

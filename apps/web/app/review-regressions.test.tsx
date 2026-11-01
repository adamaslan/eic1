import { beforeEach, describe, expect, it, vi } from "vitest";
import { Children, isValidElement, type FormEvent, type ReactElement, type ReactNode } from "react";
import type { UnlockedVault } from "@veil/vault";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { addNote, defaultSettings } from "@veil/features";
import type { Social } from "./platform/use-social";

const mocks = vi.hoisted(() => ({ social: {} as Social, vault: {} as UnlockedVault | null, states: null as unknown[] | null, setters: [] as ReturnType<typeof vi.fn>[], navigate: vi.fn() }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return {
    ...react,
    useState: (initial: unknown) => {
      if (!mocks.states) return react.useState(initial);
      const setter = vi.fn();
      mocks.setters.push(setter);
      return [mocks.states.shift(), setter];
    },
    useEffect: (...args: Parameters<typeof react.useEffect>) => { if (!mocks.states) react.useEffect(...args); },
  };
});
vi.mock("~/platform/use-social", () => ({ useSocial: () => mocks.social }));
vi.mock("@veil/features", async (original) => ({ ...await original<typeof import("@veil/features")>(), addNote: vi.fn() }));
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
  mocks.setters = [];
  mocks.navigate.mockClear();
  mocks.social = { items: { status: "ready", items: [] }, settings: defaultSettings(), settingsReady: false, notes: [], connections: [], update: vi.fn(), refresh: vi.fn() };
});

// Inspect the dashboard's small component tree to exercise async event handlers in node.
type TestElement = ReactElement<{ children?: ReactNode; [key: string]: unknown }>;
function findNode(node: ReactNode, match: (element: TestElement) => boolean): TestElement | undefined {
  for (const child of Children.toArray(node)) {
    if (!isValidElement<TestElement["props"]>(child)) continue;
    if (match(child)) return child;
    const found = findNode(child.props.children, match);
    if (found) return found;
  }
}

describe("dashboard write failures", () => {
  beforeEach(() => {
    mocks.social.settingsReady = true;
    vi.mocked(mocks.social.update).mockRejectedValue(new Error("save failed"));
    vi.mocked(addNote).mockRejectedValue(new Error("write failed"));
  });

  it("catches a failed box swap and displays an alert", async () => {
    mocks.states = [null];
    const select = findNode(LandingDashboard(), (node) => node.type === "select")!;
    await expect((select.props.onChange as (event: unknown) => Promise<void>)({ target: { value: "messages" } })).resolves.toBeUndefined();
    const message = mocks.setters[0]!.mock.calls.at(-1)![0];
    mocks.states = [message];
    expect(findNode(LandingDashboard(), (node) => node.props.role === "alert")?.props.children).toBe(message);
  });

  it("keeps the picks editor open and shows an alert after a failed save", async () => {
    // Open the picks component with its editing state enabled.
    mocks.states = [null];
    const box = findNode(LandingDashboard(), (node) => typeof node.type === "function" && node.type.name === "Box" && node.props.slot === "picks")!;
    const picks = (box.type as (props: unknown) => TestElement)(box.props);
    mocks.states = [true];
    const editor = findNode((picks.type as (props: unknown) => ReactNode)(picks.props), (node) => typeof node.type === "function" && node.type.name === "PicksEditor")!;
    const editingSetter = mocks.setters.at(-1)!;
    mocks.states = [[], "bike", false, null];
    const form = (editor.type as (props: unknown) => ReactNode)(editor.props);
    await expect(findForm(form)!.props.onSubmit({ preventDefault: vi.fn() } as unknown as FormEvent<HTMLFormElement>)).resolves.toBeUndefined();
    expect(editingSetter).not.toHaveBeenCalled();
    const message = mocks.setters.at(-1)!.mock.calls.at(-1)![0];
    mocks.states = [[], "bike", false, message];
    const failed = (editor.type as (props: unknown) => ReactNode)(editor.props);
    expect(findForm(failed)).toBeDefined();
    expect(findNode(failed, (node) => node.props.role === "alert")?.props.children).toBe(message);
  });

  it("catches a failed note write, keeps the text, and displays an alert", async () => {
    mocks.states = [null];
    const box = findNode(LandingDashboard(), (node) => typeof node.type === "function" && node.type.name === "Box" && node.props.slot === "messages")!;
    const messages = (box.type as (props: unknown) => TestElement)(box.props);
    mocks.states = ["keep this note", false, null];
    const form = (messages.type as (props: unknown) => ReactNode)(messages.props);
    const textSetter = mocks.setters.at(-3)!;
    await expect(findForm(form)!.props.onSubmit({ preventDefault: vi.fn() } as unknown as FormEvent<HTMLFormElement>)).resolves.toBeUndefined();
    expect(textSetter).not.toHaveBeenCalled();
    expect(mocks.social.refresh).not.toHaveBeenCalled();
    const message = mocks.setters.at(-1)!.mock.calls.at(-1)![0];
    mocks.states = ["keep this note", false, message];
    expect(findNode((messages.type as (props: unknown) => ReactNode)(messages.props), (node) => node.props.role === "alert")?.props.children).toBe(message);
  });
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
    vi.mocked(vaultUnlock).mockResolvedValue({ vault: {} as UnlockedVault, expiresAt: Date.now() + 28_800_000 });
    const form = findForm(Unlock());
    expect(form).toBeDefined();
    await form!.props.onSubmit({ preventDefault: vi.fn() } as unknown as FormEvent<HTMLFormElement>);
    expect(mocks.navigate).toHaveBeenCalledWith("/", { replace: true });
  });

  it("redirects an unlocked session to the dashboard", () => {
    expect(render(<Unlock />)).toContain('data-redirect="/"');
  });
});

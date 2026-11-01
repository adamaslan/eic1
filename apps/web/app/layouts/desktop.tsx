import { Link, Navigate, Outlet, useLocation } from "react-router";
import { useClock } from "@veil/features";
import { Bevel } from "~/ui95/Bevel";
import { Taskbar } from "~/ui95/Taskbar";
import { PlayerAudio } from "~/components/player-audio";
import { usePlayerStore } from "~/platform/player-store";
import { useEffect } from "react";
import { useSessionStore } from "~/platform/session";

const TABS = [
  { id: "home", label: "Home" },
  { id: "feed", label: "Feed" },
  { id: "market", label: "Market" },
  { id: "compose", label: "+ Post" },
  { id: "draw", label: "Paint" },
  { id: "tools", label: "Tools" },
  { id: "connections", label: "Connections" },
  { id: "graph", label: "Graph" },
  { id: "vault", label: "Vault" },
];

// Every desktop screen needs an unlocked vault. Locking anywhere sends the user to /unlock.
export default function DesktopLayout() {
  const vault = useSessionStore((state) => state.vault);
  const lock = useSessionStore((state) => state.lock);
  const resuming = useSessionStore((state) => state.resuming);
  const { pathname } = useLocation();
  const now = useClock();

  // Locking or switching vaults must stop the music and drop private playlist state,
  // not just leave the player running against a locked vault.
  useEffect(() => {
    if (!vault) usePlayerStore.getState().resetAll();
  }, [vault]);

  if (!vault && resuming) {
    return <p className="p-2 text-[12px] text-white">Opening your desktop…</p>;
  }
  if (!vault) {
    return <Navigate to="/unlock" replace />;
  }

  const active = pathname === "/" ? "home" : pathname.startsWith("/market") ? "market" : pathname.startsWith("/compose")
      ? "compose"
      : pathname.startsWith("/draw")
        ? "draw"
      : pathname.startsWith("/tools")
        ? "tools"
      : pathname.startsWith("/connections")
        ? "connections"
        : pathname.startsWith("/graph")
          ? "graph"
        : pathname.startsWith("/vault")
          ? "vault"
          : "feed";
  const clock = now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  return (
    // The shell is exactly the viewport height and never scrolls itself: the main region
// is the scroll container, so the taskbar below it always reserves its space and page
// content can never slide underneath it (the old fixed taskbar overlapped the bottom
// of slightly-taller-than-viewport pages with no way to scroll clear).
    <div className="flex h-screen h-dvh flex-col bg-[#008080]">
      <header className="p-2 pb-0">
        <nav aria-label="Main navigation" className="flex flex-wrap gap-1">
          {TABS.map((tab) => (
            <Bevel key={tab.id} variant={tab.id === active ? "in" : "out"}>
              <Link
                to={tab.id === "home" ? "/" : `/${tab.id}`}
                aria-current={tab.id === active ? "page" : undefined}
                className={`block min-h-[44px] bg-[#c0c0c0] px-3 py-1 text-[12px] text-[#0a0a0a] sm:min-h-0 ${tab.id === active ? "translate-x-px translate-y-px" : ""}`}
              >
                {tab.label}
              </Link>
            </Bevel>
          ))}
        </nav>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto p-2">
        <Outlet />
      </main>
      <PlayerAudio />
      <Taskbar startLabel="Lock" onStart={lock} clock={clock}>
        <span className="self-center truncate text-[12px] text-[#0a0a0a]">Everybody is Cool</span>
      </Taskbar>
    </div>
  );
}

import { Avatar } from "~/components/avatar";
import { Link, Navigate, Outlet, useLocation } from "react-router";
import { useClock } from "@veil/features";
import { useFeatureEnabled } from "~/platform/use-gate";
import { Bevel } from "~/ui95/Bevel";
import { Taskbar } from "~/ui95/Taskbar";
import { PlayerAudio } from "~/components/player-audio";
import { usePlayerStore } from "~/platform/player-store";
import { useEffect } from "react";
import { motion } from "motion/react";
import { useSessionStore } from "~/platform/session";
import { useThemeStore } from "~/platform/theme-store";
import type { StartItem } from "~/ui95/StartMenu";

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

const START_ITEMS: StartItem[] = [
  { to: "/", label: "Home", icon: "🏠" },
  { to: "/feed", label: "Feed", icon: "📰" },
  { to: "/compose", label: "New post", icon: "✏️" },
  { to: "/draw", label: "Paint", icon: "🖌️" },
  { to: "/tools/journal", label: "Journal", icon: "📓" },
  { to: "/tools/music", label: "Music", icon: "🎵" },
  { to: "/tools/calendar", label: "Calendar", icon: "📅" },
  { to: "/connections", label: "Friends", icon: "💌" },
  { to: "/profile", label: "My profile", icon: "😎" },
  { to: "/stickers", label: "Avatar stickers", icon: "⭐" },
];

// Every desktop screen needs an unlocked vault. Locking anywhere sends the user to /unlock.
export default function DesktopLayout() {
  const vault = useSessionStore((state) => state.vault);
  const lock = useSessionStore((state) => state.lock);
  const resuming = useSessionStore((state) => state.resuming);
  const { pathname } = useLocation();
  const now = useClock();
  const graphEnabled = useFeatureEnabled(vault, "graph");
  const tabs = TABS.filter((tab) => (tab.id === "graph" ? graphEnabled : true));
  const party = useThemeStore((state) => state.theme.motion === "party");

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
    <div className="w95-desktop flex h-screen h-dvh flex-col">
      <header className="p-2 pb-0">
        <div className="mb-1 flex items-center gap-2"><Avatar /><Link to="/profile" className="text-[12px] text-white underline [text-shadow:1px_1px_0_#000]">My profile</Link><Link to="/stickers" className="text-[12px] text-white underline [text-shadow:1px_1px_0_#000]">Avatar stickers</Link></div>
        {/* One row that scrolls sideways on phones instead of stacking into a wall of tabs. */}
        <nav aria-label="Main navigation" className="-mx-2 flex snap-x gap-1 overflow-x-auto px-2 pb-1 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={`relative shrink-0 snap-start transition-transform duration-150 active:scale-95 ${party ? "hover:-translate-y-0.5" : ""}`}
            >
              <Bevel variant={tab.id === active ? "in" : "out"}>
                <Link
                  to={tab.id === "home" ? "/" : `/${tab.id}`}
                  aria-current={tab.id === active ? "page" : undefined}
                  className={`block min-h-[44px] bg-[var(--w95-face)] px-3 py-1 text-[12px] whitespace-nowrap text-[var(--w95-ink)] sm:min-h-0 ${tab.id === active ? "translate-x-px translate-y-px font-bold" : ""}`}
                >
                  {tab.label}
                </Link>
              </Bevel>
              {tab.id === active && (
                <motion.span
                  layoutId="w95-active-tab"
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-x-2 bottom-1 h-[2px] bg-[var(--w95-accent)]"
                  transition={{ type: "spring", stiffness: 500, damping: 35 }}
                />
              )}
            </div>
          ))}
        </nav>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto p-2">
        {/* Enter-only page transition: no AnimatePresence, so the old route never lingers.
            Keyed by section, not full path, so /chat/a -> /chat/b keeps its instance. */}
        <motion.div
          key={pathname.split("/")[1] ?? ""}
          className="w95-zoom"
          initial={party ? { opacity: 0, y: 14, scale: 0.98 } : { opacity: 0.4, y: 4 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={party ? { type: "spring", stiffness: 300, damping: 22 } : { duration: 0.15, ease: "easeOut" }}
        >
          <Outlet />
        </motion.div>
      </main>
      <PlayerAudio />
      <Taskbar startLabel="Lock" onStart={lock} clock={clock} startItems={START_ITEMS}>
        <span className="self-center truncate text-[12px] text-[var(--w95-ink)]">Everybody is Cool</span>
      </Taskbar>
    </div>
  );
}

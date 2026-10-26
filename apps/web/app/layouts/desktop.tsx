import { Navigate, Outlet, useLocation, useNavigate } from "react-router";
import { useClock } from "@veil/features";
import { Tabs95 } from "~/ui95/Tabs95";
import { Taskbar } from "~/ui95/Taskbar";
import { useSessionStore } from "~/platform/session";

const TABS = [
  { id: "feed", label: "Feed" },
  { id: "market", label: "Market" },
];

// Every desktop screen needs an unlocked vault. Locking anywhere sends the user to /unlock.
export default function DesktopLayout() {
  const vault = useSessionStore((state) => state.vault);
  const lock = useSessionStore((state) => state.lock);
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const now = useClock();

  if (!vault) {
    return <Navigate to="/unlock" replace />;
  }

  const active = pathname.startsWith("/market") ? "market" : "feed";
  const clock = now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  return (
    <div className="flex min-h-screen flex-col bg-[#008080]">
      <header className="p-2 pb-0">
        <Tabs95
          tabs={TABS}
          activeId={active}
          onChange={(id) => navigate(id === "feed" ? "/" : "/market")}
        />
      </header>
      <main className="flex-1 p-2 pb-16">
        <Outlet />
      </main>
      <Taskbar startLabel="Lock" onStart={lock} clock={clock}>
        <span className="self-center truncate text-[12px] text-[#0a0a0a]">Veil 95</span>
      </Taskbar>
    </div>
  );
}

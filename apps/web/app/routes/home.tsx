import { useState } from "react";
import type { Route } from "./+types/home";
import { Window } from "~/ui95/Window";
import { Button95 } from "~/ui95/Button95";
import { Taskbar } from "~/ui95/Taskbar";
import { Link } from "react-router";

export function meta(_args: Route.MetaArgs) {
  return [{ title: "Veil 95" }];
}

const TABS = [
  { id: "feed", label: "Feed" },
  { id: "market", label: "Market" },
  { id: "vault", label: "Vault" },
];

export default function Home() {
  const [active, setActive] = useState("feed");
  const [pressed, setPressed] = useState(false);

  return (
    <main className="min-h-screen bg-[#008080] p-3 pb-16">
      <Window title="Veil 95 — primitives">
        <div className="flex flex-col gap-3">
          <div role="group" aria-label="Active view" className="flex flex-wrap gap-1">
            {TABS.map((tab) => (
              <Button95 key={tab.id} pressed={tab.id === active} onClick={() => setActive(tab.id)}>
                {tab.label}
              </Button95>
            ))}
          </div>
          <p role="status" className="text-[12px]">Active view: {active}</p>
          <Link to="/unlock" className="text-[12px] text-[#0000cc] underline">
            Open vault
          </Link>
          <Button95 pressed={pressed} onClick={() => setPressed((p) => !p)}>
            {pressed ? "Pressed" : "Press me"}
          </Button95>
        </div>
      </Window>
      <Taskbar clock="12:00" onStart={() => undefined}>
        <span className="truncate self-center text-[12px]">Veil 95</span>
      </Taskbar>
    </main>
  );
}

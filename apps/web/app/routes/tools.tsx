import { useEffect, useState } from "react";
import { Link } from "react-router";
import { loadSettings, setFeatureEnabled } from "@veil/features";
import type { Route } from "./+types/tools";
import { useSessionStore } from "~/platform/session";
import { Window } from "~/ui95/Window";

export function meta(_args: Route.MetaArgs) {
  return [{ title: "Tools — Everybody is Cool" }];
}

const TOOLS = [
  { to: "/tools/journal", name: "Journal", blurb: "Write private entries. Each one is encrypted in your vault." },
  {
    to: "/tools/music",
    name: "Music",
    blurb: "Play MP3s from a folder on your device. Goes to the next song and loops. Nothing is uploaded.",
  },
  {
    to: "/tools/calendar",
    name: "Calendar",
    blurb: "A month grid for your plans. Events are encrypted in your vault and never shared.",
  },
  {
    to: "/tools/chores",
    name: "Chore chart",
    blurb: "A weekly chart of chores with check-offs per day. Encrypted in your vault.",
  },
  {
    to: "/draw",
    name: "Paint",
    blurb: "Draw with brushes, an eraser, and text on a chunky canvas, with undo. Saves as an encrypted photo post.",
  },
];

const GATES = [
  { id: "graph", name: "Connections map", blurb: "Show the map of your people, posts, and listings." },
  { id: "journal-editing", name: "Journal editing", blurb: "Allow editing saved entries. Entries stay saved either way." },
];

export default function Tools() {
  const vault = useSessionStore((state) => state.vault);
  const [features, setFeatures] = useState<Record<string, boolean> | null>(null);

  useEffect(() => {
    if (!vault) return;
    let cancelled = false;
    loadSettings(vault).then((settings) => {
      if (!cancelled) setFeatures(settings.features);
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [vault]);

  async function toggle(feature: string, enabled: boolean) {
    if (!vault) return;
    const saved = await setFeatureEnabled(vault, feature, enabled);
    setFeatures(saved.features);
    // Gates apply across the shell (nav, routes), which reads settings on load.
    window.location.reload();
  }

  return (
    <Window title="Tools">
      <fieldset className="mb-2 flex flex-col gap-1 bg-white px-1.5 py-1 text-[12px]">
        <legend className="font-bold">Features</legend>
        {GATES.map((gate) => (
          <label key={gate.id} className="flex items-start gap-1">
            <input
              type="checkbox"
              disabled={features === null}
              checked={features !== null && features[gate.id] !== false}
              onChange={(e) => void toggle(gate.id, e.target.checked)}
            />
            <span>
              <span className="font-bold">{gate.name}</span>
              <span className="text-[var(--w95-muted)]"> — {gate.blurb}</span>
            </span>
          </label>
        ))}
        <p className="text-[11px] text-[var(--w95-muted)]">Turning a feature off only hides it. Your saved entries, posts, and connections stay in the vault.</p>
      </fieldset>
      <ul className="flex flex-col gap-1 text-[12px]">
        {TOOLS.map((tool) => (
          <li key={tool.to} className="bg-white px-1.5 py-1">
            <Link to={tool.to} className="font-bold text-[var(--w95-link)] underline">
              {tool.name}
            </Link>
            <span className="text-[var(--w95-muted)]"> — {tool.blurb}</span>
          </li>
        ))}
      </ul>
    </Window>
  );
}

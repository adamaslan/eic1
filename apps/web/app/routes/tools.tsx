import { Link } from "react-router";
import type { Route } from "./+types/tools";
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
    to: "/draw",
    name: "Paint",
    blurb: "Draw with brushes, an eraser, and text on a chunky canvas, with undo. Saves as an encrypted photo post.",
  },
];

export default function Tools() {
  return (
    <Window title="Tools">
      <ul className="flex flex-col gap-1 text-[12px]">
        {TOOLS.map((tool) => (
          <li key={tool.to} className="bg-white px-1.5 py-1">
            <Link to={tool.to} className="font-bold text-[#0000cc] underline">
              {tool.name}
            </Link>
            <span className="text-[#404040]"> — {tool.blurb}</span>
          </li>
        ))}
      </ul>
    </Window>
  );
}

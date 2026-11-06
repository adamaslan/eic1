import { Link } from "react-router";
import { formatDuration } from "@veil/features";
import { usePlayerStore } from "~/platform/player-store";

// Local now-playing display. It only reflects what this device's player is doing -
// nothing here is posted, published, or shared with connections.
export function NowPlayingStrip() {
  const current = usePlayerStore((s) => s.tracks[s.index]);
  const count = usePlayerStore((s) => s.tracks.length);
  const index = usePlayerStore((s) => s.index);
  const playing = usePlayerStore((s) => s.playing);
  const currentTime = usePlayerStore((s) => s.currentTime);
  const duration = usePlayerStore((s) => s.duration);
  const setPlaying = usePlayerStore((s) => s.setPlaying);
  const move = usePlayerStore((s) => s.move);

  if (!current) return null;
  const pct = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;

  return (
    <div
      aria-label="Now playing"
      className="flex items-center gap-2 border-2 border-b-[#0a0a0a] border-r-[#0a0a0a] border-l-[#dfdfdf] border-t-[#dfdfdf] bg-[#c0c0c0] px-2 py-1 text-[12px]"
    >
      <button
        type="button"
        aria-label={playing ? "Pause" : "Play"}
        onClick={() => setPlaying(!playing)}
        className="min-h-[24px] min-w-[28px] bg-[#c0c0c0] shadow-[inset_-1px_-1px_#0a0a0a,inset_1px_1px_#fff] active:shadow-[inset_1px_1px_#0a0a0a,inset_-1px_-1px_#fff]"
      >
        {playing ? "⏸" : "▶"}
      </button>
      <button type="button" aria-label="Next track" onClick={() => move(1, false)} className="min-h-[24px] min-w-[28px] bg-[#c0c0c0] shadow-[inset_-1px_-1px_#0a0a0a,inset_1px_1px_#fff] active:shadow-[inset_1px_1px_#0a0a0a,inset_-1px_-1px_#fff]">
        ⏭
      </button>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[#0a0a0a]">
          ♪ {index + 1}/{count} {current.title}
        </div>
        <div className="mt-0.5 h-2 w-full bg-white shadow-[inset_1px_1px_#0a0a0a]" aria-hidden="true">
          <div className="h-full bg-[#000080]" style={{ width: `${pct}%` }} />
        </div>
      </div>
      <span className="shrink-0 font-mono text-[11px] text-[#404040]">
        {formatDuration(currentTime)}/{formatDuration(duration || current.duration)}
      </span>
      <Link to="/tools/music" className="shrink-0 font-bold text-[#0000cc] underline">
        Player
      </Link>
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { Window } from "~/ui95/Window";
import { Button95 } from "~/ui95/Button95";
import tracks from "~/data/music-library.json";

// Public catalogue only. No vault records, local files, or private player state.
export default function MusicLibrary() {
  const [index, setIndex] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [rate, setRate] = useState(1);
  const [loop, setLoop] = useState(false);
  const [note, setNote] = useState("");
  const audioRef = useRef<HTMLAudioElement>(null);
  const track = index === null ? null : tracks[index];

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !track) return;
    audio.playbackRate = rate;
    void audio.play().catch(() => setNote(audio.error ? "This song could not be loaded or played. Try again or choose another song." : "Tap Play to start this song."));
    // The selected file alone changes the source. Speed changes must not restart it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = rate;
  }, [rate]);

  function select(i: number) {
    setNote("");
    if (i === index) void audioRef.current?.play().catch(() => setNote("Tap Play to start this song."));
    else setIndex(i);
  }

  function next() {
    if (index === null) return;
    if (index + 1 < tracks.length) select(index + 1);
    else if (loop) select(0);
  }

  const visible = tracks.map((t, i) => ({ ...t, i })).filter((t) => t.file.toLowerCase().includes(query.toLowerCase()));
  return (
    <main className="min-h-screen bg-[#008080] p-3 pb-8 text-[12px]">
      <div className="mx-auto flex max-w-2xl flex-col gap-3">
        <Link to="/" className="inline-flex min-h-[44px] items-center text-white underline">Home</Link>
        <Window title="music-library">
          <div className="flex min-w-0 flex-col gap-3">
            <h1 className="text-[20px] font-bold">music-library</h1>
            <p>42b - {tracks.length} songs. Listen without signing in.</p>
            <p>Original MP3 files, unchanged. Pick a song to begin. Only the selected song loads; audio format support depends on your browser.</p>
            <h2 className="break-words font-bold [overflow-wrap:anywhere]" data-testid="library-current">{track ? track.file.replace(/\.mp3$/i, "") : "Choose a song"}</h2>
            <audio ref={audioRef} src={track ? `/42b/${encodeURIComponent(track.file).replace(/%2C/gi, ",")}` : undefined} preload="none" controls className="w-full min-w-0" data-testid="library-audio" onEnded={next} onPlaying={() => setNote("")} onError={() => setNote("This song could not be loaded or played. Try again or choose another song.")} />
            <div className="flex flex-wrap items-center gap-3">
              <Button95 disabled={index === null || index === 0} onClick={() => index !== null && select(index - 1)}>Previous</Button95>
              <Button95 disabled={index === null || (index === tracks.length - 1 && !loop)} onClick={next}>Next</Button95>
              <label>Speed <select aria-label="Playback speed" className="min-h-[44px]" value={rate} onChange={(e) => setRate(Number(e.target.value))}>{[0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map((n) => <option key={n} value={n}>{n}x</option>)}</select></label>
              <label className="flex min-h-[44px] items-center gap-1"><input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} /> Loop library</label>
            </div>
            <p role="status" className="break-words text-[#800000]">{note}</p>
            <label className="flex flex-col gap-1">Find a song<input type="search" value={query} onChange={(e) => setQuery(e.target.value)} className="min-h-[44px] w-full min-w-0 bg-white p-2 [border:2px_inset_#fff]" /></label>
            <p>{visible.length} of {tracks.length} songs</p>
            <ol aria-label="42b songs" className="max-h-[50vh] overflow-y-auto bg-white p-1">
              {visible.map((t) => <li key={t.file}><button type="button" aria-current={t.i === index ? "true" : undefined} className={`min-h-[44px] w-full px-2 py-2 text-left [overflow-wrap:anywhere] ${t.i === index ? "bg-[#000080] text-white" : "hover:bg-[#dcdcdc]"}`} onClick={() => select(t.i)}>{t.i + 1}. {t.file.replace(/\.mp3$/i, "")}</button></li>)}
            </ol>
            {!visible.length && <p>No songs match that search.</p>}
          </div>
        </Window>
      </div>
    </main>
  );
}

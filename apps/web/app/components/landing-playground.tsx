import { useState } from "react";
import { Link } from "react-router";
import { PROFILE_AVATARS } from "@veil/features";
import { themePresets, type ThemePresetId } from "@veil/tokens";
import { useThemeStore } from "~/platform/theme-store";
import musicCatalog from "~/data/music-library.json";
import { Window } from "~/ui95/Window";

const LOOKS: ThemePresetId[] = ["vaporwave", "bubblegum", "midnight", "lime", "hotdog", "classic"];

// These controls use the real device theme store, not a screenshot or invented feature.
// No automatic preset changes: existing preferences and reduced-motion choices survive.
export function LandingPlayground({ unlocked = false }: { unlocked?: boolean }) {
  const theme = useThemeStore(s => s.theme);
  const choose = useThemeStore(s => s.choosePreset);
  const set = useThemeStore(s => s.set);
  const display = useThemeStore(s => s.setDisplayOpen);
  return (
    <section aria-label="Make yourself a little world" className="eic-playground">
      <div className="eic-playground-copy">
        <p className="eic-eyebrow">YOUR DEVICE. YOUR LITTLE WORLD.</p>
        <h1>Everybody<br />is <span>cool.</span></h1>
        <p className="eic-hero-description">A mixtape, a doodle, a tiny desktop that feels like you. Make a mess. Make it yours.</p>
        <div className="eic-hero-actions">
          <Link to={unlocked ? "/draw" : "/unlock"} aria-label={unlocked ? "Make something" : "Create or open your vault"} className="eic-big-button">{unlocked ? "Make something ↗" : "Make your own world ↗"}</Link>
          <Link to="/music-library" className="eic-music-link">♫ Press play · {musicCatalog.length} songs</Link>
        </div>
        <p className="eic-local-note">No account. Private vault on this device. Sharing is manual.</p>
        <div className="eic-sticker-strip" aria-label="Original hand-drawn avatars">
          {PROFILE_AVATARS.slice(0, 6).map(a => <img key={a.id} src={`data:image/png;base64,${a.data}`} alt={a.label} width={48} height={48} />)}
          <span>weird is welcome.</span>
        </div>
      </div>
      <div className="eic-demo-desk">
        <div className="eic-demo-tag">NOT A SCREENSHOT. TRY THE BUTTONS ↓</div>
        <Window title="✦ Your desktop, remixed" className="eic-remix-window">
          <div className="eic-remix-intro"><span aria-hidden="true">✿</span><div><strong>Pick a personality.</strong><p>The whole page changes. For real.</p></div></div>
          <div aria-label="Try a desktop look" className="eic-look-grid">
            {LOOKS.map(id => <button key={id} type="button" aria-pressed={theme.preset === id} onClick={() => choose(id)} className="eic-look-button">
              <span className="eic-look-swatch" style={{ background: `linear-gradient(135deg, ${themePresets[id].colors.titleA}, ${themePresets[id].colors.titleB})` }}><span style={{ background: themePresets[id].colors.face, color: themePresets[id].colors.ink }}>Aa</span></span>
              <span>{id === "classic" ? "Classic" : themePresets[id].label}</span>
            </button>)}
          </div>
          <div className="eic-remix-switches">
            <button type="button" aria-label="Party mode" aria-pressed={theme.motion === "party"} onClick={() => set({ motion: theme.motion === "party" ? "off" : "party" })}>Party mode</button>
            <span role="status" aria-label="Motion setting" className="self-center text-[11px]">{theme.motion === "party" ? "Party on" : theme.motion === "off" ? "Still" : "Calm"}</span>
            <button type="button" aria-pressed={theme.soft} onClick={() => set({ soft: !theme.soft })}>◕ Soft corners</button>
            <button type="button" onClick={() => display(true)}>🎨 All the knobs</button>
          </div>
          <p className="eic-remix-note">Party mode switches between Party and Still. Choose Calm in All the knobs. Saved only on this device. Sound stays off unless you turn it on. Your device's reduced-motion setting always wins.</p>
        </Window>
        <div className="eic-mini-row">
          <LandingCassette />
          <div className="eic-doodle"><span>your next masterpiece</span><div aria-hidden="true">✿<b>☺</b>✧</div><Link to={unlocked ? "/draw" : "/unlock"}>Open Paint ↗</Link></div>
        </div>
        <div className="eic-desk-note">✧ A real working preview of this build's customization. Your vault content stays private.</div>
      </div>
    </section>
  );
}

// Local visual toy only. It never starts audio or changes saved display preferences.
function LandingCassette() {
  const [sideB, setSideB] = useState(false);
  const [spinning, setSpinning] = useState(false);
  return (
    <section aria-label="Two-sided mixtape" className="eic-mixtape" data-side={sideB ? "b" : "a"} data-spinning={spinning}>
      <div className="eic-tape-stage" aria-hidden="true">
        <div className="eic-tape-body">
          <div className="eic-tape-face eic-tape-front">
            <span className="eic-tape-label">42b / SIDE A</span>
            <div className="eic-tape-reels"><i /><span>♫</span><i /></div>
            <span className="eic-tape-scribble">original songs. zero login.</span>
          </div>
          <div className="eic-tape-face eic-tape-back">
            <span className="eic-tape-label">42b / SIDE B</span>
            <div className="eic-tape-reels"><i /><span>✧</span><i /></div>
            <span className="eic-tape-scribble">a little weird. all yours.</span>
          </div>
        </div>
      </div>
      <p role="status" className="eic-tape-status">{sideB ? "Side B · Make it yours" : "Side A · Original songs"}</p>
      <div className="eic-tape-controls">
        <button type="button" onClick={() => setSideB(b => !b)} aria-label={sideB ? "Flip to Side A" : "Flip to Side B"}>Flip to {sideB ? "A" : "B"} ↻</button>
        <button type="button" aria-pressed={spinning} onClick={() => setSpinning(s => !s)}>{spinning ? "Pause reels" : "Spin reels"}</button>
      </div>
      <p className="eic-tape-motion-note">Visual only. Still and reduced motion pause the animation.</p>
      <Link to="/music-library" aria-label="Open cassette music library">Open music · {musicCatalog.length} songs ↗</Link>
    </section>
  );
}

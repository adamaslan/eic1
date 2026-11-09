import { Link } from "react-router";
import { PROFILE_AVATARS } from "@veil/features";
import { themePresets, type ThemePresetId } from "@veil/tokens";
import { useThemeStore } from "~/platform/theme-store";
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
          <Link to="/music-library" className="eic-music-link">♫ Press play · 42 songs</Link>
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
            <button type="button" aria-label="Party mode" aria-pressed={theme.motion === "party"} onClick={() => set({ motion: theme.motion === "party" ? "off" : "party" })}>{theme.motion === "party" ? "✦ Party on" : theme.motion === "off" ? "Ⅱ Still" : "✦ Try Party"}</button>
            <button type="button" aria-pressed={theme.soft} onClick={() => set({ soft: !theme.soft })}>◕ Soft corners</button>
            <button type="button" onClick={() => display(true)}>🎨 All the knobs</button>
          </div>
          <p className="eic-remix-note">Saved only on this device. Sound stays off unless you turn it on. Your device's reduced-motion setting always wins.</p>
        </Window>
        <div className="eic-mini-row">
          <div className="eic-mixtape"><span className="eic-tape-label">42b / SIDE A</span><div className="eic-tape-reels"><i /><span>♫</span><i /></div><Link to="/music-library">Original songs. Zero login. ↗</Link></div>
          <div className="eic-doodle"><span>your next masterpiece</span><div aria-hidden="true">✿<b>☺</b>✧</div><Link to={unlocked ? "/draw" : "/unlock"}>Open Paint ↗</Link></div>
        </div>
        <div className="eic-desk-note">✧ A real working preview of this build's customization. Your vault content stays private.</div>
      </div>
    </section>
  );
}

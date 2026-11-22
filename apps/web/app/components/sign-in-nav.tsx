import { Link, NavLink } from "react-router";
import { PROFILE_AVATARS } from "@veil/features";
import { useThemeStore } from "~/platform/theme-store";

/** Public-only links: never reveal a private route or change an unlock/link handoff. */
export function SignInNav() {
  const display = useThemeStore((state) => state.setDisplayOpen);
  return (
    <nav aria-label="Sign-in navigation" className="eic-sign-in-nav">
      <Link to="/" className="eic-sign-in-brand">
        <img src={`data:image/png;base64,${PROFILE_AVATARS[0].data}`} alt="" width={34} height={34} />
        <span>Everybody is <b>cool.</b><small>your little world ✦</small></span>
      </Link>
      <div className="eic-sign-in-links">
        <NavLink to="/music-library">♫ Music</NavLink>
        <NavLink to="/stickers">✿ Stickers</NavLink>
        <NavLink to="/learn-piano">♪ Piano</NavLink>
        <button type="button" onClick={() => display(true)}>🎨 Display</button>
        <NavLink to="/unlock">Open vault ↗</NavLink>
      </div>
    </nav>
  );
}

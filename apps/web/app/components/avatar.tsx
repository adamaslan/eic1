import { useLocation } from "react-router";
import { useEffect, useState } from "react";
import { loadDisplayAvatar, type Profile } from "@veil/features";
import { useSessionStore } from "~/platform/session";

/** Display only. Never changes a feed profile or serializes a private draft. */
export function Avatar({ authorId, label = "Your avatar", size = 28, svg = false }: { authorId?: string; label?: string; size?: number; svg?: boolean }) {
  const { pathname } = useLocation();
  const [revision, refresh] = useState(0);
  useEffect(() => { const update = () => refresh(n => n + 1); window.addEventListener("eic-avatar-updated", update); return () => window.removeEventListener("eic-avatar-updated", update); }, []);
  const vault = useSessionStore(state => state.vault);
  const [result, setResult] = useState<{ vault: typeof vault; id: typeof authorId; avatar: Profile["avatar"] } | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!vault) return;
    void (async () => {
      const avatar = await loadDisplayAvatar(vault, authorId);
      if (!cancelled) setResult({ vault, id: authorId, avatar });
    })().catch(() => { if (!cancelled) setResult(null); });
    return () => { cancelled = true; };
  }, [vault, authorId, pathname, revision]);
  const avatar = result?.vault === vault && result?.id === authorId ? result.avatar : null;
  // Imported assets stay embedded images. No remote URLs or active markup.
  const src = avatar ? `data:${avatar.mime};base64,${avatar.data}` : null;
  if (!src) return null;
  return svg
    ? <image href={src} x={-size / 2} y={-size / 2} width={size} height={size} aria-label={label} style={{ pointerEvents: "none" }} />
    : <img src={src} alt={label} width={size} height={size} className="inline-block shrink-0 object-contain align-middle" />;
}

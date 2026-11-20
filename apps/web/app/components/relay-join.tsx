import { useEffect, useRef, useState } from "react";
import { Button95 } from "~/ui95/Button95";

// Human check for relay self-enrollment. The widget loads only when a public site key is configured.
// Only the site key is in the browser. The secret and the verification both live on the relay server.
const SITE_KEY = import.meta.env.VITE_EIC_TURNSTILE_SITE_KEY as string | undefined;
const SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
const CHECK_FAILED = "The check did not load. Reload the page and try again.";

type Turnstile = {
  render(element: HTMLElement, options: { sitekey: string; callback: (token: string) => void; "expired-callback": () => void; "error-callback": () => void }): string;
};
declare global { interface Window { turnstile?: Turnstile } }

function loadTurnstile(): Promise<Turnstile> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT;
    script.async = true;
    script.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error(CHECK_FAILED)));
    script.onerror = () => reject(new Error(CHECK_FAILED));
    document.head.appendChild(script);
  });
}

export function RelayJoin({ onJoin }: { onJoin: (token: string) => Promise<void> }) {
  const box = useRef<HTMLDivElement>(null);
  const [token, setToken] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!SITE_KEY || !box.current) return;
    let cancelled = false;
    loadTurnstile().then((turnstile) => {
      if (cancelled || !box.current) return;
      turnstile.render(box.current, {
        sitekey: SITE_KEY,
        callback: (value) => setToken(value),
        "expired-callback": () => setToken(null),
        "error-callback": () => setStatus(CHECK_FAILED),
      });
    }).catch(() => { if (!cancelled) setStatus(CHECK_FAILED); });
    return () => { cancelled = true; };
  }, []);

  if (!SITE_KEY) return <p className="text-[12px]">Joining the encrypted relay is not set up in this build.</p>;

  async function join() {
    if (!token) return;
    setBusy(true); setStatus("");
    try {
      await onJoin(token);
      setStatus("You're in. Discover will load now.");
    } catch (caught) {
      setStatus(caught instanceof Error ? caught.message : "Joining did not finish. Try again.");
    } finally {
      // A check token is single use: clear it so the next attempt needs a fresh check.
      setToken(null); setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-2 border border-[var(--w95-muted)] p-2" aria-label="Join the encrypted relay">
      <p className="font-bold">Join Discover</p>
      <p className="text-[12px]">One quick check keeps this open to people, not bots. Your keys stay on this device. The relay only learns that a verified person joined.</p>
      <div ref={box} />
      <Button95 type="button" disabled={!token || busy} onClick={() => { void join(); }}>{busy ? "Joining…" : "Join"}</Button95>
      {status && <p role="status" className="text-[12px]">{status}</p>}
    </section>
  );
}

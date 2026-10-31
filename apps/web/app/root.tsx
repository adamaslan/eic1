import { useEffect, useState } from "react";
import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "react-router";
import { AppError } from "@veil/core";
import { importShareBundle, loadSettings, parseShareBundle, readPostShareLink } from "@veil/features";

import type { Route } from "./+types/root";
import stylesheet from "./app.css?url";
import { Button95 } from "~/ui95/Button95";
import { Window } from "~/ui95/Window";
import { useSessionStore } from "~/platform/session";
import { useAutoLock, useSessionExpiry } from "~/platform/use-auto-lock";
import { newItemId, vaultResume } from "~/platform/vault-service";

export const links: Route.LinksFunction = () => [
  { rel: "stylesheet", href: stylesheet },
];

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  const vault = useSessionStore((state) => state.vault);
  const lock = useSessionStore((state) => state.lock);
  const expiresAt = useSessionStore((state) => state.expiresAt);
  useAutoLock(vault !== null, lock);
  useSessionExpiry(expiresAt, lock);

  // A reload drops the in-memory vault; reopen it from the session saved in the last hour, if any.
  useEffect(() => {
    let cancelled = false;
    const startRevision = useSessionStore.getState().revision;
    vaultResume().then((resumed) => {
      if (cancelled) return;
      const state = useSessionStore.getState();
      // A manual unlock or lock while the resume was in flight wins; drop the stale result.
      if (state.revision !== startRevision) return;
      if (resumed) state.setVault(resumed.vault, resumed.expiresAt);
      else state.doneResuming();
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      <Outlet />
      <ShareLinkImport vault={vault} />
    </>
  );
}

/**
 * Watches for a share-one-post link (`#import=...`). The post travels in the URL fragment, so it
 * never reaches a server; once the vault is unlocked we offer to import it, then strip the hash.
 */
function ShareLinkImport({ vault }: { vault: ReturnType<typeof useSessionStore.getState>["vault"] }) {
  const [bundleText, setBundleText] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // A key-card bundle carries no posts: the dialog must say what importing it actually does.
  const [isKeyCard, setIsKeyCard] = useState(false);

  useEffect(() => {
    if (!vault) return;
    const read = () => {
      try {
        const text = readPostShareLink(window.location.hash);
        if (text) {
          setBundleText(text);
          setIsKeyCard(parseShareBundle(text).posts.length === 0);
        }
      } catch (caught) {
        setMessage(caught instanceof AppError ? caught.message : "That share link could not be read.");
      }
    };
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, [vault]);

  if (!vault || (bundleText === null && message === null)) return null;

  const dismiss = () => {
    setBundleText(null);
    setMessage(null);
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
  };

  const doImport = async () => {
    if (!bundleText) return;
    setBusy(true);
    try {
      const settings = await loadSettings(vault);
      const result = await importShareBundle(vault, bundleText, { settings, newId: newItemId, now: new Date() });
      setBundleText(null);
      setMessage(
        result.keyAdded
          ? `Chat unlocked with @${result.handle} - verified key saved. Your connection and history are unchanged.`
          : `Imported from @${result.handle}: ${result.added} new, ${result.updated} updated. The post is in your vault and renders offline from here on.`,
      );
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    } catch (caught) {
      setMessage(caught instanceof AppError ? caught.message : "That share link could not be imported.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
      <div className="max-w-md">
        <Window title="A friend shared a post with you">
          <div className="flex flex-col gap-2 text-[12px]">
            {bundleText !== null ? (
              <>
                <p>
                  {isKeyCard
                    ? "This link carries a friend's chat key - no posts. Importing it verifies their key and unlocks chat; your connection and history stay as they are."
                    : "This link carries a post from a friend. Import it into your vault?"}
                </p>
                <div className="flex gap-1">
                  <Button95 onClick={() => void doImport()} disabled={busy}>Import</Button95>
                  <Button95 onClick={dismiss} disabled={busy}>Not now</Button95>
                </div>
              </>
            ) : (
              <>
                <p role="status">{message}</p>
                <div><Button95 onClick={dismiss}>Close</Button95></div>
              </>
            )}
          </div>
        </Window>
      </div>
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let message = "Oops!";
  let details = "An unexpected error occurred.";
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? "404" : "Error";
    details =
      error.status === 404
        ? "The requested page could not be found."
        : error.statusText || details;
  } else if (import.meta.env.DEV && error && error instanceof Error) {
    details = error.message;
    stack = error.stack;
  }

  return (
    <main className="pt-16 p-4 container mx-auto">
      <h1>{message}</h1>
      <p>{details}</p>
      {stack && (
        <pre className="w-full p-4 overflow-x-auto">
          <code>{stack}</code>
        </pre>
      )}
    </main>
  );
}

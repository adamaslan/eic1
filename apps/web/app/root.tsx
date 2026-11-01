import { useEffect, useRef, useState } from "react";
import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useNavigate,
} from "react-router";
import { AppError } from "@veil/core";
import {
  CHAT_LINK_PREFIX,
  CONNECT_LINK_PREFIX,
  POST_LINK_PREFIX,
  applyChatShareLink,
  importConnectCard,
  importShareBundle,
  loadSettings,
  peekConnectCardHandle,
  readChatShareLink,
  readConnectLink,
  readPostShareLink,
  type ChatLink,
} from "@veil/features";

import type { Route } from "./+types/root";
import stylesheet from "./app.css?url";
import { Button95 } from "~/ui95/Button95";
import { Window } from "~/ui95/Window";
import { useSessionStore } from "~/platform/session";
import { useAutoLock, useSessionExpiry } from "~/platform/use-auto-lock";
import { newItemId, vaultResume } from "~/platform/vault-service";

export const links: Route.LinksFunction = () => [
  { rel: "stylesheet", href: stylesheet },
  { rel: "manifest", href: "/manifest.webmanifest" },
  { rel: "apple-touch-icon", href: "/icon-180.png" },
];

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {/* Link previews (iMessage fetches these without running JavaScript) get the cute
            static card; message content never leaves the URL fragment, so no unfurler or
            server can see it. */}
        <meta property="og:type" content="website" />
        <meta property="og:title" content="You've got mail 💌" />
        <meta property="og:site_name" content="eic - everybody is cool" />
        <meta property="og:description" content="A tiny encrypted hello. Tap to open it - nothing to download, no account wall." />
        <meta property="og:image" content="https://everybodyiscool.netlify.app/og-image.png" />
        <meta name="theme-color" content="#008080" />
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

const PENDING_LINK_KEY = "eic.pendingLinkHash";

const isLinkHash = (hash: string): boolean =>
  hash.startsWith(POST_LINK_PREFIX) || hash.startsWith(CHAT_LINK_PREFIX) || hash.startsWith(CONNECT_LINK_PREFIX);

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

  // A link's payload lives in the URL hash, which route changes (like going to /unlock) drop.
  // Stash it on arrival so the unlock flow cannot eat the message the link was carrying.
  useEffect(() => {
    const stash = () => {
      const hash = window.location.hash;
      if (isLinkHash(hash)) {
        try {
          window.sessionStorage.setItem(PENDING_LINK_KEY, hash);
        } catch {
          // Private mode: the live hash still works while it survives.
        }
      }
    };
    stash();
    window.addEventListener("hashchange", stash);
    return () => window.removeEventListener("hashchange", stash);
  }, []);

  return (
    <>
      <Outlet />
      <PendingLinkHandler vault={vault} />
    </>
  );
}

type PendingLink =
  | { kind: "post"; text: string }
  | { kind: "chat"; link: ChatLink }
  | { kind: "connect"; text: string };

function readPendingLink(hash: string): PendingLink | null {
  const post = readPostShareLink(hash);
  if (post) return { kind: "post", text: post };
  const chat = readChatShareLink(hash);
  if (chat) return { kind: "chat", link: chat };
  const card = readConnectLink(hash);
  if (card) return { kind: "connect", text: card };
  return null;
}

/**
 * Watches for eic links (`#import=`, `#chat=`, `#connect=...`). The payload travels in the URL
 * fragment, so it never reaches a server. Chat links apply and open the conversation on their
 * own (they are sealed, signed, and idempotent); connect links ask first because they create a
 * connection from a bearer link; post links keep the original import prompt. Handled hashes are
 * stripped once consumed.
 */
function PendingLinkHandler({ vault }: { vault: ReturnType<typeof useSessionStore.getState>["vault"] }) {
  const navigate = useNavigate();
  const [pending, setPending] = useState<PendingLink | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const openingChat = useRef(false);

  useEffect(() => {
    if (!vault) return;
    const read = () => {
      let hash = window.location.hash;
      if (!isLinkHash(hash)) {
        try {
          hash = window.sessionStorage.getItem(PENDING_LINK_KEY) ?? hash;
        } catch {
          // No stash available; the live hash is all we have.
        }
      }
      try {
        const link = readPendingLink(hash);
        if (link === null) return;
        setPending((current) => current ?? link);
        if (link.kind === "chat" && !openingChat.current) {
          openingChat.current = true;
          void openChatLink(link.link);
        }
      } catch (caught) {
        setMessage(caught instanceof AppError ? caught.message : "That link could not be read.");
      }
    };
    const openChatLink = async (chatLink: ChatLink) => {
      setBusy(true);
      try {
        const result = await applyChatShareLink(vault, chatLink, { newId: newItemId, now: () => new Date() });
        consumeHash();
        setPending(null);
        navigate(`/chat/${result.authorId}`);
      } catch (caught) {
        consumeHash();
        setPending(null);
        setMessage(caught instanceof AppError ? caught.message : "That chat link could not be opened.");
      } finally {
        openingChat.current = false;
        setBusy(false);
      }
    };
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vault]);

  const consumeHash = () => {
    try {
      window.sessionStorage.removeItem(PENDING_LINK_KEY);
    } catch {
      // Best effort.
    }
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
  };

  const dismiss = () => {
    consumeHash();
    setPending(null);
    setMessage(null);
  };

  const doImport = async () => {
    if (!vault || pending?.kind !== "post") return;
    setBusy(true);
    try {
      const settings = await loadSettings(vault);
      const result = await importShareBundle(vault, pending.text, { settings, newId: newItemId, now: new Date() });
      setPending(null);
      setMessage(`Imported from @${result.handle}: ${result.added} new, ${result.updated} updated. The post is in your vault and renders offline from here on.`);
      consumeHash();
    } catch (caught) {
      setMessage(caught instanceof AppError ? caught.message : "That share link could not be imported.");
    } finally {
      setBusy(false);
    }
  };

  const doConnect = async () => {
    if (!vault || pending?.kind !== "connect") return;
    setBusy(true);
    try {
      const settings = await loadSettings(vault);
      const result = await importConnectCard(vault, pending.text, { settings, newId: newItemId, now: new Date() });
      consumeHash();
      setPending(null);
      navigate(`/chat/${result.authorId}`);
    } catch (caught) {
      setMessage(caught instanceof AppError ? caught.message : "That connect link could not be used.");
    } finally {
      setBusy(false);
    }
  };

  const connectHandle = pending?.kind === "connect" ? peekConnectCardHandle(pending.text) : null;

  if (!vault || (pending === null && message === null)) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
      <div className="w-full max-w-md">
        {pending?.kind === "chat" && message === null ? (
          <Window title="You've got mail 💌">
            <p className="text-[12px]">Opening your chat…</p>
          </Window>
        ) : pending?.kind === "connect" && message === null ? (
          <Window title="A friend wants to connect">
            <div className="flex flex-col gap-2 text-[12px]">
              <p>
                This link carries {connectHandle ? `@${connectHandle}'s` : "a friend's"} signed card - handle and key,
                nothing else. The signature checks out against the card itself, so trust it only if it reached you
                from them directly, not forwarded by someone else.
              </p>
              <p>Add {connectHandle ? `@${connectHandle}` : "them"} as a connection and open your chat?</p>
              <div className="flex gap-1">
                <Button95 onClick={() => void doConnect()} disabled={busy}>Add and open chat</Button95>
                <Button95 onClick={dismiss} disabled={busy}>Not now</Button95>
              </div>
            </div>
          </Window>
        ) : pending?.kind === "post" && message === null ? (
          <Window title="A friend shared a post with you">
            <div className="flex flex-col gap-2 text-[12px]">
              <p>This link carries a post from a friend. Import it into your vault?</p>
              <div className="flex gap-1">
                <Button95 onClick={() => void doImport()} disabled={busy}>Import</Button95>
                <Button95 onClick={dismiss} disabled={busy}>Not now</Button95>
              </div>
            </div>
          </Window>
        ) : (
          <Window title="Link">
            <div className="flex flex-col gap-2 text-[12px]">
              <p role="status">{message}</p>
              <div><Button95 onClick={dismiss}>Close</Button95></div>
            </div>
          </Window>
        )}
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

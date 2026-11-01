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
  KeyRotationError,
  MAX_CHAT_LINK_CHARS,
  applyChatShareLink,
  importConnectCard,
  importShareBundle,
  loadSettings,
  parseShareBundle,
  peekConnectCardAuthor,
  peekConnectCardHandle,
  readChatShareLink,
  readConnectLink,
  isJournalShareBundle,
  parseJournalShareBundle,
  readPostShareLink,
  saveSharedJournalEntry,
  type ChatLink,
} from "@veil/features";

import type { Route } from "./+types/root";
import stylesheet from "./app.css?url";
import {
  bindStashesToVault,
  dropAllStashes,
  readMemoryArrival,
  dropStash,
  kindOfHash,
  readStash,
  resolveStashForVault,
  sessionSlotStore,
  writeStash,
  LEGACY_PENDING_LINK_KEY,
  type PendingKind,
} from "~/pending-links";
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
            static card. Message content rides in the URL fragment, which browsers keep out of
            HTTP requests to the app host and preview fetchers; the link text itself still
            travels through whatever messaging app carries it. */}
        <meta property="og:type" content="website" />
        <meta property="og:title" content="You've got mail 💌" />
        <meta property="og:site_name" content="eic - everybody is cool" />
        <meta property="og:description" content="A tiny encrypted hello. Tap to open it - nothing to download, no account wall." />
        <meta property="og:image" content="https://everybodyiscool.netlify.app/og-image.png" />
        <meta name="theme-color" content="#008080" />
        {/* Parse-time link capture: a synchronous classic script, so the tapped link's hash
            is parked in this document before anything is tappable. Keep it off sessionStorage:
            journal links contain plaintext entry text. entry.client.tsx classifies the link
            and retains journal links in memory only. */}
        <script
          dangerouslySetInnerHTML={{
            __html: "try{var h=window.location.hash;if(h&&h.length>1){window.__eicArrivalHash=h}}catch(e){}",
          }}
        />
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

const isLinkHash = (hash: string): boolean => kindOfHash(hash) !== null;

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
  // Stash it on arrival, one slot per link kind, so the unlock flow cannot eat the message the
  // link was carrying. A slot stashed before the vault rehydrates (the normal tap from a text
  // is a full page load) starts UNBOUND and binds to the first vault that reads it after
  // unlock; a slot bound to one vault is dropped, never applied, for any other vault.
  useEffect(() => {
    const store = sessionSlotStore();
    store.remove(LEGACY_PENDING_LINK_KEY); // migrate the legacy pre-v2 single slot; v2 slots survive page loads until consumed, locked out, or read by another vault
    const stash = () => {
      const hash = window.location.hash;
      const kind = kindOfHash(hash);
      if (!kind) return;
      const active = useSessionStore.getState().vault;
      const write = (forAuthorId: string | null) => writeStash(store, kind, { hash, forAuthorId, stashedAt: Date.now() });
      if (!active) {
        write(null);
        return;
      }
      loadSettings(active)
        .then((settings) => write(settings.authorId ?? null))
        .catch(() => write(null));
    };
    stash();
    window.addEventListener("hashchange", stash);
    return () => window.removeEventListener("hashchange", stash);
  }, []);

  // Locking drops every pending slot: no stashed prompt survives into another session.
  // Unlocking binds every unbound slot to this vault: the primary tap path stashes while
  // the vault is still rehydrating (forAuthorId null), so the slot must bind as soon as
  // the vault arrives or the cross-vault guard never engages for it.
  const hadVault = useRef(false);
  useEffect(() => {
    if (vault) {
      hadVault.current = true;
      let cancelled = false;
      loadSettings(vault).then((settings) => {
        if (!cancelled && settings.authorId) bindStashesToVault(sessionSlotStore(), settings.authorId);
      });
      return () => {
        cancelled = true;
      };
    } else if (hadVault.current) {
      hadVault.current = false;
      dropAllStashes(sessionSlotStore());
    }
  }, [vault]);

  return (
    <>
      <Outlet />
      <PendingLinkHandler vault={vault} />
    </>
  );
}

type PendingLink =
  | { kind: "post"; text: string }
  | { kind: "journal"; text: string }
  | { kind: "chat"; link: ChatLink }
  | { kind: "connect"; text: string };

function readPendingLink(hash: string): PendingLink | null {
  if (hash.length > MAX_CHAT_LINK_CHARS) throw new AppError("That link is too long to be an eic link.");
  const post = readPostShareLink(hash);
  if (post) return isJournalShareBundle(post) ? { kind: "journal", text: post } : { kind: "post", text: post };
  const chat = readChatShareLink(hash);
  if (chat) return { kind: "chat", link: chat };
  const card = readConnectLink(hash);
  if (card) return { kind: "connect", text: card };
  return null;
}

/**
 * Watches for eic links (`#import=`, `#chat=`, `#connect=...`). The payload travels in the URL
 * fragment, which browsers never put into an HTTP request to the app host. Chat links apply and open the conversation on their
 * own (they are sealed, signed, and idempotent); connect links ask first because they create a
 * connection from a bearer link; post links keep the original import prompt. Handled hashes are
 * stripped once consumed.
 */
function PendingLinkHandler({ vault }: { vault: ReturnType<typeof useSessionStore.getState>["vault"] }) {
  const navigate = useNavigate();
  const [pending, setPending] = useState<PendingLink | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [connectTick, setConnectTick] = useState(0);
  const openingChat = useRef(false);
  // A key-card bundle carries no posts: the dialog must say what importing it actually does.
  const [isKeyCard, setIsKeyCard] = useState(false);
  // The claimed author (v2 cards carry a key; v1 files do not) so the dialog can name whose
  // key it is and show a short fingerprint for comparison.
  const [claimed, setClaimed] = useState<{ handle: string; pubkey: string | null } | null>(null);
  // Set when the card's key differs from the saved verified key: replacing needs its own
  // explicit confirmation, never a side effect of one Import click.
  const [rotationPending, setRotationPending] = useState(false);

  useEffect(() => {
    if (!vault) return;
    const read = async () => {
      let hash = window.location.hash;
      let kind = kindOfHash(hash);
      if (!kind) {
        // Fall back to stashed slots - connect first, so a pending connection is added before
        // a stashed chat link tries to apply. An unbound slot binds to this vault (first unlock
        // after the tap); a slot keyed to another vault is dropped, never applied.
        const store = sessionSlotStore();
        const settings = await loadSettings(vault);
        for (const slot of ["connect", "chat", "post"] as const) {
          const entry = resolveStashForVault(store, slot, settings.authorId ?? null);
          if (!entry) continue;
          hash = entry.hash;
          kind = slot;
          break;
        }
      }
      if (!kind) {
        // Denied-storage path: the link survives only in memory, for this document's life.
        const retained = readMemoryArrival();
        const retainedKind = retained ? kindOfHash(retained) : null;
        if (retained && retainedKind) {
          hash = retained;
          kind = retainedKind;
        }
      }
      if (!kind) return;
      try {
        const link = readPendingLink(hash);
        if (link === null) return;
        if (link.kind === "post") {
          // #41's dialog enrichment: name whose key/post this is and say what importing does.
          try {
            const parsed = parseShareBundle(link.text);
            setIsKeyCard(parsed.version === 2 && parsed.posts.length === 0);
            setClaimed({ handle: parsed.author.handle, pubkey: parsed.version === 2 ? parsed.author.pubkey : null });
          } catch {
            setIsKeyCard(false);
            setClaimed(null);
          }
        }
        if (link.kind === "connect") {
          // Reject your own card up front instead of confirming first and failing after.
          const author = peekConnectCardAuthor(link.text);
          const settings = await loadSettings(vault);
          if (author && settings.authorId && author.id === settings.authorId) {
            dropStash(sessionSlotStore(), "connect");
            stripUrlHash();
            setMessage("That is your own connect link - text it to a friend, not yourself.");
            return;
          }
        }
        setPending((current) => current ?? link);
        // A fresh link supersedes any error the previous attempt showed.
        setMessage(null);
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
        setPending(null);
        if (result.failed === 0) {
          consumeHash("chat");
          navigate(`/chat/${result.authorId}`);
        } else {
          // Honest partial result; keep the stash so a retry (or a re-tap) can pick up the rest.
          setMessage(
            result.applied > 0
              ? `Opened ${result.applied} of ${result.total} messages; ${result.failed} could not be opened - ask for a fresh link.`
              : `None of the ${result.total} messages in that link could be opened - ask for a fresh link.`,
          );
          if (result.applied > 0) navigate(`/chat/${result.authorId}`);
        }
      } catch (caught) {
        // Keep the stash: a chat link that cannot apply yet (for example, the sender is not a
        // connection yet) opens on its own once that changes - no re-tap needed.
        stripUrlHash();
        setPending(null);
        setMessage(caught instanceof AppError ? caught.message : "That chat link could not be opened.");
      } finally {
        openingChat.current = false;
        setBusy(false);
      }
    };
    void read();
    const onHash = () => void read();
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vault, connectTick]);

  const stripUrlHash = () => {
    if (isLinkHash(window.location.hash)) {
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    }
  };

  const consumeHash = (kind: PendingKind) => {
    dropStash(sessionSlotStore(), kind);
    stripUrlHash();
  };

  const dismiss = (kind?: PendingKind) => {
    if (kind) consumeHash(kind);
    else stripUrlHash();
    setPending(null);
    setMessage(null);
    setRotationPending(false);
  };

  const fingerprint = (pubkey: string) => pubkey.slice(0, 8);

  const doImport = async (allowKeyRotation = false) => {
    if (!vault || pending?.kind !== "post") return;
    setBusy(true);
    try {
      const settings = await loadSettings(vault);
      const result = await importShareBundle(vault, pending.text, { settings, newId: newItemId, now: new Date() }, { allowKeyRotation });
      setPending(null);
      setRotationPending(false);
      setMessage(
        result.keyChanged
          ? `Key replaced for @${result.handle} - future chat seals to the new key. Your connection and history are unchanged.`
          : result.keyAdded
            ? isKeyCard
              ? `Chat unlocked with @${result.handle} - verified key saved. Your connection and history are unchanged.`
              : `Imported from @${result.handle}: ${result.added} new, ${result.updated} updated. Chat unlocked with @${result.handle} - the verified key was saved with it. The post is in your vault and renders offline from here on.`
            : isKeyCard
              ? `Chat already unlocked with @${result.handle} - the saved verified key is unchanged. Nothing new to import.`
              : `Imported from @${result.handle}: ${result.added} new, ${result.updated} updated. The post is in your vault and renders offline from here on.`,
      );
      consumeHash("post");
    } catch (caught) {
      if (caught instanceof KeyRotationError) {
        // Distinct confirmation step: the first Import click only surfaces the warning.
        setRotationPending(true);
      } else {
        setMessage(caught instanceof AppError ? caught.message : "That share link could not be imported.");
      }
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
      consumeHash("connect");
      setPending(null);
      // A chat link that arrived before the connection existed has been waiting in its slot.
      // When one is waiting, let its apply own the navigation: the chat route loads its
      // messages on mount, so navigating here first would mount an empty conversation and
      // never show the message the link carried.
      const waitingChat = resolveStashForVault(sessionSlotStore(), "chat", settings.authorId ?? null);
      setConnectTick((tick) => tick + 1);
      if (!waitingChat) navigate(`/chat/${result.authorId}`);
    } catch (caught) {
      setMessage(caught instanceof AppError ? caught.message : "That connect link could not be used.");
    } finally {
      setBusy(false);
    }
  };

  const doSaveJournalCopy = async () => {
    if (!vault || pending?.kind !== "journal") return;
    setBusy(true);
    try {
      const bundle = parseJournalShareBundle(pending.text);
      await saveSharedJournalEntry(vault, bundle, { newId: newItemId });
      setPending(null);
      consumeHash("post"); // journal links ride the #import= channel and its stash slot
      setMessage(`A copy of @${bundle.author.handle}'s entry is in your journal - yours to keep even if they delete theirs.`);
    } catch (caught) {
      setMessage(caught instanceof AppError ? caught.message : "That shared entry could not be saved.");
    } finally {
      setBusy(false);
    }
  };

  const journalShare = (() => {
    if (pending?.kind !== "journal") return null;
    try {
      return parseJournalShareBundle(pending.text);
    } catch {
      return null;
    }
  })();

  const connectHandle = pending?.kind === "connect" ? peekConnectCardHandle(pending.text) : null;

  if (!vault || (pending === null && message === null)) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
      <div className="w-full max-w-md max-h-full overflow-y-auto">
        {pending?.kind === "chat" && message === null ? (
          <Window title="You've got mail 💌">
            <div className="flex flex-col gap-2 text-[12px]">
              <p>Opening your chat…</p>
              <div><Button95 onClick={() => dismiss("chat")} disabled={busy}>Close</Button95></div>
            </div>
          </Window>
        ) : pending?.kind === "connect" && message === null ? (
          <Window title="A friend wants to connect">
            <div className="flex flex-col gap-2 text-[12px]">
              <p>
                This link carries {connectHandle ? `@${connectHandle}'s` : "a friend's"} signed card - handle, public
                key, and their feed address if they set one. Nothing else: no posts, no likes, no secrets. The
                signature checks out against the card itself, so trust it only if it reached you from them directly,
                not forwarded by someone else.
              </p>
              <p>Add {connectHandle ? `@${connectHandle}` : "them"} as a connection and open your chat?</p>
              <div className="flex gap-1">
                <Button95 onClick={() => void doConnect()} disabled={busy}>Add and open chat</Button95>
                <Button95 onClick={() => dismiss("connect")} disabled={busy}>Not now</Button95>
              </div>
            </div>
          </Window>
        ) : pending?.kind === "journal" ? (
          <Window title="A friend shared a journal entry">
            <div className="flex flex-col gap-2 text-[12px]">
              {journalShare ? (
                <>
                  <p className="bg-white px-1.5 py-1 whitespace-pre-wrap [overflow-wrap:anywhere] max-h-40 overflow-y-auto">{journalShare.entry.text}</p>
                  <p className="text-[#404040]">
                    @{journalShare.author.handle}, {new Date(journalShare.entry.createdAt).toLocaleString()} -
                    this came through their link, not a server. The entry stays in this tab's memory, not browser storage, until you save or dismiss it; it will be offered to the vault you unlock next.
                  </p>
                  <div className="flex gap-1">
                    <Button95 onClick={() => void doSaveJournalCopy()} disabled={busy}>Save a copy to my journal</Button95>
                    <Button95 onClick={() => dismiss("post")} disabled={busy}>Not now</Button95>
                  </div>
                </>
              ) : (
                <>
                  <p role="alert">That shared entry is damaged. Ask your friend for a fresh link.</p>
                  <div><Button95 onClick={() => dismiss("post")} disabled={busy}>Close</Button95></div>
                </>
              )}
              {message ? <p role="alert">{message}</p> : null}
            </div>
          </Window>
        ) : pending?.kind === "post" ? (
          <Window title={isKeyCard ? "A friend sent a chat key" : "A friend shared a post with you"}>
            <div className="flex flex-col gap-2 text-[12px]">
              {rotationPending && claimed ? (
                <>
                  <p role="alert">
                    This replaces the saved verified key for @{claimed.handle} (new key {claimed.pubkey ? fingerprint(claimed.pubkey) : "unknown"}…).
                    Only continue if they told you they rebuilt their vault - a new key could be someone else.
                  </p>
                  <div className="flex gap-1">
                    <Button95 onClick={() => void doImport(true)} disabled={busy}>Replace saved key</Button95>
                    <Button95 onClick={() => dismiss("post")} disabled={busy}>Cancel</Button95>
                  </div>
                </>
              ) : (
                <>
                  <p>
                    {isKeyCard && claimed
                      ? `This link claims a chat key for @${claimed.handle}${claimed.pubkey ? ` (key ${fingerprint(claimed.pubkey)}…)` : ""} - no posts. The signature proves the sender holds that key, not that they are who they claim: only import a link that came from them directly. Importing it saves the key and unlocks chat; your connection and history stay as they are.`
                      : "This link carries a post from a friend. Import it into your vault?"}
                  </p>
                  {message ? <p role="alert">{message}</p> : null}
                  <div className="flex gap-1">
                    <Button95 onClick={() => void doImport()} disabled={busy}>Import</Button95>
                    <Button95 onClick={() => dismiss("post")} disabled={busy}>Not now</Button95>
                  </div>
                </>
              )}
            </div>
          </Window>
        ) : (
          <Window title="Link">
            <div className="flex flex-col gap-2 text-[12px]">
              <p role="status">{message}</p>
              <div><Button95 onClick={() => dismiss()}>Close</Button95></div>
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

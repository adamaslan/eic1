import { Avatar } from "~/components/avatar";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router";
import { AppError, timeAgo } from "@veil/core";
import {
  CHAT_BODY_MAX,
  configureRelayFeed, createRelayTransport, signedRelayFetcher,
  publishRelaySnapshot, syncConnection, loadSettings, networkPolicy,
  buildChatShareLink,
  listChatThread,
  markThreadRead,
  describeSendError,
  sendChatMessage,
  loadChatDraft,
  saveChatDraft,
  outboundStatus,
  type ChatMessage,
} from "@veil/features";
import type { Route } from "./+types/chat";
import { Button95 } from "~/ui95/Button95";
import { Window } from "~/ui95/Window";
import { useSessionStore } from "~/platform/session";
import { useSocial } from "~/platform/use-social";
import { detectSyncNetwork } from "~/platform/sync-fetcher";
import { runForegroundCatchUp, startForegroundRelay } from "~/platform/foreground-relay";
import { RELAY_APPLIED_EVENT } from "~/platform/relay-background";
import {
  applyCatchUpOutcome,
  createThreadReload,
  handleLockLost,
  listenForApplied,
  withCatchUpLock,
  type AppliedChannel,
  type ContentionFlag,
} from "~/platform/chat-apply";
import { newItemId } from "~/platform/vault-service";

export function meta(_args: Route.MetaArgs) {
  return [{ title: "Chat — Everybody is Cool" }];
}

export const MISSING_RELAY_NOTICE = "This build has no relay endpoint. Messages are saved on this device but cannot reach your friend until the relay is set up.";
export function relayDisplayNotice(endpoint: string | undefined, notice: string | null): string | null {
  return endpoint ? notice : MISSING_RELAY_NOTICE;
}

const inputClass = "w-full bg-white px-1.5 py-1 text-[12px] text-[var(--w95-ink)] outline-none";

// Pure presentational half, exported for render tests. The route component below owns vault access.
export function ChatThreadView({
  handle,
  authorId,
  verified,
  messages,
  draft,
  busy,
  error,
  linkNotice,
  olderLeftOut,
  onDraft,
  onSend,
  onShareLink,
  onOlderLink,
  relay,
}: {
  handle: string;
  authorId?: string;
  verified: boolean;
  messages: ChatMessage[] | null;
  draft: string;
  busy: boolean;
  error: string | null;
  linkNotice: string | null;
  olderLeftOut?: number;
  onDraft: (value: string) => void;
  onSend: (event: FormEvent) => void;
  onShareLink: () => void;
  onOlderLink?: () => void;
  /** v2 (Supabase relay). When present it REPLACES the v1 chat-link handoff controls. */
  relay?: { notice: string | null; onRetry: () => void; onCheck: () => void };
  /** Newest sent message the relay committed. Drives queued / accepted; delivered comes from the receipt. */
}) {
  return (
    <div className="flex flex-col gap-3">
      <Window title={`Chat with @${handle}`}>
        {authorId && <div className="flex items-center gap-2"><Avatar authorId={authorId} label={`${handle}'s avatar`} />@{handle}</div>}
        <div className="flex flex-col gap-2 text-[12px]">
          {relay ? (
            <p className="bg-[#ffffe1] px-1.5 py-1">
              Messages are sealed for @{handle} and live in your vault; everything you see renders from local data.
              Sending puts an encrypted snapshot on the relay and retries automatically if it fails. Friends&apos; messages arrive while EIC is open and unlocked, about once a minute, on Wi-Fi (or on cellular when you turn on cellular sync in Settings).
              ⏳ Saved on this device means the message is only here. ✓ Sent to relay means the relay committed it. ✓✓ Delivered means @{handle}&apos;s device saved it. The relay cannot read your messages.
              Closed-app or background delivery is not supported on iPhone.
            </p>
          ) : (
            <>
              <p className="bg-[#ffffe1] px-1.5 py-1">
                Messages are sealed for @{handle} and live in your vault - chat is offline-first, and everything you see
                renders from local data. Automatic delivery is not connected yet, so hand messages over yourself. Text a
                chat link copies a link that carries your latest sealed messages inside the URL, after the #. Browsers
                keep that part off the wire to the app host, but the link text still passes through your messaging app
                like any text. One tap and eic opens right into this conversation.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Button95 onClick={onShareLink} disabled={busy || !verified}>Text a chat link</Button95>
                {onOlderLink && olderLeftOut ? (
                  <Button95 onClick={onOlderLink} disabled={busy || !verified}>Text the {olderLeftOut} older ones</Button95>
                ) : null}
                {linkNotice && <span role="status">{linkNotice}</span>}
              </div>
            </>
          )}
          {!verified && (
            <div role="alert" className="bg-[#ffffe1] px-1.5 py-1">
              <p>Chat is read-only until this connection is upgraded. <Link to="/connections" className="underline">Open Connections to upgrade</Link>.</p>
              <details>
                <summary className="cursor-pointer">Upgrade details</summary>
                <p>
              This connection came from an unsigned share file, so chat is read-only. To chat, ask @{handle} for a new
              signed share file and import it from the Connections screen. Your thread and nickname are kept; relay sync
              progress restarts when you re-import.
                </p>
              </details>
            </div>
          )}
          {messages === null ? (
            <p>Loading…</p>
          ) : messages.length === 0 ? (
            <p>{verified ? "No messages yet. Say hi - the first one is on you." : "No messages yet."}</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {messages.map((message) => (
                <li
                  key={message.id}
                  className={`flex flex-col bg-white px-1.5 py-1 ${message.direction === "out" ? "items-end" : "items-start"}`}
                >
                  <span className="inline-flex items-center gap-1 font-bold">{(message.direction === "out" || authorId) && <Avatar authorId={message.direction === "out" ? undefined : authorId} label={message.direction === "out" ? "Your avatar" : `${handle}'s avatar`} />}{message.direction === "out" ? "You" : `@${handle}`}</span>
                  <span className="whitespace-pre-wrap break-words">{message.body}</span>
                  <span className="text-[var(--w95-muted)]">
                    {timeAgo(message.sentAt, new Date())} ago
                    {message.direction === "out" && <> · <span role="status" aria-label={`Message status: ${DELIVERY_LABEL[outboundStatus(message)]}`}>{DELIVERY_LABEL[outboundStatus(message)]}</span></>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Window>

      <Window title="Send a message">
        <form onSubmit={onSend} className="flex flex-col gap-2 text-[12px]">
          <textarea
            className={inputClass}
            rows={3}
            value={draft}
            maxLength={CHAT_BODY_MAX}
            onChange={(event) => onDraft(event.target.value)}
            aria-label="Message"
            placeholder={verified ? `Write to @${handle}` : "Chat needs a verified connection"}
          />
          <div className="flex items-center gap-2">
            <Button95 type="submit" disabled={busy || !verified || !draft.trim()}>
              Send
            </Button95>
            <span className="text-[var(--w95-muted)]">
              {draft.length}/{CHAT_BODY_MAX}
            </span>
          </div>
          {relay?.notice && <p role="status" className="break-words">{relay.notice}</p>}
          {relay && (
            <details>
              <summary className="cursor-pointer text-[var(--w95-muted)]">Relay options</summary>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <Button95 type="button" disabled={busy || !verified} onClick={relay.onCheck}>Check for messages</Button95>
                <Button95 type="button" disabled={busy || !verified} onClick={relay.onRetry}>Retry relay send</Button95>
              </div>
            </details>
          )}
          {relay && (
            <details>
              <summary className="cursor-pointer text-[var(--w95-muted)]">Privacy and delivery details</summary>
            <p className="bg-[#ffffe1] px-1.5 py-1">
              Messages are sealed for @{handle} and live in your vault; everything you see renders from local data.
              When a relay endpoint is configured, Send also puts an encrypted snapshot on the relay, and Check for messages pulls @{handle}&apos;s replies.
              An open chat checks for replies about once a minute while visible and unlocked, on Wi-Fi. If this browser cannot tell Wi-Fi from mobile data (Safari on iPhone), small encrypted messages still sync and large catches-up wait; reported mobile data waits unless you allow it in Settings. Nothing runs after you close it, there are no push notifications, and nothing is delivered while EIC is closed or locked, and the relay cannot read your messages or tell you when they are read.
            </p>
            </details>
          )}
          {error && (
            <p role="alert" className="text-[#800000]">
              {error}
            </p>
          )}
        </form>
      </Window>
    </div>
  );
}

// Notices owned by the automatic foreground catch-up. An unchanged auto tick may clear
// only these; manual Send/Check guidance (pending publish, retry hints) shares the same
// notice slot and must survive auto ticks.
const AUTO_NOTICE_WAITING_WIFI = "Some sealed data has not arrived yet; auto check keeps retrying about once a minute. Your local messages are kept.";
const AUTO_NOTICE_WAITING_UNKNOWN = "A larger update is waiting for Wi-Fi - this browser cannot tell its connection type, so only small messages sync now. Allow mobile data in Settings to fetch it anyway; your local messages are kept.";
// Three distinct states. "Accepted" means the relay committed it, never that the friend has it.
const DELIVERY_LABEL = { queued: "⏳ Saved on this device", accepted: "✓ Sent to relay", delivered: "✓✓ Delivered" } as const;

// Neutral on purpose: skipped chunks may be fetch-exhausted (Check for messages can retry)
// or content that failed integrity/signature/parse verification (no retry can recover it).
const AUTO_NOTICE_SKIPPED = "Some sealed data could not be fetched or failed verification and was skipped. Check for messages can retry a fetch; data that failed verification cannot be recovered. Your local messages are kept.";
const AUTO_NOTICES: readonly string[] = [AUTO_NOTICE_WAITING_WIFI, AUTO_NOTICE_WAITING_UNKNOWN, AUTO_NOTICE_SKIPPED];

export default function Chat({ params }: Route.ComponentProps) {
  const vault = useSessionStore((state) => state.vault);
  const social = useSocial(vault);
  const authorId = params.authorId;
  const connection = social.connections.find((candidate) => candidate.id === authorId);
  const [relayNotice, setRelayNotice] = useState<string | null>(null);
  const relayEndpoint = import.meta.env.VITE_EIC_RELAY_ENDPOINT as string | undefined;
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [olderLeftOut, setOlderLeftOut] = useState(0);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [linkNotice, setLinkNotice] = useState<string | null>(null);

  // The message box survives a reload: its text is saved encrypted in the vault, per chat. Saves run one at a
  // time so an older write never lands after a newer one, and a draft is only saved for the chat it was loaded for.
  const draftOwnerRef = useRef<string | null>(null);
  const draftPendingRef = useRef<{ owner: string; body: string } | null>(null);
  const draftChainRef = useRef<Promise<void>>(Promise.resolve());
  const writeDraft = useCallback((owner: string, body: string) => {
    if (!vault) return draftChainRef.current;
    draftChainRef.current = draftChainRef.current.then(() => saveChatDraft(vault, owner, body)).catch(() => undefined);
    return draftChainRef.current;
  }, [vault]);
  useEffect(() => {
    draftOwnerRef.current = null;
    setDraft("");
    if (!vault || !authorId) return;
    let cancelled = false;
    void loadChatDraft(vault, authorId).catch(() => "").then((saved) => {
      if (cancelled) return;
      draftOwnerRef.current = authorId;
      setDraft((typed) => typed || saved);
    });
    return () => {
      cancelled = true;
      // Leaving this chat: save what was typed in the last moments before the debounce fired.
      const pending = draftPendingRef.current;
      draftPendingRef.current = null;
      if (pending) void writeDraft(pending.owner, pending.body);
    };
  }, [vault, authorId, writeDraft]);
  useEffect(() => {
    const owner = draftOwnerRef.current;
    if (!owner || owner !== authorId) return;
    draftPendingRef.current = { owner, body: draft };
    const timer = setTimeout(() => {
      const pending = draftPendingRef.current;
      draftPendingRef.current = null;
      if (pending) void writeDraft(pending.owner, pending.body);
    }, 300);
    return () => clearTimeout(timer);
  }, [authorId, draft, writeDraft]);

  // Guards the thread paint against route changes that happen DURING an awaited reload:
  // this screen stays mounted across /chat/:authorId param changes, so an in-flight load
  // for chat A must never overwrite chat B's visible thread.
  const authorIdRef = useRef(authorId);
  authorIdRef.current = authorId;
  const threadReload = useMemo(() => createThreadReload({
    markRead: async (id) => { if (vault) await markThreadRead(vault, id, new Date()); },
    loadThread: async (id) => (vault ? listChatThread(vault, id) : []),
    applyThread: setMessages,
    currentAuthorId: () => authorIdRef.current,
  }), [vault]);
  const reload = useCallback(async () => {
    const id = authorIdRef.current;
    if (!vault || !id) return;
    await threadReload(id);
  }, [vault, threadReload]);

  // authorId is an explicit dep: reload itself is param-stable (it reads authorIdRef at
  // call time), so without this the effect would not refire on chat A -> chat B navigation
  // and B would keep showing A's cached thread.
  useEffect(() => {
    void reload();
  }, [reload, authorId]);

  const foregroundBusy = useRef(false);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const connectionId = connection?.id ?? null;
  const connectionFeedUrl = connection?.feedUrl ?? null;
  const connectionVerified = connection?.pubkey != null;
  // Cross-tab announce/listen pair: the tab whose pass applied chat writes posts after
  // committing; tabs that lost the catch-up lock refresh on the announcement instead of
  // racing an immediate reload that lands before the winner's writes. Created and closed
  // inside one effect so StrictMode's mount cycle leaves a live channel behind.
  const appliedChannelRef = useRef<AppliedChannel | null>(null);
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel("eic-chat-applied");
    appliedChannelRef.current = channel;
    return () => { appliedChannelRef.current = null; channel.close(); };
  }, []);
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  // "Relay confirmation is pending" is true only while a sent message is still queued. Once every message is
  // accepted or delivered, keeping it would contradict the status shown on each message.
  useEffect(() => {
    if (!messages || !relayNotice?.startsWith("Relay confirmation is pending")) return;
    if (messages.every((m) => m.direction !== "out" || outboundStatus(m) !== "queued")) setRelayNotice(null);
  }, [messages, relayNotice]);
  // The app-wide background pass may save a message or receipt before this chat's own poll runs, which then
  // reads "unchanged". Repaint on its announcement so the open thread never lags the vault.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onApplied = () => { void reloadRef.current().catch(() => undefined); };
    window.addEventListener(RELAY_APPLIED_EVENT, onApplied);
    return () => window.removeEventListener(RELAY_APPLIED_EVENT, onApplied);
  }, []);
  // Set on any lock loss; cleared only by a reload that pulled the winner's writes.
  const contentionRef = useRef<ContentionFlag>({ dirty: false });
  useEffect(() => {
    const channel = appliedChannelRef.current;
    if (!channel || !connectionId) return;
    return listenForApplied(channel, connectionId, () => {
      // Clear only after the refresh actually completes; a failed reload keeps the flag
      // so a later unchanged outcome retries instead of going durably stale.
      void reloadRef.current()
        .then(() => { contentionRef.current.dirty = false; })
        .catch(() => undefined);
    });
  }, [connectionId]);
  useEffect(() => {
    if (!vault || !connectionVerified || !connectionId || !connectionFeedUrl || !relayEndpoint) return;
    // Effect-lifetime flag: this component stays mounted across /chat/:authorId param
    // changes, so an in-flight pass for chat A must not run A's captured reload after
    // the user opened chat B. Cleanup flips this before the next effect's pass starts.
    let effectAlive = true;
    const active = () => effectAlive && document.visibilityState === "visible" && navigator.onLine
      && useSessionStore.getState().vault === vault;
    const stop = startForegroundRelay({
      active,
      subscribe: wake => {
        document.addEventListener("visibilitychange", wake);
        window.addEventListener("online", wake);
        window.addEventListener("focus", wake);
        return () => {
          document.removeEventListener("visibilitychange", wake);
          window.removeEventListener("online", wake);
          window.removeEventListener("focus", wake);
        };
      },
      run: async () => {
        if (busyRef.current || foregroundBusy.current) return;
        foregroundBusy.current = true;
        try {
          // Cross-tab singleflight: two tabs on this chat must not both apply the same
          // incoming batch. Inbound record ids derive from the envelope signature, so even
          // a lost race collapses to one record - the lock just keeps it from happening.
          const pass = async () => {
            const result = await runForegroundCatchUp({
              vault,
              connectionId,
              expectedFeedUrl: connectionFeedUrl,
              fetcher: signedRelayFetcher(vault, relayEndpoint),
              network: detectSyncNetwork(),
              newId: newItemId,
              now: new Date(),
            });
            if (result === null) return;
            await applyCatchUpOutcome(result, {
              active,
              reload,
              onApplied: () => appliedChannelRef.current?.postMessage({ connectionId }),
              // Skipped chunks: backoff alone would silently hide this. Keep polling
              // (a changed manifest restarts the fetch retry budget) and surface recovery.
              onSkipped: () => setRelayNotice(AUTO_NOTICE_SKIPPED),
              // Honest pause, not a silent skip (Safari/Firefox report the network as unknown).
              onDeferred: () => setRelayNotice(detectSyncNetwork() === "wifi" ? AUTO_NOTICE_WAITING_WIFI : AUTO_NOTICE_WAITING_UNKNOWN),
              onReceived: (count) => setRelayNotice(`Received ${count} new encrypted messages automatically.`),
              // Successful poll with nothing new: clear an earlier auto-owned waiting/skipped
              // notice only; never wipe manual Send/Check guidance sharing this slot.
              onUnchanged: () => setRelayNotice((prev) => (prev !== null && AUTO_NOTICES.includes(prev) ? null : prev)),
              contention: contentionRef.current,
            });
          };
          await withCatchUpLock(navigator.locks ?? null, `eic-chat-catch-up:${connectionId}:${connectionFeedUrl}`, {
            pass,
            onLockLost: () => handleLockLost(
              appliedChannelRef.current,
              navigator.locks ?? null,
              `eic-chat-catch-up:${connectionId}:${connectionFeedUrl}`,
              active,
              reload,
              contentionRef.current,
            ),
          });
        } finally { foregroundBusy.current = false; }
      },
    });
    return () => { effectAlive = false; stop(); };
  }, [vault, connectionId, connectionFeedUrl, connectionVerified, relayEndpoint, reload]);

  if (!connection) {
    return (
      <Window title="Unknown connection">
        <div className="flex flex-col gap-2 text-[12px]">
          <p>That connection is not in this vault.</p>
          <p>
            <Link to="/connections" className="underline">
              Back to Connections
            </Link>
          </p>
        </div>
      </Window>
    );
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    if (!vault || !connection) return;
    setBusy(true);
    setError(null);
    try {
      await sendChatMessage(vault, connection, draft, { newId: newItemId, now: () => new Date() });
    } catch (caught) {
      // Send transaction failed: the draft is untouched, so "still in the box" stays true.
      // AppError messages are user-written; anything else is logged for diagnosis.
      if (!(caught instanceof AppError)) console.error("chat send failed", caught);
      setError(describeSendError(caught));
      setBusy(false);
      return;
    }
    // The message is persisted from here on: a refresh failure must not suggest resending.
    // Drop the saved draft now, not after the debounce, so a quick reload cannot bring back text that was sent.
    draftPendingRef.current = null;
    await writeDraft(connection.id, "");
    setDraft("");
    try {
      setMessages(await listChatThread(vault, connection.id));
    } catch (caught) {
      console.error("chat refresh after send failed", caught);
      setError("Sent and stored on this device. The thread could not refresh - reload to see it.");
    } finally {
      setBusy(false);
    }
    // v2: the local write above is the source of truth; relaying it is a best-effort follow-up
    // whose failure is shown in the relay notice and never undoes or hides the stored message.
    if (relayEndpoint) await relay("publish");
  }

  async function relay(action: "publish" | "receive") {
    if (!vault || !connection) return;
    if (action === "receive" && foregroundBusy.current) {
      setRelayNotice("Checking for replies already. Your local messages are kept.");
      return;
    }
    setRelayNotice(null);
    if (!relayEndpoint) {
      setRelayNotice(MISSING_RELAY_NOTICE);
      return;
    }
    setBusy(true);
    try {
      const settings = await loadSettings(vault);
      const policy = networkPolicy(detectSyncNetwork(), settings.syncOnCellular);
      if (!policy.allowed) throw new AppError("Waiting for Wi-Fi. This device reports mobile data; turn on cellular sync in Settings to allow this request.");
      if (action === "publish") {
        // Idempotent; covers vaults connected before feeds were prepared automatically.
        if (!settings.feedUrl) await configureRelayFeed(vault, relayEndpoint);
        const result = await publishRelaySnapshot(vault, createRelayTransport(relayEndpoint), () => new Date(), { maxBytes: policy.budgetBytes });
        await reload();
        setRelayNotice(result.status === "confirmed" ? "Encrypted snapshot committed to relay. This is not a recipient receipt. Sending another message commits a new snapshot." : result.status === "deferred" ? "Your saved messages are too large to send while this browser cannot tell its connection type. Nothing was lost; they send on Wi-Fi, or allow mobile data in Settings." : "Relay confirmation is pending. Exact sealed snapshot is saved; open Relay options and use Retry relay send; do not retype the message.");
      } else {
        const result = await syncConnection(vault, connection, { fetch: signedRelayFetcher(vault, relayEndpoint), network: detectSyncNetwork(), retryFailed: true, newId: newItemId, now: new Date() });
        setRelayNotice(`Received ${result.appliedChat} new encrypted messages. ${result.status}.`);
        await reload();
      }
    } catch (caught) { setRelayNotice(caught instanceof AppError ? caught.message : "The encrypted relay is unavailable. Local messages and manual handoff are kept."); }
    finally { setBusy(false); }
  }

  async function shareLink(before: string | null) {
    if (!vault || !connection) return;
    setBusy(true);
    setLinkNotice(null);
    try {
      const { link, messageCount, leftOut, oldestCarriedId } = await buildChatShareLink(
        vault,
        connection,
        `${window.location.origin}/`,
        before ? { before } : {},
      );
      // One URL, at the end of the text: that is what phones need to render the cute preview.
      const text = `eic 💌 ${link}`;
      // Honest contents: what this link carries, what this link leaves out. "Not included"
      // describes this link only - an earlier link may already have carried a message. Never
      // claim the friend received or opened anything.
      setOlderCursor(oldestCarriedId);
      setOlderLeftOut(leftOut);
      const batch = before ? `the next ${messageCount} older message${messageCount === 1 ? "" : "s"}` : `your latest ${messageCount} message${messageCount === 1 ? "" : "s"}`;
      const carries = `The link carries ${batch}`;
      const left = leftOut > 0 ? `; ${leftOut} older one${leftOut === 1 ? "" : "s"} not included in this link, which therefore cannot deliver them - "Text the older ones" carries them in another link` : "";
      if (typeof navigator.share === "function") {
        try {
          await navigator.share({ text });
          setLinkNotice(`Shared through your phone's share sheet. One tap on the link opens right into this chat. ${carries}${left}.`);
          return;
        } catch (shareError) {
          // A cancelled share sheet shares nothing - say so. Other errors fall to clipboard.
          if (shareError instanceof DOMException && shareError.name === "AbortError") {
            setLinkNotice("Share cancelled - nothing was sent or copied.");
            return;
          }
        }
      }
      await navigator.clipboard.writeText(text);
      setLinkNotice(`Copied - paste it into a text yourself. One tap on the link opens right into this chat. ${carries}${left}.`);
    } catch (caught) {
      setLinkNotice(caught instanceof AppError ? caught.message : "The chat link could not be built.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <ChatThreadView
      handle={connection.handle}
      authorId={connection.id}
      verified={connection.pubkey !== null}
      messages={messages}
      draft={draft}
      busy={busy}
      error={error}
      linkNotice={linkNotice}
      onDraft={setDraft}
      onSend={send}
      onShareLink={() => void shareLink(null)}
      olderLeftOut={olderLeftOut}
      onOlderLink={olderCursor ? () => void shareLink(olderCursor) : undefined}
      relay={{ notice: relayDisplayNotice(relayEndpoint, relayNotice), onRetry: () => void relay("publish"), onCheck: () => void relay("receive") }}
    />
  );
}

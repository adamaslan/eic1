import { Avatar } from "~/components/avatar";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router";
import { AppError, timeAgo } from "@veil/core";
import {
  CHAT_BODY_MAX,
  configureRelayFeed, createRelayTransport, signedRelayFetcher,
  prepareRelayOutbox, attemptRelayOutbox, syncConnection, loadSettings,
  buildChatShareLink,
  listChatThread,
  markThreadRead,
  describeSendError,
  sendChatMessage,
  type ChatMessage,
} from "@veil/features";
import type { Route } from "./+types/chat";
import { Button95 } from "~/ui95/Button95";
import { Window } from "~/ui95/Window";
import { useSessionStore } from "~/platform/session";
import { useSocial } from "~/platform/use-social";
import { detectSyncNetwork } from "~/platform/sync-fetcher";
import { newItemId } from "~/platform/vault-service";

export function meta(_args: Route.MetaArgs) {
  return [{ title: "Chat — Everybody is Cool" }];
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
  relayControls,
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
  relayControls?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3">
      <Window title={`Chat with @${handle}`}>
        {authorId && <div className="flex items-center gap-2"><Avatar authorId={authorId} label={`${handle}'s avatar`} />@{handle}</div>}
        <div className="flex flex-col gap-2 text-[12px]">
          <p className="bg-[#ffffe1] px-1.5 py-1">
            Messages are sealed for @{handle} and live in your vault - chat is offline-first, and everything you see
            renders from local data. {relayControls ? "Use the explicit relay buttons below for online exchange, or hand messages over yourself." : "Automatic delivery is not connected yet, so hand messages over yourself."} Text a
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
          {!verified && (
            <p role="alert" className="bg-[#ffffe1] px-1.5 py-1">
              This connection came from an unsigned share file, so chat is read-only. To chat, ask @{handle} for a new
              signed share file and import it from the Connections screen. Your thread, nickname, and settings are kept
              when you re-import.
            </p>
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
                  <span className="text-[var(--w95-muted)]">{timeAgo(message.sentAt, new Date())} ago</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Window>

      {relayControls}
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

  const reload = useCallback(async () => {
    if (!vault || !authorId) return;
    await markThreadRead(vault, authorId, new Date());
    setMessages(await listChatThread(vault, authorId));
  }, [vault, authorId]);

  useEffect(() => {
    void reload();
  }, [reload]);

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
    setDraft("");
    try {
      setMessages(await listChatThread(vault, connection.id));
    } catch (caught) {
      console.error("chat refresh after send failed", caught);
      setError("Sent and stored on this device. The thread could not refresh - reload to see it.");
    } finally {
      setBusy(false);
    }
  }

  async function relay(action: "configure" | "publish" | "receive") {
    if (!vault || !connection || !relayEndpoint) return;
    setBusy(true); setRelayNotice(null);
    try {
      if (action === "configure") {
        const configured = await configureRelayFeed(vault, relayEndpoint);
        setRelayNotice(`Relay feed saved. Signing public key: ${configured.publicKey}. The relay owner must allow this key before online exchange. Re-share your signed connection file so friends get your relay feed URL.`);
      } else {
        const settings = await loadSettings(vault);
        if (detectSyncNetwork() !== "wifi" && !settings.syncOnCellular) throw new AppError("Waiting for Wi-Fi. This browser may not know its connection type; turn on cellular sync in Settings to allow this request.");
        if (action === "publish") {
          await prepareRelayOutbox(vault, new Date());
          const result = await attemptRelayOutbox(vault, createRelayTransport(relayEndpoint), new Date());
          setRelayNotice(result.status === "confirmed" ? "Encrypted snapshot committed to relay. This is not a recipient receipt. Use Send to relay again after adding more local messages." : "Relay confirmation is pending. Exact sealed snapshot is saved; retry without resending the local message.");
        } else {
          const result = await syncConnection(vault, connection, { fetch: signedRelayFetcher(vault, relayEndpoint), network: detectSyncNetwork(), retryFailed: true, newId: newItemId, now: new Date() });
          setRelayNotice(`Received ${result.appliedChat} new encrypted messages. ${result.status}.`);
          await reload();
        }
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
      relayControls={relayEndpoint ? <Window title="Encrypted online relay (explicit actions)"><div className="flex flex-col gap-2 text-[12px]"><p>Messages stay in your vault. Relay stores encrypted snapshots only. No background polling or read receipts. Both signing keys must be allowed by the relay owner.</p><div className="flex flex-wrap gap-2"><Button95 disabled={busy || !connection.pubkey} onClick={() => void relay("configure")}>Set up relay feed</Button95><Button95 disabled={busy || !connection.pubkey} onClick={() => void relay("publish")}>Send to relay / retry</Button95><Button95 disabled={busy || !connection.pubkey} onClick={() => void relay("receive")}>Check for messages</Button95></div>{relayNotice && <p role="status" className="break-words">{relayNotice}</p>}</div></Window> : undefined}
    />
  );
}

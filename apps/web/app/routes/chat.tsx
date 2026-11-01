import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router";
import { AppError, timeAgo } from "@veil/core";
import {
  CHAT_BODY_MAX,
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
import { newItemId } from "~/platform/vault-service";

export function meta(_args: Route.MetaArgs) {
  return [{ title: "Chat — Everybody is Cool" }];
}

const inputClass = "w-full bg-white px-1.5 py-1 text-[12px] text-[#0a0a0a] outline-none";

// Pure presentational half, exported for render tests. The route component below owns vault access.
export function ChatThreadView({
  handle,
  verified,
  messages,
  draft,
  busy,
  error,
  linkNotice,
  onDraft,
  onSend,
  onShareLink,
}: {
  handle: string;
  verified: boolean;
  messages: ChatMessage[] | null;
  draft: string;
  busy: boolean;
  error: string | null;
  linkNotice: string | null;
  onDraft: (value: string) => void;
  onSend: (event: FormEvent) => void;
  onShareLink: () => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <Window title={`Chat with @${handle}`}>
        <div className="flex flex-col gap-2 text-[12px]">
          <p className="bg-[#ffffe1] px-1.5 py-1">
            Messages are sealed for @{handle} and live in your vault - chat is offline-first, and everything you see
            renders from local data. Automatic delivery is not connected yet, so hand messages over yourself: Text a
            chat link copies a link that carries your latest sealed messages inside the URL. Text it like any link -
            one tap and eic opens right into this conversation. Nothing to download, no server in the middle.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button95 onClick={onShareLink} disabled={busy || !verified}>Text a chat link</Button95>
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
                  <span className="font-bold">{message.direction === "out" ? "You" : `@${handle}`}</span>
                  <span className="whitespace-pre-wrap break-words">{message.body}</span>
                  <span className="text-[#404040]">{timeAgo(message.sentAt, new Date())} ago</span>
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
            <span className="text-[#404040]">
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
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
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

  async function shareLink() {
    if (!vault || !connection) return;
    setBusy(true);
    setLinkNotice(null);
    try {
      const { link, messageCount, leftOut } = await buildChatShareLink(vault, connection, `${window.location.origin}/`);
      // One URL, at the end of the text: that is what phones need to render the cute preview.
      const text = `eic 💌 ${link}`;
      // Honest contents: what the link carries, what it leaves out. Never imply the friend
      // received or opened anything - a link is hand delivery, not a transport with receipts.
      const carries = `The link carries your latest ${messageCount} message${messageCount === 1 ? "" : "s"}`;
      const left = leftOut > 0 ? `; ${leftOut} older one${leftOut === 1 ? "" : "s"} not included - they still travel by feed sync` : "";
      if (typeof navigator.share === "function") {
        try {
          await navigator.share({ text });
          setLinkNotice(`Shared - one tap opens right into this chat. ${carries}${left}.`);
          return;
        } catch (shareError) {
          // A cancelled share sheet is not an error; anything else falls through to clipboard.
          if (shareError instanceof DOMException && shareError.name === "AbortError") return;
        }
      }
      await navigator.clipboard.writeText(text);
      setLinkNotice(`Copied a chat link - paste it into a text. One tap opens right into this chat. ${carries}${left}.`);
    } catch (caught) {
      setLinkNotice(caught instanceof AppError ? caught.message : "The chat link could not be built.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <ChatThreadView
      handle={connection.handle}
      verified={connection.pubkey !== null}
      messages={messages}
      draft={draft}
      busy={busy}
      error={error}
      linkNotice={linkNotice}
      onDraft={setDraft}
      onSend={send}
      onShareLink={() => void shareLink()}
    />
  );
}

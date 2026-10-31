import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { ChatMessage } from "@veil/features";
import type { Connection } from "@veil/core";
import { ChatThreadView } from "./chat";
import { ConnectionsList } from "./connections";

const render = (element: React.ReactNode) => renderToStaticMarkup(<MemoryRouter>{element}</MemoryRouter>);

const message = (over: Partial<ChatMessage>): ChatMessage => ({
  v: 1,
  id: "m1",
  threadAuthorId: "author-friend",
  direction: "in",
  body: "hello",
  sentAt: "2026-10-30T20:00:00.000Z",
  readAt: null,
  envelope: null,
  envelopeSignature: null,
  ...over,
});

const connection = (over: Partial<Connection>): Connection => ({
  id: "author-friend",
  handle: "friend",
  addedAt: "2026-10-29T20:00:00.000Z",
  nickname: null,
  hidden: false,
  lastImportAt: null,
  pubkey: "pk",
  feedUrl: null,
  syncSeq: 0,
  syncEtag: null,
  syncPending: false,
  syncStatus: "",
  syncDetail: "",
  schemaVersion: 1,
  ...over,
});

const noop = () => {};
const sendNoop = (event: { preventDefault: () => void }) => event.preventDefault();

describe("ChatThreadView", () => {
  it("renders the thread in order with per-direction speakers", () => {
    const html = render(
      <ChatThreadView
        handle="friend"
        verified
        messages={[
          message({ id: "m1", direction: "in", body: "first from friend", sentAt: "2026-10-30T20:00:00.000Z" }),
          message({ id: "m2", direction: "out", body: "second from me", sentAt: "2026-10-30T20:01:00.000Z" }),
          message({ id: "m3", direction: "in", body: "third from friend", sentAt: "2026-10-30T20:02:00.000Z" }),
        ]}
        draft=""
        busy={false}
        error={null}
        onDraft={noop}
        onSend={sendNoop}
      />,
    );
    expect(html.indexOf("first from friend")).toBeLessThan(html.indexOf("second from me"));
    expect(html.indexOf("second from me")).toBeLessThan(html.indexOf("third from friend"));
    expect(html).toContain("Chat with @friend");
    expect(html).toContain("You");
  });

  it("states the pull-model honesty note and renders an empty thread", () => {
    const html = render(
      <ChatThreadView handle="friend" verified messages={[]} draft="" busy={false} error={null} onDraft={noop} onSend={sendNoop} />,
    );
    expect(html).toContain("pulls your");
    expect(html).toContain("No messages yet");
  });

  it("is read-only with a clear notice for an unsigned connection", () => {
    const html = render(
      <ChatThreadView handle="friend" verified={false} messages={[]} draft="" busy={false} error={null} onDraft={noop} onSend={sendNoop} />,
    );
    expect(html).toContain("unsigned share file");
    expect(html).toContain("Chat needs a verified connection");
    const send = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g)?.find((button) => button.includes(">Send<"));
    expect(send).toContain('disabled=""');
  });

  it("shows the send error", () => {
    const html = render(
      <ChatThreadView handle="friend" verified messages={[]} draft="hi" busy={false} error="That did not send." onDraft={noop} onSend={sendNoop} />,
    );
    expect(html).toContain("That did not send.");
  });
});

describe("ConnectionsList chat entry points", () => {
  it("links each connection to its chat route and shows unread badges", () => {
    const html = render(
      <ConnectionsList
        connections={[connection({}), connection({ id: "author-pal", handle: "pal" })]}
        unread={{ "author-friend": 2 }}
        now={new Date("2026-10-31T00:00:00.000Z")}
      />,
    );
    expect(html).toContain('href="/chat/author-friend"');
    expect(html).toContain('href="/chat/author-pal"');
    expect(html).toContain("2 new");
    expect(html).toContain('aria-label="2 unread messages"');
    // No badge for the connection with zero unread.
    expect(html.match(/\d+ new/g)).toHaveLength(1);
  });

  it("keeps the empty state", () => {
    expect(render(<ConnectionsList connections={[]} unread={{}} now={new Date()} />)).toContain("No connections yet");
  });

  it("shows the durable last-sync failure and detail for a degraded connection", () => {
    const html = render(
      <ConnectionsList
        connections={[
          connection({ id: "author-friend", handle: "friend", syncStatus: "failed", syncDetail: "feed unreachable" }),
          connection({ id: "author-pal", handle: "pal", syncStatus: "applied" }),
        ]}
        unread={{}}
        now={new Date("2026-10-31T00:00:00.000Z")}
      />,
    );
    expect(html).toContain("sync failed: feed unreachable");
    // A clean connection shows no sync warning.
    expect(html.match(/sync /g)).toHaveLength(1);
  });
});

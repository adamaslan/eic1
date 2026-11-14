import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { ChatMessage } from "@veil/features";
import type { Connection } from "@veil/core";
import { ChatThreadView, MISSING_RELAY_NOTICE, relayDisplayNotice } from "./chat";
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
  syncRetry: 0,
  syncExhausted: false,
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
        linkNotice={null}
        onDraft={noop}
        onSend={sendNoop}
        onShareLink={noop}
      />,
    );
    expect(html.indexOf("first from friend")).toBeLessThan(html.indexOf("second from me"));
    expect(html.indexOf("second from me")).toBeLessThan(html.indexOf("third from friend"));
    expect(html).toContain("Chat with @friend");
    expect(html).toContain("You");
  });

  it("states the honest local-only delivery note and invites a first message when verified", () => {
    const html = render(
      <ChatThreadView handle="friend" verified messages={[]} draft="" busy={false} error={null} linkNotice={null} onDraft={noop} onSend={sendNoop} onShareLink={noop} />,
    );
    expect(html).toContain("Automatic delivery is not connected yet");
    expect(html).not.toContain("pulls your");
    expect(html).toContain("Say hi");
  });

  it("is read-only with a clear notice for an unsigned connection", () => {
    const html = render(
      <ChatThreadView handle="friend" verified={false} messages={[]} draft="" busy={false} error={null} linkNotice={null} onDraft={noop} onSend={sendNoop} onShareLink={noop} />,
    );
    expect(html).toContain("unsigned share file");
    expect(html).toContain("import it from the Connections screen");
    expect(html).toContain("Chat needs a verified connection");
    expect(html).not.toContain("Say hi");
    const send = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g)?.find((button) => button.includes(">Send<"));
    expect(send).toContain('disabled=""');
  });


  it("offers a textable chat link and shows the copy notice", () => {
    const html = render(
      <ChatThreadView handle="friend" verified messages={[]} draft="" busy={false} error={null} linkNotice="Copied 2 messages as a link - paste it into a text." onDraft={noop} onSend={sendNoop} onShareLink={noop} />,
    );
    expect(html).toContain("Text a chat link");
    expect(html).toContain("Copied 2 messages as a link");
  });

  it("offers the older batch when a link left messages out", () => {
    const html = render(
      <ChatThreadView handle="friend" verified messages={[]} draft="" busy={false} error={null} linkNotice={null} olderLeftOut={3} onDraft={noop} onSend={sendNoop} onShareLink={noop} onOlderLink={noop} />,
    );
    expect(html).toContain("Text the 3 older ones");
  });

  it("keeps the chat-link button off for an unsigned connection", () => {
    const html = render(
      <ChatThreadView handle="friend" verified={false} messages={[]} draft="" busy={false} error={null} linkNotice={null} onDraft={noop} onSend={sendNoop} onShareLink={noop} />,
    );
    const button = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g)?.find((b) => b.includes("Text a chat link"));
    expect(button).toContain('disabled=""');
  });

  it("shows the send error", () => {
    const html = render(
      <ChatThreadView handle="friend" verified messages={[]} draft="hi" busy={false} error="That did not send." linkNotice={null} onDraft={noop} onSend={sendNoop} onShareLink={noop} />,
    );
    expect(html).toContain("That did not send.");
  });
});

describe("ChatThreadView v2 relay mode", () => {
  const relay = { notice: null, onSetup: noop, onRetry: noop, onCheck: noop };
  const view = (over: Partial<React.ComponentProps<typeof ChatThreadView>> = {}) =>
    render(
      <ChatThreadView handle="friend" verified messages={[]} draft="hi" busy={false} error={null} linkNotice={null} onDraft={noop} onSend={sendNoop} onShareLink={noop} relay={relay} {...over} />,
    );

  it("removes every v1 handoff control and its explanation", () => {
    const html = view({ olderLeftOut: 3, onOlderLink: noop });
    expect(html).not.toContain("Text a chat link");
    expect(html).not.toContain("older ones");
    expect(html).not.toContain("hand messages over yourself");
  });

  it("puts Send, Check, Retry and Set up in the message box", () => {
    const html = view();
    for (const label of ["Send", "Check for messages", "Retry relay send", "Set up relay feed"]) {
      expect(html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g)?.some((b) => b.includes(`>${label}<`)), label).toBe(true);
    }
    expect(html).not.toContain("Send to relay");
  });

  it("keeps the main screen simple: only Send sits outside the collapsed Relay options", () => {
    const html = view();
    const [outside, inside] = html.split("<details");
    expect(inside).toContain("Relay options");
    const actions = ["Send", "Check for messages", "Retry relay send", "Set up relay feed"];
    const present = (markup: string) => actions.filter((label) => markup.includes(`>${label}<`));
    expect(present(outside)).toEqual(["Send"]);
    expect(present(inside)).toEqual(["Check for messages", "Retry relay send", "Set up relay feed"]);
    expect(html).not.toContain("<details open");
  });

  it("disables the relay actions for an unsigned connection and while busy", () => {
    for (const html of [view({ verified: false }), view({ busy: true })]) {
      for (const label of ["Check for messages", "Retry relay send", "Set up relay feed"]) {
        const button = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g)?.find((b) => b.includes(`>${label}<`));
        expect(button, label).toContain('disabled=""');
      }
    }
  });

  it("shows the relay notice and keeps v1 UI only when relay is absent", () => {
    expect(view({ relay: { ...relay, notice: "Relay confirmation is pending." } })).toContain("Relay confirmation is pending.");
    const v1 = render(
      <ChatThreadView handle="friend" verified messages={[]} draft="" busy={false} error={null} linkNotice={null} onDraft={noop} onSend={sendNoop} onShareLink={noop} />,
    );
    expect(v1).toContain("Text a chat link");
    expect(v1).not.toContain("Check for messages");
  });
});

describe("missing relay endpoint", () => {
  it("shows the delivery warning immediately without a relay action", () => {
    expect(relayDisplayNotice(undefined, null)).toBe(MISSING_RELAY_NOTICE);
    expect(relayDisplayNotice("", null)).toBe(MISSING_RELAY_NOTICE);
    const html = render(<ChatThreadView handle="friend" verified messages={[]} draft="" busy={false} error={null} linkNotice={null} onDraft={noop} onSend={sendNoop} onShareLink={noop} relay={{ notice: relayDisplayNotice(undefined, null), onSetup: noop, onRetry: noop, onCheck: noop }} />);
    expect(html).toContain("cannot reach your friend");
    expect(html).toContain("When a relay endpoint is configured");
  });
  it("preserves configured endpoint success and retry notices", () => {
    expect(relayDisplayNotice("https://example.test", null)).toBeNull();
    expect(relayDisplayNotice("https://example.test", "Pending retry")).toBe("Pending retry");
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
    // Every connection also links to its profile route.
    expect(html).toContain('href="/profile/author-friend"');
    expect(html).toContain('href="/profile/author-pal"');
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

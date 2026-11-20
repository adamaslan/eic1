import { describe, expect, it } from "vitest";
import { SubtleCryptoPort } from "@veil/crypto";
import { createVault, type UnlockedVault } from "@veil/vault";
import { MemoryStore } from "../../vault/src/memory-store";
import { buildShareBundle, importShareBundle } from "./sharing";
import { defaultSettings, listConnections, saveSettings, type Settings } from "./social";
import {
  applyInboundChatEnvelope,
  listChatThread,
  listOutboundChatEnvelopes,
  outboundStatus,
  sendChatMessage,
  type ChatDeps,
} from "./chat";

const NOW = new Date("2026-11-20T12:00:00Z");
const open = () => createVault({ store: new MemoryStore(), crypto: new SubtleCryptoPort(), now: () => NOW }, "pass phrase 1");
const settingsFor = (authorId: string, handle: string): Settings => ({ ...defaultSettings(), authorId, handle });
let counter = 0;
const deps: ChatDeps = { newId: () => `r${counter++}`, now: () => NOW };

async function pairedVaults(): Promise<{ alice: UnlockedVault; bob: UnlockedVault }> {
  const alice = await open();
  const bob = await open();
  await saveSettings(alice, settingsFor("alice-id", "alice"));
  await saveSettings(bob, settingsFor("bob-id", "bob"));
  await importShareBundle(bob, (await buildShareBundle(alice, settingsFor("alice-id", "alice"), [], NOW)).text, { settings: settingsFor("bob-id", "bob"), newId: deps.newId, now: NOW });
  await importShareBundle(alice, (await buildShareBundle(bob, settingsFor("bob-id", "bob"), [], NOW)).text, { settings: settingsFor("alice-id", "alice"), newId: deps.newId, now: NOW });
  return { alice, bob };
}

const envelopesFor = (map: Map<string, unknown[]>, id: string) => map.get(id) ?? [];

describe("delivery receipts", () => {
  it("a new message is queued until the recipient's receipt arrives", async () => {
    const { alice, bob } = await pairedVaults();
    const aliceConn = (await listConnections(bob)).find((c) => c.id === "alice-id")!;
    const sent = await sendChatMessage(bob, aliceConn, "hi alice", deps);
    expect(outboundStatus(sent, null)).toBe("queued");
    // The sender's feed carries the message envelope, not the body.
    expect(envelopesFor(await listOutboundChatEnvelopes(bob), "alice-id")).toHaveLength(1);
    await applyInboundChatEnvelope(alice, sent.envelope, deps);
    // Alice's feed now carries a receipt addressed to bob.
    const aliceFeed = envelopesFor(await listOutboundChatEnvelopes(alice), "bob-id");
    expect(aliceFeed).toHaveLength(1);
    const receiptResult = await applyInboundChatEnvelope(bob, aliceFeed[0], deps);
    expect(receiptResult).toEqual({ applied: false, message: null });
    const [stored] = await listChatThread(bob, "alice-id");
    expect(stored.deliveredAt).toBe(NOW.toISOString());
    expect(outboundStatus(stored, null)).toBe("delivered");
  });

  it("a delivered message is pruned from the sender's next feed", async () => {
    const { alice, bob } = await pairedVaults();
    const aliceConn = (await listConnections(bob)).find((c) => c.id === "alice-id")!;
    const sent = await sendChatMessage(bob, aliceConn, "prune me", deps);
    await applyInboundChatEnvelope(alice, sent.envelope, deps);
    await applyInboundChatEnvelope(bob, envelopesFor(await listOutboundChatEnvelopes(alice), "bob-id")[0], deps);
    expect(envelopesFor(await listOutboundChatEnvelopes(bob), "alice-id")).toHaveLength(0);
  });

  it("re-applying the same receipt is idempotent", async () => {
    const { alice, bob } = await pairedVaults();
    const aliceConn = (await listConnections(bob)).find((c) => c.id === "alice-id")!;
    const sent = await sendChatMessage(bob, aliceConn, "twice", deps);
    await applyInboundChatEnvelope(alice, sent.envelope, deps);
    const receipt = envelopesFor(await listOutboundChatEnvelopes(alice), "bob-id")[0];
    await applyInboundChatEnvelope(bob, receipt, deps);
    await expect(applyInboundChatEnvelope(bob, receipt, deps)).resolves.toEqual({ applied: false, message: null });
    expect(await listChatThread(bob, "alice-id")).toHaveLength(1);
  });

  it("a receipt only marks messages the recipient actually saved", async () => {
    const { alice, bob } = await pairedVaults();
    const aliceConn = (await listConnections(bob)).find((c) => c.id === "alice-id")!;
    const saved = await sendChatMessage(bob, aliceConn, "saved", deps);
    const unsaved = await sendChatMessage(bob, aliceConn, "not yet received", deps);
    await applyInboundChatEnvelope(alice, saved.envelope, deps);
    await applyInboundChatEnvelope(bob, envelopesFor(await listOutboundChatEnvelopes(alice), "bob-id")[0], deps);
    const thread = await listChatThread(bob, "alice-id");
    expect(thread.find((m) => m.id === saved.id)?.deliveredAt).toBeTruthy();
    expect(thread.find((m) => m.id === unsaved.id)?.deliveredAt).toBeFalsy();
  });

  it("accepted is set by the confirmed relay cutoff, and never means delivered", async () => {
    const { bob } = await pairedVaults();
    const aliceConn = (await listConnections(bob)).find((c) => c.id === "alice-id")!;
    const early = await sendChatMessage(bob, aliceConn, "in snapshot", { newId: deps.newId, now: () => new Date("2026-11-20T12:00:00Z") });
    const late = await sendChatMessage(bob, aliceConn, "after snapshot", { newId: deps.newId, now: () => new Date("2026-11-20T12:05:00Z") });
    const cutoff = early.sentAt;
    expect(outboundStatus(early, cutoff)).toBe("accepted");
    expect(outboundStatus(late, cutoff)).toBe("queued");
    expect(outboundStatus(early, cutoff)).not.toBe("delivered");
  });

  it("rejects a status request for an inbound message", async () => {
    const { alice, bob } = await pairedVaults();
    const aliceConn = (await listConnections(bob)).find((c) => c.id === "alice-id")!;
    const sent = await sendChatMessage(bob, aliceConn, "x", deps);
    const inbound = (await applyInboundChatEnvelope(alice, sent.envelope, deps)).message!;
    expect(() => outboundStatus(inbound, null)).toThrow("Only sent messages");
  });
});

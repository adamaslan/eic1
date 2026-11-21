import { describe, expect, it, vi } from "vitest";
import { DirectoryController, publicCard, searchCards, type DirectoryAdapter, type DirectoryCard } from "./discover-controller";

const card = { id: "person-1", name: "River", handle: "river", bio: "Film photos and long walks" };
function fixture(ownCard: DirectoryCard | null = null) {
  const adapter: DirectoryAdapter = { read: vi.fn(async () => ({ cards: [card], ownCard, incoming: [], blocked: [] })), publish: vi.fn(async (draft) => ({ id: "self", ...draft })), hide: vi.fn(async () => {}), request: vi.fn(async () => {}), accept: vi.fn(async () => {}), decline: vi.fn(async () => {}), block: vi.fn(async (person) => [person]), unblock: vi.fn(async () => []) };
  return { adapter, model: new DirectoryController(adapter) };
}
describe("Discover local state, not a hosted directory", () => {
  it("starts unknown, then confirms hidden without publishing or touching messaging", async () => {
    const { model, adapter } = fixture(); expect(model.state.visibility).toBe("unknown"); await model.load();
    expect(model.state.visibility).toBe("hidden"); expect(adapter.publish).not.toHaveBeenCalled(); expect(adapter.request).not.toHaveBeenCalled();
  });
  it("projects only chosen public fields and searches name, handle or interest", async () => {
    expect(publicCard({ ...card, privateNotes: "secret", email: "private" } as DirectoryCard)).toEqual(card);
    expect(searchCards([card], "  FILM ")).toEqual([card]); expect(searchCards([card], "missing")).toEqual([]);
  });
  it("publishes only a validated explicit card, never arbitrary adapter fields", async () => {
    const { model, adapter } = fixture(); await model.load(); await model.publish({ name: " Me ", handle: "@me", bio: "chosen" });
    expect(adapter.publish).toHaveBeenCalledWith({ name: "Me", handle: "me", bio: "chosen" }); expect(model.state.visibility).toBe("listed");
  });
  it("rejects invalid or missing choices before any write", async () => {
    const { model, adapter } = fixture(); await model.load(); await model.publish({ name: "", handle: "bad handle", bio: "" });
    expect(adapter.publish).not.toHaveBeenCalled(); expect(model.state.visibility).toBe("hidden"); expect(model.state.error).toBeTruthy();
  });
  it("hides only through its directory adapter and leaves pending requests intact", async () => {
    const { model, adapter } = fixture({ ...card, id: "self" }); await model.load(); await model.request(card.id); await model.hide();
    expect(adapter.hide).toHaveBeenCalledTimes(1); expect(model.state.visibility).toBe("hidden"); expect(model.state.ownCard).toBeNull(); expect(model.state.requested).toEqual([card.id]);
  });
  it("a request to a card that left Discover says so and removes it, instead of offering a pointless retry", async () => {
    const { model, adapter } = fixture(); await model.load();
    (adapter.request as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("That card is no longer listed."));
    await model.request(card.id);
    expect(model.state.error).toBe("That person is no longer in Discover.");
    expect(model.state.cards).toEqual([]); expect(model.state.requested).toEqual([]);
  });
  it("any other request failure stays a retryable error and keeps the card", async () => {
    const { model, adapter } = fixture(); await model.load();
    (adapter.request as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("boom"));
    await model.request(card.id);
    expect(model.state.error).toBe("Couldn't send the request. Try again."); expect(model.state.cards).toEqual([card]);
  });
  it("does not claim hidden after a failed hide and allows retry", async () => {
    const { model, adapter } = fixture({ ...card, id: "self" }); vi.mocked(adapter.hide).mockRejectedValueOnce(new Error("offline"));
    await model.load(); await model.hide(); expect(model.state.visibility).toBe("unknown"); expect(model.state.error).toContain("may still be visible"); await model.hide(); expect(model.state.visibility).toBe("hidden");
  });
  it("treats an ambiguous publish failure as unknown and offers hide without requiring a known card", async () => {
    const { model, adapter } = fixture(); vi.mocked(adapter.publish).mockRejectedValueOnce(new Error("response lost"));
    await model.load(); await model.publish(card); expect(model.state.visibility).toBe("unknown"); await model.hide(); expect(adapter.hide).toHaveBeenCalledOnce(); expect(model.state.visibility).toBe("hidden");
  });
  it("deduplicates successful add requests and rejects arbitrary or unloaded targets", async () => {
    const { model, adapter } = fixture(); await model.request(card.id); await model.load(); await model.request("unlisted"); await model.request(card.id); await model.request(card.id);
    expect(adapter.request).toHaveBeenCalledTimes(1); expect(model.state.requested).toEqual([card.id]); expect(model.state.notice).toContain("does not open a chat");
  });
  it("does not label a failed request as sent", async () => {
    const { model, adapter } = fixture(); vi.mocked(adapter.request).mockRejectedValueOnce(new Error("offline")); await model.load(); await model.request(card.id);
    expect(model.state.requested).toEqual([]); expect(model.state.error).toContain("Couldn't send");
  });
  it("blocks concurrent visibility mutations until the server outcome is known", async () => {
    const { model, adapter } = fixture(); let resolve!: (value: DirectoryCard) => void;
    vi.mocked(adapter.publish).mockImplementation(() => new Promise((r) => { resolve = r; })); await model.load(); const pending = model.publish(card); await model.hide(); expect(adapter.hide).not.toHaveBeenCalled(); resolve({ ...card, id: "self" }); await pending; expect(model.state.visibility).toBe("listed");
  });
  it("block removes the card and its request, and a failed save keeps both and says so", async () => {
    const { model, adapter } = fixture(); vi.mocked(adapter.read).mockResolvedValueOnce({ cards: [card], ownCard: null, incoming: [card.id], blocked: [] });
    await model.load();
    vi.mocked(adapter.block).mockRejectedValueOnce(new Error("disk")); await model.block(card.id);
    expect(model.state.cards).toEqual([card]); expect(model.state.incoming).toEqual([card.id]); expect(model.state.error).toBe("Couldn't block. Try again.");
    await model.block(card.id);
    expect(adapter.block).toHaveBeenLastCalledWith({ id: card.id, name: "River", handle: "river" });
    expect(model.state.cards).toEqual([]); expect(model.state.incoming).toEqual([]); expect(model.state.blocked.map((p) => p.id)).toEqual([card.id]);
    expect(adapter.decline).not.toHaveBeenCalled();
  });
  it("unblock clears the entry and reloads", async () => {
    const { model, adapter } = fixture(); vi.mocked(adapter.read).mockResolvedValueOnce({ cards: [], ownCard: null, incoming: [], blocked: [{ id: card.id, name: "River", handle: "river" }] });
    await model.load(); expect(model.state.blocked).toHaveLength(1);
    await model.unblock(card.id); await vi.waitFor(() => expect(model.state.cards).toEqual([card]));
    expect(model.state.blocked).toEqual([]);
  });
});

export type DirectoryCard = { id: string; name: string; handle: string; bio: string };
export type PublicCardDraft = Omit<DirectoryCard, "id">;
export interface DirectoryAdapter {
  read(): Promise<{ cards: DirectoryCard[]; ownCard: DirectoryCard | null }>;
  publish(draft: PublicCardDraft): Promise<DirectoryCard>;
  hide(): Promise<void>;
  // Idempotent per signed identity + target: retrying after a lost response must not duplicate requests.
  request(id: string): Promise<void>;
}
export type DirectoryState = {
  visibility: "hidden" | "listed" | "unknown"; ready: boolean; busy: boolean; cards: DirectoryCard[]; ownCard: DirectoryCard | null;
  requested: string[]; error: string; notice: string;
};

// Explicit projection: a directory adapter cannot accidentally expose extra vault fields.
export function publicCard(card: DirectoryCard): DirectoryCard {
  if (!card.id || typeof card.id !== "string") throw new Error("Invalid directory card.");
  return { id: card.id, ...validateDraft(card) };
}
export function validateDraft(draft: PublicCardDraft): PublicCardDraft {
  if (typeof draft.name !== "string" || typeof draft.handle !== "string" || typeof draft.bio !== "string") throw new Error("Invalid directory card.");
  const name = draft.name.trim(); const handle = draft.handle.trim().replace(/^@/, ""); const bio = draft.bio.trim();
  if (!name || name.length > 40 || !/^[a-zA-Z0-9_.-]{1,30}$/.test(handle) || bio.length > 160) throw new Error("Enter a name, a handle using letters, numbers, dots, dashes or underscores, and a bio up to 160 characters.");
  return { name, handle, bio };
}
export function searchCards(cards: DirectoryCard[], query: string): DirectoryCard[] {
  const q = query.trim().toLocaleLowerCase();
  return cards.filter((card) => `${card.name} ${card.handle} ${card.bio}`.toLocaleLowerCase().includes(q));
}

// No vault, contacts, feeds or messaging API is reachable from this controller.
// A real authenticated directory adapter is deliberately not wired in this prototype.
export class DirectoryController {
  state: DirectoryState = { visibility: "unknown", ready: false, busy: false, cards: [], ownCard: null, requested: [], error: "", notice: "" };
  private listeners = new Set<() => void>();
  constructor(private readonly adapter: DirectoryAdapter) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.state;
  private update(patch: Partial<DirectoryState>) { this.state = { ...this.state, ...patch }; this.listeners.forEach((fn) => fn()); }
  async load() {
    if (this.state.busy) return;
    this.update({ busy: true, error: "" });
    try {
      const data = await this.adapter.read(); const ownCard = data.ownCard ? publicCard(data.ownCard) : null;
      const cards = data.cards.map(publicCard).filter((card) => card.id !== ownCard?.id);
      this.update({ ready: true, ownCard, cards, visibility: ownCard ? "listed" : "hidden" });
    } catch { this.update({ error: "Couldn't load Discover. Try again.", ready: false }); }
    finally { this.update({ busy: false }); }
  }
  async publish(draft: PublicCardDraft) {
    if (!this.state.ready || this.state.busy) return;
    let chosen: PublicCardDraft;
    try { chosen = validateDraft(draft); } catch (error) { this.update({ error: (error as Error).message }); return; }
    this.update({ busy: true, error: "", notice: "" });
    try { const card = publicCard(await this.adapter.publish(chosen)); this.update({ ownCard: card, visibility: "listed", notice: "Your chosen card is visible in this directory." }); }
    catch { this.update({ visibility: "unknown", error: "Couldn't list your card. Your visibility has not been confirmed. Try again." }); }
    finally { this.update({ busy: false }); }
  }
  async hide() {
    if (!this.state.ready || this.state.busy || this.state.visibility === "hidden") return;
    this.update({ busy: true, error: "", notice: "" });
    try { await this.adapter.hide(); this.update({ ownCard: null, visibility: "hidden", notice: "Hidden from Discover. Your existing friends and chats are unchanged." }); }
    catch { this.update({ visibility: "unknown", error: "Couldn't hide your card. It may still be visible. Try again." }); }
    finally { this.update({ busy: false }); }
  }
  async request(id: string) {
    if (!this.state.ready || this.state.busy || this.state.requested.includes(id) || !this.state.cards.some((card) => card.id === id)) return;
    this.update({ busy: true, error: "", notice: "" });
    try { await this.adapter.request(id); this.update({ requested: [...this.state.requested, id], notice: "Request sent. This does not open a chat or allow messages." }); }
    catch { this.update({ error: "Couldn't send the request. Try again." }); }
    finally { this.update({ busy: false }); }
  }
}

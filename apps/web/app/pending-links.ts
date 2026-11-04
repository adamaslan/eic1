import { CHAT_LINK_PREFIX, CONNECT_LINK_PREFIX, POST_LINK_PREFIX, RELAY_LINK_PREFIX, isJournalShareBundle, readPostShareLink } from "@veil/features";

/**
 * Pending-link slots: where a tapped eic link waits while the app locks, unlocks, or routes.
 *
 * Semantics that make the vault-binding claim true:
 * - A slot stashed while a vault is unlocked is keyed to that vault's authorId immediately.
 * - A slot stashed before any vault is active (fresh page load, locked screen) is UNBOUND
 *   (forAuthorId null). It binds to the first vault that reads it after unlock - the person
 *   holding the device who just tapped the link.
 * - A slot keyed to one vault is dropped, never applied, when a different vault reads it.
 * - Locking drops every slot: no stale prompt survives into someone else's session.
 */

export type PendingKind = "post" | "chat" | "connect";
export type StashedLink = { hash: string; forAuthorId: string | null; stashedAt: number };

export interface SlotStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export const sessionSlotStore = (): SlotStore => ({
  get: (key) => {
    try {
      return window.sessionStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set: (key, value) => {
    try {
      window.sessionStorage.setItem(key, value);
    } catch {
      // Private mode: the live hash still works while it survives.
    }
  },
  remove: (key) => {
    try {
      window.sessionStorage.removeItem(key);
    } catch {
      // Best effort.
    }
  },
});

export const LEGACY_PENDING_LINK_KEY = "eic.pendingLinkHash";

/**
 * Where the shell's parse-time inline script parks a tapped link's raw hash. Dumb capture
 * only - typed slot routing happens in entry.client.tsx. A plain sessionStorage key, read
 * and removed exactly once per load.
 */
export const PENDING_KINDS: PendingKind[] = ["connect", "chat", "post"];
export const pendingKey = (kind: PendingKind) => `eic.pendingLink.v2.${kind}`;

export const kindOfHash = (hash: string): PendingKind | null =>
  hash.startsWith(CHAT_LINK_PREFIX)
    ? "chat"
    : hash.startsWith(CONNECT_LINK_PREFIX)
      ? "connect"
      : // Relay links carry only a share id; the app fetches the bundle, so they park in
        // the post slot and resolve in root.tsx before the import prompt.
        hash.startsWith(POST_LINK_PREFIX) || hash.startsWith(RELAY_LINK_PREFIX)
        ? "post"
        : null;

export function readStash(store: SlotStore, kind: PendingKind): StashedLink | null {
  const raw = store.get(pendingKey(kind));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StashedLink>;
    if (typeof parsed.hash !== "string" || kindOfHash(parsed.hash) !== kind) return null;
    return {
      hash: parsed.hash,
      forAuthorId: typeof parsed.forAuthorId === "string" ? parsed.forAuthorId : null,
      stashedAt: typeof parsed.stashedAt === "number" ? parsed.stashedAt : 0,
    };
  } catch {
    return null;
  }
}

export function writeStash(store: SlotStore, kind: PendingKind, entry: StashedLink): void {
  store.set(pendingKey(kind), JSON.stringify(entry));
}

export function dropStash(store: SlotStore, kind: PendingKind): void {
  store.remove(pendingKey(kind));
  // Consumed or dismissed: the memory retention for a link of this kind goes with the slot,
  // so a saved or declined link cannot resurface on a later read in this document.
  if (memoryArrival && kindOfHash(memoryArrival) === kind) memoryArrival = null;
}

export function dropAllStashes(store: SlotStore): void {
  for (const kind of PENDING_KINDS) dropStash(store, kind);
  store.remove(LEGACY_PENDING_LINK_KEY);
  memoryArrival = null; // locking drops every pending link, retained copies included
}

/**
 * Resolves a slot for the vault that is reading it now.
 * - Unbound slot: binds to this vault (first unlock after the tap) and is returned.
 * - Slot keyed to this vault: returned.
 * - Slot keyed to a different vault: dropped and skipped - a stashed link must never leak
 *   into another vault's session on a shared device.
 */
export function resolveStashForVault(store: SlotStore, kind: PendingKind, authorId: string | null): StashedLink | null {
  const entry = readStash(store, kind);
  if (!entry) return null;
  if (entry.forAuthorId === null) {
    if (authorId) {
      const bound: StashedLink = { ...entry, forAuthorId: authorId };
      writeStash(store, kind, bound);
      return bound;
    }
    // A vault with no authorId yet cannot key anything; downstream crypto and structural
    // checks still gate what the link can do.
    return entry;
  }
  if (authorId && entry.forAuthorId !== authorId) {
    dropStash(store, kind);
    return null;
  }
  return entry;
}

/**
 * Binds every unbound slot to the vault that just became active. Runs when a vault
 * finishes unlocking/resuming AFTER a link was stashed (the primary fresh-load tap path:
 * the tap stashes while the vault is still rehydrating, then the vault arrives).
 * Keyed slots are untouched - cross-vault drops only happen on read.
 */
/**
 * In-memory retention for a tapped link. sessionStorage can be denied (private mode), and a
 * denied store loses the link the moment client-side navigation drops the URL hash - the
 * original fast-tapper race, still live for that tapper. Module state survives every
 * in-document navigation (landing -> unlock -> vault creation), so the arrival hash is kept
 * here until the link is consumed, dismissed, or locked away. A reload wipes it, same as the
 * vault itself: only sessionStorage carries a link across loads.
 */
let memoryArrival: string | null = null;

/** The parse-time inline script parks the raw hash here when (and before) storage answers. */
const WINDOW_ARRIVAL_KEY = "__eicArrivalHash";

export function readMemoryArrival(): string | null {
  return memoryArrival;
}

export function clearMemoryArrival(): void {
  memoryArrival = null;
}

function readWindowArrival(): string | null {
  const holder = globalThis as Record<string, unknown>;
  const value = holder[WINDOW_ARRIVAL_KEY];
  delete holder[WINDOW_ARRIVAL_KEY]; // one read: the module copy owns it from here
  return typeof value === "string" && value.length > 1 ? value : null;
}

/**
 * Promotes the shell's parse-time capture (the window global set by the inline script) into a
 * typed, unbound slot, and retains it in memory until consumed. Journal payloads stay in memory
 * only because their text is plaintext inside the link; other link kinds may use sessionStorage.
 * entry.client.tsx runs this before hydration, so before anything on the page is tappable.
 * The raw key is always removed after the read: one promotion per load, no stale leftovers.
 * Unrelated hashes (route fragments, anchors) are dropped, never stashed. When storage is
 * denied the capture reads back null, the window global and then the LIVE hash are the
 * fallbacks, and the memory copy is the only retention - enough for the whole in-document
 * unlock path, never a cross-load promise. Vault binding is untouched: the slot is unbound,
 * exactly like the pre-vault stash the mount effect writes.
 */
export function promoteArrivalHash(store: SlotStore, liveHash: string): boolean {
  const hash = readWindowArrival() ?? liveHash;
  const kind = kindOfHash(hash);
  if (!kind) return false;
  memoryArrival = hash;
  let journalLink = false;
  if (kind === "post") {
    try {
      const post = readPostShareLink(hash);
      journalLink = post !== null && isJournalShareBundle(post);
    } catch {
      // A damaged post link is still handled by the normal import error path.
    }
  }
  if (!journalLink) {
    writeStash(store, kind, { hash, forAuthorId: null, stashedAt: Date.now() });
  }
  return journalLink;
}

export function bindStashesToVault(store: SlotStore, authorId: string): void {
  for (const kind of PENDING_KINDS) {
    const entry = readStash(store, kind);
    if (entry && entry.forAuthorId === null) {
      writeStash(store, kind, { ...entry, forAuthorId: authorId });
    }
  }
}

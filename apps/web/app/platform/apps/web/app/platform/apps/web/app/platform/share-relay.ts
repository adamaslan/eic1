/**
 * Client for the share relay (/api/share, served by netlify/functions). Publishing a
 * post uploads exactly the single-post bundle the Share tap already builds - the sender's
 * tap is the consent, and the response carries the delete key that revokes the share.
 * The delete key lives in the vault (never on the server), so only this device can revoke.
 */
import { AppError } from "@veil/core";
import type { UnlockedVault } from "@veil/vault";

// Same origin in production; e2e points the dev server at the local relay stand-in.
const RELAY_BASE: string = (import.meta.env.VITE_EIC_RELAY_BASE as string | undefined) ?? "";

/**
 * Hard feature gate, off by default: the relay flow ships inert until the owner sets
 * VITE_EIC_SHARE_RELAY=on (app) and EIC_SHARE_RELAY=on (functions) for production. With
 * the flag off, Share keeps the original share-file behavior and no link is published.
 */
export const RELAY_ENABLED = import.meta.env.VITE_EIC_SHARE_RELAY === "on";

const SAVE_INTENT_KEY = "eic.relaySaveIntent";

/** The reader tapped "Save to my vault" - the next #relay= resolution imports. */
export const markRelaySaveIntent = (id: string): void => {
  try {
    window.sessionStorage.setItem(SAVE_INTENT_KEY, id);
  } catch {
    // best effort
  }
};

/** True (once) when this relay id carries a save intent from the shared-post view. */
export const takeRelaySaveIntent = (id: string): boolean => {
  try {
    const marked = window.sessionStorage.getItem(SAVE_INTENT_KEY) === id;
    if (marked) window.sessionStorage.removeItem(SAVE_INTENT_KEY);
    return marked;
  } catch {
    return false;
  }
};

export interface PublishedShare {
  id: string;
  url: string;
  deleteKey: string;
}

const relayError = async (response: Response, fallback: string): Promise<AppError> => {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error.length > 0) return new AppError(body.error);
  } catch {
    // fall through to the fallback
  }
  return new AppError(fallback);
};

export async function publishSharedPost(bundleText: string): Promise<PublishedShare> {
  let response: Response;
  try {
    response = await fetch(`${RELAY_BASE}/api/share`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: bundleText,
    });
  } catch {
    throw new AppError("The share service could not be reached. Check your connection and try again.");
  }
  if (!response.ok) {
    throw await relayError(response, "The share service refused that post.");
  }
  const data = (await response.json()) as { id?: unknown; deleteKey?: unknown };
  if (typeof data.id !== "string" || typeof data.deleteKey !== "string") {
    throw new AppError("The share service answered in an unexpected way.");
  }
  const base = RELAY_BASE || window.location.origin;
  return { id: data.id, url: `${base}/s/${data.id}`, deleteKey: data.deleteKey };
}

export async function fetchSharedBundle(id: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(`${RELAY_BASE}/api/share/${id}`);
  } catch {
    throw new AppError("The share service could not be reached. Check your connection and try again.");
  }
  if (response.status === 404) {
    throw new AppError("That shared post is no longer available - it may have been revoked or expired.");
  }
  if (!response.ok) {
    throw await relayError(response, "That shared post could not be loaded.");
  }
  return response.text();
}

export async function revokeSharedPost(id: string, deleteKey: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${RELAY_BASE}/api/share/${id}`, {
      method: "DELETE",
      headers: { "x-delete-key": deleteKey },
    });
  } catch {
    throw new AppError("The share service could not be reached. Check your connection and try again.");
  }
  // A 404 means the share is already gone - the goal state, so treat it as revoked.
  if (!response.ok && response.status !== 404) {
    throw await relayError(response, "The shared link could not be revoked.");
  }
}

export interface SharedLinkRef {
  id: string;
  url: string;
  deleteKey: string;
  postId: string;
  createdAt: string;
}

const SHARED_LINKS_RECORD_ID = "eic.sharedLinks.v1";

const isStringRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const asSharedLinkRef = (value: unknown): SharedLinkRef | null => {
  if (!isStringRecord(value)) return null;
  const { id, url, deleteKey, postId, createdAt } = value;
  if ([id, url, deleteKey, postId, createdAt].some((field) => typeof field !== "string")) return null;
  return { id, url, deleteKey, postId, createdAt } as SharedLinkRef;
};

const readSharedLinks = async (vault: UnlockedVault): Promise<Record<string, SharedLinkRef>> => {
  const raw = await vault.getJson(SHARED_LINKS_RECORD_ID);
  if (!isStringRecord(raw) || !isStringRecord(raw.links)) return {};
  const links: Record<string, SharedLinkRef> = {};
  for (const [postId, entry] of Object.entries(raw.links)) {
    const ref = asSharedLinkRef(entry);
    if (ref) links[postId] = ref;
  }
  return links;
};

export async function loadSharedLink(vault: UnlockedVault, postId: string): Promise<SharedLinkRef | null> {
  return (await readSharedLinks(vault))[postId] ?? null;
}

export async function saveSharedLink(vault: UnlockedVault, ref: SharedLinkRef): Promise<void> {
  const links = await readSharedLinks(vault);
  links[ref.postId] = ref;
  await vault.putJson("identity", SHARED_LINKS_RECORD_ID, { links });
}

export async function dropSharedLink(vault: UnlockedVault, postId: string): Promise<void> {
  const links = await readSharedLinks(vault);
  delete links[postId];
  await vault.putJson("identity", SHARED_LINKS_RECORD_ID, { links });
}

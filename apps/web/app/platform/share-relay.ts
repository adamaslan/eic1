/**
 * Client for the share relay (/api/share, served by netlify/functions). Publishing a
 * post uploads exactly the single-post bundle the Share tap already builds - the sender's
 * tap is the consent, and the response carries the delete key that revokes the share.
 * The delete key lives in the vault (never on the server), so only this device can revoke.
 */
import { AppError, encodeBase64 } from "@veil/core";
import { signPayload } from "@veil/crypto";
import { loadOrCreateShareIdentity } from "@veil/features";
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

/**
 * Fresh-owner-intent proof for a publish: this device's share key signs
 * "eic-share-publish:v1\n<sha256hex(bundle)>\n<timestamp>". The relay requires it so a
 * captured share file can never be (re)published by anyone but the author.
 */
const buildPublishProof = async (vault: UnlockedVault, bundleText: string): Promise<{ signature: string; at: string }> => {
  const identity = await loadOrCreateShareIdentity(vault);
  const at = new Date().toISOString();
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bundleText))))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const signature = await signPayload(identity.secretKey, new TextEncoder().encode(`eic-share-publish:v1
${digest}
${at}`));
  return { signature: encodeBase64(signature), at };
};

const relayError = async (response: Response, fallback: string): Promise<AppError> => {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error.length > 0) return new AppError(body.error);
  } catch {
    // fall through to the fallback
  }
  return new AppError(fallback);
};

export async function publishSharedPost(vault: UnlockedVault, bundleText: string): Promise<PublishedShare> {
  const proof = await buildPublishProof(vault, bundleText);
  let response: Response;
  try {
    response = await fetch(`${RELAY_BASE}/api/share`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-share-proof": proof.signature, "x-share-proof-at": proof.at },
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
  const base = RELAY_BASE || (globalThis.location?.origin ?? "");
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

/**
 * Every link this device published, per post, with its delete key. Append-only on
 * publish and pruned only when a revoke is confirmed: a delete key is NEVER discarded
 * while its link may still be live, so no published link becomes unrevocable here.
 * (Legacy records stored a single ref per post; reads upgrade them in place.)
 */
const readSharedLinks = async (vault: UnlockedVault): Promise<Record<string, SharedLinkRef[]>> => {
  const raw = await vault.getJson(SHARED_LINKS_RECORD_ID);
  if (!isStringRecord(raw) || !isStringRecord(raw.links)) return {};
  const links: Record<string, SharedLinkRef[]> = {};
  for (const [postId, entry] of Object.entries(raw.links)) {
    const candidates = Array.isArray(entry) ? entry : [entry];
    const refs = candidates.map(asSharedLinkRef).filter((ref): ref is SharedLinkRef => ref !== null);
    if (refs.length > 0) links[postId] = refs;
  }
  return links;
};

/** All links this device published for the post, oldest first. */
export async function loadSharedLinks(vault: UnlockedVault, postId: string): Promise<SharedLinkRef[]> {
  return (await readSharedLinks(vault))[postId] ?? [];
}

/** The post's most recent live link - the one shown and copied. */
export async function loadSharedLink(vault: UnlockedVault, postId: string): Promise<SharedLinkRef | null> {
  const refs = await loadSharedLinks(vault, postId);
  return refs.at(-1) ?? null;
}

export async function saveSharedLink(vault: UnlockedVault, ref: SharedLinkRef): Promise<void> {
  const links = await readSharedLinks(vault);
  links[ref.postId] = [...(links[ref.postId] ?? []).filter((existing) => existing.id !== ref.id), ref];
  await vault.putJson("identity", SHARED_LINKS_RECORD_ID, { links });
}

/** Drops one link ref by id, or every ref for the post when id is omitted. */
export async function dropSharedLink(vault: UnlockedVault, postId: string, id?: string): Promise<void> {
  const links = await readSharedLinks(vault);
  const remaining = id === undefined ? [] : (links[postId] ?? []).filter((ref) => ref.id !== id);
  if (remaining.length === 0) delete links[postId];
  else links[postId] = remaining;
  await vault.putJson("identity", SHARED_LINKS_RECORD_ID, { links });
}

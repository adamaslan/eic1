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

export interface ShareProvision {
  /** Client-generated id (16 base64url chars), persisted before any publish attempt. */
  id: string;
  /** Client-generated delete key (32 base64url chars); the server stores only its sha256. */
  deleteKey: string;
}

const base64Url = (bytes: Uint8Array): string =>
  encodeBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

/** Fresh provision for a new share intent. */
export const generateShareProvision = (): ShareProvision => ({
  id: base64Url(globalThis.crypto.getRandomValues(new Uint8Array(12))),
  deleteKey: base64Url(globalThis.crypto.getRandomValues(new Uint8Array(24))),
});

const sha256Hex = async (text: string): Promise<string> => {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

export interface PublishedShare {
  id: string;
  url: string;
  deleteKey: string;
  /** True when this exact intent had already committed - a safe idempotent retry. */
  existed: boolean;
}

/**
 * Fresh-owner-intent proof for a publish: this device's share key signs
 * "eic-share-publish:v1\n<sha256hex(bundle)>\n<timestamp>\n<id>\n<sha256hex(deleteKey)>".
 * The relay requires it so a captured share file can never be (re)published by anyone
 * but the author, and a captured request with a substituted id or delete key fails
 * verification instead of being accepted.
 */
const buildPublishProof = async (vault: UnlockedVault, bundleText: string, provision: ShareProvision): Promise<{ signature: string; at: string; id: string }> => {
  const identity = await loadOrCreateShareIdentity(vault);
  const at = new Date().toISOString();
  const digest = await sha256Hex(bundleText);
  const keyDigest = await sha256Hex(provision.deleteKey);
  const signature = await signPayload(identity.secretKey, new TextEncoder().encode(`eic-share-publish:v1
${digest}
${at}
${provision.id}
${keyDigest}`));
  return { signature: encodeBase64(signature), at, id: provision.id };
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

export async function publishSharedPost(vault: UnlockedVault, bundleText: string, provision: ShareProvision): Promise<PublishedShare> {
  const proof = await buildPublishProof(vault, bundleText, provision);
  let response: Response;
  try {
    response = await fetch(`${RELAY_BASE}/api/share`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-share-id": provision.id,
        "x-delete-key": provision.deleteKey,
        "x-share-proof": proof.signature,
        "x-share-proof-at": proof.at,
        "x-share-proof-id": proof.id,
      },
      body: bundleText,
    });
  } catch {
    throw new AppError("The share service could not be reached. Check your connection and try again.");
  }
  if (!response.ok) {
    throw await relayError(response, "The share service refused that post.");
  }
  const data = (await response.json()) as { id?: unknown; deleteKey?: unknown; existed?: unknown };
  if (typeof data.id !== "string" || typeof data.deleteKey !== "string" || data.id !== provision.id) {
    throw new AppError("The share service answered in an unexpected way.");
  }
  const base = RELAY_BASE || (globalThis.location?.origin ?? "");
  return { id: data.id, url: `${base}/s/${data.id}`, deleteKey: data.deleteKey, existed: data.existed === true };
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
  /** Persisted before the publish attempt; cleared once the relay confirms the commit. */
  pending?: boolean;
}

const SHARED_LINK_RECORD_PREFIX = "eic.sharedLink.";
const LEGACY_SHARED_LINKS_RECORD_ID = "eic.sharedLinks.v1";

const recordIdFor = (shareId: string): string => `${SHARED_LINK_RECORD_PREFIX}${shareId}`;

const isStringRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const asSharedLinkRef = (value: unknown): SharedLinkRef | null => {
  if (!isStringRecord(value)) return null;
  const { id, url, deleteKey, postId, createdAt, pending } = value;
  if ([id, url, deleteKey, postId, createdAt].some((field) => typeof field !== "string")) return null;
  return { id, url, deleteKey, postId, createdAt, ...(pending === true ? { pending: true } : {}) } as SharedLinkRef;
};

/**
 * Every link this device published lives in its OWN vault record (eic.sharedLink.<id>),
 * so publishing from two tabs never loses a ref to a read-modify-write race. A ref is
 * written BEFORE the publish is attempted (persist-before-publish), so a lost response
 * or a dead tab can never orphan a live link: a retry reuses the same id and key, and
 * Revoke works from the ref. Refs are deleted only after a revoke is confirmed.
 * (The legacy single-map record eic.sharedLinks.v1 is migrated into per-link records on
 * first read; same-id rewrites are idempotent, so two tabs migrating at once is safe.)
 */
const readSharedLinks = async (vault: UnlockedVault): Promise<Record<string, SharedLinkRef[]>> => {
  const legacy = await vault.getJson(LEGACY_SHARED_LINKS_RECORD_ID);
  if (isStringRecord(legacy) && isStringRecord(legacy.links)) {
    for (const entry of Object.values(legacy.links)) {
      for (const candidate of Array.isArray(entry) ? entry : [entry]) {
        const ref = asSharedLinkRef(candidate);
        if (ref) await vault.putJson("identity", recordIdFor(ref.id), { ...ref, pending: false });
      }
    }
    await vault.deleteRecords([LEGACY_SHARED_LINKS_RECORD_ID]);
  }
  const links: Record<string, SharedLinkRef[]> = {};
  for (const value of await vault.listJson("identity")) {
    const ref = asSharedLinkRef(value);
    if (ref) links[ref.postId] = [...(links[ref.postId] ?? []), ref];
  }
  for (const refs of Object.values(links)) {
    refs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  return links;
};

/** All links this device published for the post, oldest first. */
export async function loadSharedLinks(vault: UnlockedVault, postId: string): Promise<SharedLinkRef[]> {
  return (await readSharedLinks(vault))[postId] ?? [];
}

/** The post's most recent link ref, if any. */
export async function loadSharedLink(vault: UnlockedVault, postId: string): Promise<SharedLinkRef | null> {
  const refs = await loadSharedLinks(vault, postId);
  return refs.length > 0 ? refs[refs.length - 1] : null;
}

/**
 * The publish intent for this post: an existing pending ref is reused (its id and key
 * already name the link that may have committed), otherwise a fresh provision is
 * generated and persisted. The ref exists in the vault BEFORE any publish attempt.
 */
export async function retainShareIntent(vault: UnlockedVault, postId: string): Promise<SharedLinkRef> {
  const pending = (await loadSharedLinks(vault, postId)).filter((ref) => ref.pending);
  if (pending.length > 0) return pending[pending.length - 1];
  const provision = generateShareProvision();
  const base = RELAY_BASE || (globalThis.location?.origin ?? "");
  const ref: SharedLinkRef = {
    id: provision.id,
    url: `${base}/s/${provision.id}`,
    deleteKey: provision.deleteKey,
    postId,
    createdAt: new Date().toISOString(),
    pending: true,
  };
  await vault.putJson("identity", recordIdFor(ref.id), ref);
  return ref;
}

/** Marks the intent's ref as confirmed once the relay committed it. */
export async function finalizePublishedShare(vault: UnlockedVault, ref: SharedLinkRef): Promise<void> {
  await vault.putJson("identity", recordIdFor(ref.id), { ...ref, pending: false });
}

/**
 * Publishes a bundle with a persisted intent: the delete key is in the vault BEFORE the
 * request, so the outcome can never orphan a live link. A definitive refusal drops the
 * pending intent (nothing committed); a lost connection keeps it, because the publish
 * may have committed - the retry reuses the same id and the link stays revocable here.
 */
export async function publishSharedPostFlow(vault: UnlockedVault, bundleText: string, postId: string): Promise<{ ref: SharedLinkRef }> {
  const ref = await retainShareIntent(vault, postId);
  let published: PublishedShare;
  try {
    published = await publishSharedPost(vault, bundleText, { id: ref.id, deleteKey: ref.deleteKey });
  } catch (caught) {
    if (caught instanceof AppError && caught.message.startsWith("The share service could not be reached")) {
      throw new AppError(
        "Connection lost mid-publish - the link may already be live. It stays revocable from this page; sharing again reuses the same link.",
      );
    }
    await dropSharedLink(vault, postId, ref.id).catch(() => undefined);
    throw caught;
  }
  await finalizePublishedShare(vault, ref).catch(() => undefined); // the pending ref still revokes
  return { ref: { ...ref, url: published.url, pending: false } };
}

/** Drops one link ref by id, or every ref for the post when id is omitted. */
export async function dropSharedLink(vault: UnlockedVault, postId: string, id?: string): Promise<void> {
  const ids = id === undefined ? (await loadSharedLinks(vault, postId)).map((ref) => ref.id) : [id];
  await vault.deleteRecords(ids.map(recordIdFor));
}

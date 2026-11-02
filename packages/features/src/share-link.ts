import { AppError, decodeBase64, encodeBase64 } from "@veil/core";

export const POST_LINK_PREFIX = "#import=";
/**
 * Cap keeps links usable everywhere (chat apps, SMS, email) and the fragment well within what
 * browsers carry. Posts with photos usually exceed it - those go out as share files instead.
 */
export const MAX_POST_LINK_CHARS = 8000;

export const toBase64Url = (text: string): string =>
  encodeBase64(new TextEncoder().encode(text))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

export const fromBase64Url = (encoded: string): string => {
  const base64 = encoded.replaceAll("-", "+").replaceAll("_", "/");
  // decodeBase64 requires padding; the URL-safe form strips it.
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  return new TextDecoder().decode(decodeBase64(padded));
};

/**
 * Builds a share-one-post link from a single-post share bundle. Everything sits after the '#',
 * so the post never reaches a server: the fragment is not part of any HTTP request.
 */
export function buildPostShareLink(bundleText: string, baseUrl: string): string {
  const link = `${baseUrl}${POST_LINK_PREFIX}${toBase64Url(bundleText)}`;
  if (link.length > MAX_POST_LINK_CHARS) {
    throw new AppError("That post is too big for a link. Send it as a share file instead.");
  }
  return link;
}

/**
 * Builds a chat-key invite link from a key-card bundle. Same fragment channel as post links:
 * the key travels after the '#', so it never reaches a server.
 */
export function buildChatInviteLink(bundleText: string, baseUrl: string): string {
  const link = `${baseUrl}${POST_LINK_PREFIX}${toBase64Url(bundleText)}`;
  if (link.length > MAX_POST_LINK_CHARS) {
    throw new AppError("That chat key is too large for a link. Send it as a share file instead.");
  }
  return link;
}

/**
 * Reads the bundle JSON from a share-one-post fragment. Returns null when the hash is not a
 * share link; throws AppError when it looks like one but does not decode.
 */
export function readPostShareLink(hash: string): string | null {
  if (!hash.startsWith(POST_LINK_PREFIX)) return null;
  try {
    return fromBase64Url(hash.slice(POST_LINK_PREFIX.length));
  } catch {
    throw new AppError("That share link is damaged. Ask your friend for a fresh one.");
  }
}

export const RELAY_LINK_PREFIX = "#relay=";
/**
 * Relay links carry only the share's id: the post itself stays on the share service
 * until the app fetches it, so the link stays short no matter how big the photo is.
 */
export const buildRelayLink = (id: string, baseUrl: string): string =>
  `${baseUrl}${RELAY_LINK_PREFIX}${id}`;

/**
 * Reads the share id from a relay link. Returns null when the hash is not a relay link;
 * throws AppError when it looks like one but the id is malformed.
 */
export function readRelayLinkId(hash: string): string | null {
  if (!hash.startsWith(RELAY_LINK_PREFIX)) return null;
  const id = hash.slice(RELAY_LINK_PREFIX.length);
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) {
    throw new AppError("That share link is damaged. Ask your friend for a fresh one.");
  }
  return id;
}

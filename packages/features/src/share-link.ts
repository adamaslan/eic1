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
  let base64 = encoded.replaceAll("-", "+").replaceAll("_", "/");
  // decodeBase64 is strict about padding; URLs strip it, so put it back.
  while (base64.length % 4 !== 0) base64 += "=";
  return new TextDecoder().decode(decodeBase64(base64));
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

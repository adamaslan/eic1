import { useEffect, useState } from "react";
import { Link } from "react-router";
import { AppError, formatPrice, timeAgo, type Item } from "@veil/core";
import { buildPostShareLink, buildShareBundle, toggleLike, useVaultItems } from "@veil/features";
import type { Route } from "./+types/item";
import { Button95 } from "~/ui95/Button95";
import { Window } from "~/ui95/Window";
import { useMediaUri } from "~/platform/use-media-uri";
import { useSessionStore } from "~/platform/session";
import { sharePostFile } from "~/platform/share";
import {
  RELAY_ENABLED,
  dropSharedLink,
  loadSharedLink,
  publishSharedPost,
  revokeSharedPost,
  saveSharedLink,
  type SharedLinkRef,
} from "~/platform/share-relay";
import { useSocial } from "~/platform/use-social";

export function meta(_args: Route.MetaArgs) {
  return [{ title: "Item — Everybody is Cool" }];
}

export default function ItemDetail({ params }: Route.ComponentProps) {
  const vault = useSessionStore((state) => state.vault);
  const { state, reload } = useVaultItems(vault);
  const social = useSocial(vault);
  const [shareNote, setShareNote] = useState<string | null>(null);
  const [sharedLink, setSharedLink] = useState<SharedLinkRef | null>(null);

  async function shareLink(item: Item, allItems: Item[]) {
    if (!vault) return;
    setShareNote(null);
    try {
      const { text } = await buildShareBundle(vault, social.settings, allItems, new Date(), { onlyPostId: item.id });
      const link = buildPostShareLink(text, `${window.location.origin}/`);
      await navigator.clipboard.writeText(link);
      setShareNote("Link copied. It opens the app and offers to import this post - the post travels in the link itself, no server involved.");
    } catch (caught) {
      setShareNote(caught instanceof AppError ? caught.message : "That could not be shared. Please try again.");
    }
  }

  async function share(item: Item, allItems: Item[]) {
    if (!vault) return;
    setShareNote(null);
    let text: string;
    try {
      text = (await buildShareBundle(vault, social.settings, allItems, new Date(), { onlyPostId: item.id })).text;
    } catch (caught) {
      setShareNote(caught instanceof AppError ? caught.message : "That could not be shared. Please try again.");
      return;
    }
    // Primary path (gated): publish the single-post bundle to the share service, then
    // hand the short link to the share sheet. The link's preview shows this post's photo
    // and text to anyone who has it; the delete key stays in this vault for Revoke.
    if (RELAY_ENABLED) try {
      const published = await publishSharedPost(text);
      const ref: SharedLinkRef = { ...published, postId: item.id, createdAt: new Date().toISOString() };
      await saveSharedLink(vault, ref);
      setSharedLink(ref);
      let handed = false;
      let cancelled = false;
      if (navigator.share) {
        try {
          await navigator.share({ title: item.title, url: published.url });
          handed = true;
        } catch (caught) {
          if (caught instanceof DOMException && caught.name === "AbortError") cancelled = true;
          else throw caught;
        }
      }
      if (handed) {
        setShareNote("Shared. The link shows this post's photo and text to anyone who has it - revoke it here anytime.");
      } else if (cancelled) {
        // The sheet was dismissed AFTER publishing: the link is live. Say so plainly -
        // no silent copy, and Revoke stays available for a link that went nowhere.
        setShareNote("Share cancelled - but the link was already published and still shows this post. Copy it or revoke it here.");
      } else {
        await navigator.clipboard.writeText(published.url);
        setShareNote("Link copied. It shows this post's photo and text to anyone who has it - revoke it here anytime.");
      }
      return;
    } catch (caught) {
      // The share service is down or refused: fall back to the share file, which never
      // touches a server. The note stays honest about which thing happened.
      if (caught instanceof AppError && caught.message.startsWith("The share service")) {
        try {
          const outcome = await sharePostFile(`eic-post-${item.id}.json`, item.title, text);
          if (outcome === "shared") setShareNote("The link service was unreachable, so this went out as the share file instead. Shared.");
          else if (outcome === "copied") setShareNote("The link service was unreachable, so the share file was copied instead. Paste it into a message; your friend can paste it into Connections to import it.");
          else if (outcome === "downloaded") setShareNote("The link service was unreachable, so this was downloaded as a file instead. Send it to your friend to import in Connections.");
        } catch (fallback) {
          setShareNote(fallback instanceof AppError ? fallback.message : "That could not be shared. Please try again.");
        }
        return;
      }
      setShareNote(caught instanceof AppError ? caught.message : "That could not be shared. Please try again.");
    }
    if (!RELAY_ENABLED) {
      try {
        const outcome = await sharePostFile(`eic-post-${item.id}.json`, item.title, text);
        if (outcome === "shared") setShareNote("Shared.");
        else if (outcome === "copied") setShareNote("Copied. Paste it into a message; your friend can paste it into Connections to import it.");
        else if (outcome === "downloaded") setShareNote("Downloaded as a file. Send it to your friend to import in Connections.");
      } catch (caught) {
        setShareNote(caught instanceof AppError ? caught.message : "That could not be shared. Please try again.");
      }
    }
  }

  async function revokeShare(item: Item) {
    if (!vault || !sharedLink) return;
    setShareNote(null);
    try {
      await revokeSharedPost(sharedLink.id, sharedLink.deleteKey);
      await dropSharedLink(vault, item.id);
      setSharedLink(null);
      setShareNote("Shared link revoked - it no longer shows the post.");
    } catch (caught) {
      setShareNote(caught instanceof AppError ? caught.message : "The link could not be revoked. Please try again.");
    }
  }

  const itemId = state.status === "ready" ? (state.items.find((candidate) => candidate.id === params.id)?.id ?? null) : null;
  useEffect(() => {
    if (!vault || !itemId || !RELAY_ENABLED) return;
    let cancelled = false;
    void loadSharedLink(vault, itemId).then((ref) => {
      if (!cancelled) setSharedLink(ref);
    });
    return () => {
      cancelled = true;
    };
  }, [vault, itemId]);

  if (state.status === "loading") return <p className="text-[12px]">Opening…</p>;
  if (state.status === "error") return <p role="alert" className="text-[12px] text-[#800000]">{state.message}</p>;

  const item = state.items.find((candidate) => candidate.id === params.id);
  if (!item) {
    return (
      <Window title="Not found">
        <div className="flex flex-col gap-2 text-[12px]">
          <p>That item is not in this vault.</p>
          <BackLink type={null} />
        </div>
      </Window>
    );
  }

  return (
    <Window title={item.title}>
      <div className="flex flex-col gap-2 text-[12px]">
        {item.mediaIds.map((mediaId) => (
          <ItemImage key={mediaId} mediaId={mediaId} mime={item.mediaMime} title={item.title} />
        ))}
        <p className="text-[#404040]">
          {item.category} · {formatPrice(item.priceCents)} · {timeAgo(item.createdAt, new Date())} · ♥ {item.likes}
          {item.authorHandle ? ` · from @${item.authorHandle}` : ""}
        </p>
        {item.likedBy.length > 0 && <p className="text-[#404040]">Liked by {item.likedBy.length} of your connections.</p>}
        <p className="whitespace-pre-wrap">{item.description || "No description."}</p>
        <div className="flex flex-wrap gap-2">
          <Button95
            pressed={item.likedByMe}
            onClick={async () => {
              if (!vault) return;
              await toggleLike(vault, item);
              reload();
            }}
          >
            {item.likedByMe ? "♥ Liked" : "♡ Like"}
          </Button95>
          {item.authorId === null && (
            <Button95
              onClick={() => share(item, state.items)}
              disabled={!social.settingsReady}
              title="Publishes this one post behind a short link whose preview shows its photo and text, even while it is Private here. Pressing it is the consent; revoke anytime."
            >
              ↗ Share
            </Button95>
          )}
          {item.authorId === null && (
            <Button95
              onClick={() => shareLink(item, state.items)}
              disabled={!social.settingsReady}
              title="Copies a link that opens the app and imports this post. Text posts only; big posts need the Share file."
            >
              ↗ Link
            </Button95>
          )}
          {item.authorId === null && (
            <Button95
              pressed={item.visibility === "shareable"}
              onClick={async () => {
                if (!vault) return;
                await vault.putItem({ ...item, visibility: item.visibility === "shareable" ? "private" : "shareable" });
                reload();
              }}
            >
              {item.visibility === "shareable" ? "Sharing allowed" : "Private"}
            </Button95>
          )}
          {item.authorId === null && RELAY_ENABLED && sharedLink && (
            <>
              <Button95
                onClick={async () => {
                  await navigator.clipboard.writeText(sharedLink.url);
                  setShareNote("Link copied. It shows this post's photo and text to anyone who has it - revoke it here anytime.");
                }}
                title="Copies this post's live shared link again."
              >
                Copy shared link
              </Button95>
              <Button95
                onClick={() => revokeShare(item)}
                title="Deletes this post's shared link. Already-sent links stop working; the post stays in your vault."
              >
                Revoke link
              </Button95>
            </>
          )}
        </div>
        {shareNote && <p role="status" className="text-[11px]">{shareNote}</p>}
        {item.authorId === null && !social.settings.handle && (
          <p className="text-[11px] text-[#404040]">
            To share, <Link to="/connections" className="text-[#0000cc] underline">choose a handle</Link> first.
          </p>
        )}
        {item.authorId === null && item.visibility === "shareable" && (
          <p className="text-[11px] text-[#404040]">This post goes into the share file you export from Connections.</p>
        )}
        <BackLink type={item.type} />
      </div>
    </Window>
  );
}

function BackLink({ type }: { type: "photo" | "listing" | null }) {
  const to = type === "listing" ? "/market" : "/feed";
  return (
    <Link to={to} className="text-[#0000cc] underline">
      {type === "listing" ? "Back to market" : "Back to feed"}
    </Link>
  );
}

function ItemImage({ mediaId, mime, title }: { mediaId: string | null; mime: string; title: string }) {
  const vault = useSessionStore((state) => state.vault);
  const uri = useMediaUri(vault, mediaId, mime);
  if (!uri) return null;
  return <img src={uri} alt={title} className="max-h-[60vh] w-full object-contain" />;
}

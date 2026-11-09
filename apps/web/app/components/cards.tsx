import { Avatar } from "~/components/avatar";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { formatPrice, hueFor, timeAgo, type Item } from "@veil/core";
import { sampleAuthorFor } from "@veil/features";
import { Card95 } from "~/ui95/Card95";
import { useMediaUri } from "~/platform/use-media-uri";
import { useSessionStore } from "~/platform/session";

// A card opens the item page, or calls onOpen when there is no vault to open it from (the sample preview).
function Open({ item, onOpen, children }: { item: Item; onOpen?: (item: Item) => void; children: ReactNode }) {
  if (onOpen) {
    return (
      <button type="button" onClick={() => onOpen(item)} className="block w-full cursor-pointer text-left">
        {children}
      </button>
    );
  }
  return (
    <Link to={`/item/${item.id}`} className="block">
      {children}
    </Link>
  );
}

export function AuthorTag({ item }: { item: Item }) {
  // Sample items (landing examples, demo seed) carry a fictional author with a built-in drawn avatar.
  // No vault lookup: the avatar is a local asset, so this renders signed-out too.
  const sample = sampleAuthorFor(item.id);
  if (sample) {
    return (
      <span className="inline-flex items-center gap-1 text-[var(--w95-muted)]">
        <img
          src={`data:image/png;base64,${sample.avatarData}`}
          alt={`${sample.handle}'s avatar`}
          title={sample.avatarLabel}
          width={28}
          height={28}
          className="inline-block shrink-0 object-contain align-middle"
        />
        @{sample.handle}
      </span>
    );
  }
  if (!item.authorHandle) return null;
  return <span className="inline-flex items-center gap-1 text-[var(--w95-muted)]"><Avatar authorId={item.authorId ?? undefined} label={`${item.authorHandle}'s avatar`} />@{item.authorHandle}</span>;
}

export function PhotoCard({
  item,
  now,
  height = 160,
  onOpen,
}: {
  item: Item;
  now: Date;
  height?: number;
  onOpen?: (item: Item) => void;
}) {
  const vault = useSessionStore((state) => state.vault);
  const thumbUri = useMediaUri(vault, item.thumbId, item.mediaMime);
  const hue = hueFor(item.id);
  const sample = sampleAuthorFor(item.id);
  return (
    <Open item={item} onOpen={onOpen}>
      <Card95>
        {thumbUri ? (
          <img src={thumbUri} alt={item.title} style={{ height }} className="w-full object-cover" />
        ) : sample ? (
          // Sample items have no photo: show the example's drawn sticker big instead of a blank color panel.
          <div style={{ height }} className="flex w-full items-center justify-center bg-white">
            <img
              src={`/stickers/eic-sticker-${sample.avatarId}.png`}
              alt={`Drawn ${sample.avatarLabel} sticker`}
              title={`${sample.avatarLabel} sticker`}
              className="max-h-full max-w-full object-contain"
            />
          </div>
        ) : (
          <div
            style={{ height, background: `linear-gradient(135deg, hsl(${hue} 70% 60%), hsl(${(hue + 40) % 360} 70% 35%))` }}
            className="w-full"
            aria-hidden="true"
          />
        )}
        <div className="flex items-center justify-between gap-2 px-1 py-1">
          <span className="truncate font-bold">{item.title}</span>
          <span className="shrink-0 text-[var(--w95-link)]">
            {timeAgo(item.createdAt, now)} · {item.likedByMe ? "♥" : "♡"} {item.likes}
          </span>
        </div>
        {(item.authorHandle || sample) && (
          <div className="px-1 pb-0.5 text-[11px]">
            <AuthorTag item={item} />
          </div>
        )}
      </Card95>
    </Open>
  );
}

export function ListingRow({ item, now, onOpen }: { item: Item; now: Date; onOpen?: (item: Item) => void }) {
  return (
    <Open item={item} onOpen={onOpen}>
      <Card95>
        <div className="flex items-baseline gap-2 px-1 py-0.5">
          <span className="min-w-0 flex-1 truncate font-bold text-[var(--w95-link)]">{item.title}</span>
          <span className="shrink-0 font-mono">{formatPrice(item.priceCents)}</span>
        </div>
        <div className="flex gap-2 px-1 pb-0.5 text-[11px] text-[var(--w95-muted)]">
          <span>{item.category}</span>
          <span>· {timeAgo(item.createdAt, now)}</span>
          <AuthorTag item={item} />
        </div>
      </Card95>
    </Open>
  );
}

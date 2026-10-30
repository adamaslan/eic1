import type { ReactNode } from "react";
import { Link } from "react-router";
import { formatPrice, hueFor, timeAgo, type Item } from "@veil/core";
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
  if (!item.authorHandle) return null;
  return <span className="text-[#404040]">@{item.authorHandle}</span>;
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
  return (
    <Open item={item} onOpen={onOpen}>
      <Card95>
        {thumbUri ? (
          <img src={thumbUri} alt={item.title} style={{ height }} className="w-full object-cover" />
        ) : (
          <div
            style={{ height, background: `linear-gradient(135deg, hsl(${hue} 70% 60%), hsl(${(hue + 40) % 360} 70% 35%))` }}
            className="w-full"
            aria-hidden="true"
          />
        )}
        <div className="flex items-center justify-between gap-2 px-1 py-1">
          <span className="truncate font-bold">{item.title}</span>
          <span className="shrink-0 text-[#0000cc]">
            {timeAgo(item.createdAt, now)} · {item.likedByMe ? "♥" : "♡"} {item.likes}
          </span>
        </div>
        {item.authorHandle && (
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
          <span className="min-w-0 flex-1 truncate font-bold text-[#0000cc]">{item.title}</span>
          <span className="shrink-0 font-mono">{formatPrice(item.priceCents)}</span>
        </div>
        <div className="flex gap-2 px-1 pb-0.5 text-[11px] text-[#404040]">
          <span>{item.category}</span>
          <span>· {timeAgo(item.createdAt, now)}</span>
          <AuthorTag item={item} />
        </div>
      </Card95>
    </Open>
  );
}

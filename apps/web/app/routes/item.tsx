import { Link } from "react-router";
import { formatPrice, timeAgo } from "@veil/core";
import { toggleLike, useVaultItems } from "@veil/features";
import type { Route } from "./+types/item";
import { Button95 } from "~/ui95/Button95";
import { Window } from "~/ui95/Window";
import { useMediaUri } from "~/platform/use-media-uri";
import { useSessionStore } from "~/platform/session";

export function meta(_args: Route.MetaArgs) {
  return [{ title: "Item — Everybody is Cool" }];
}

export default function ItemDetail({ params }: Route.ComponentProps) {
  const vault = useSessionStore((state) => state.vault);
  const { state, reload } = useVaultItems(vault);

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
        </div>
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

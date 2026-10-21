import { Link } from "react-router";
import { formatPrice, timeAgo } from "@veil/core";
import { useVaultItems } from "@veil/features";
import type { Route } from "./+types/item";
import { Window } from "~/ui95/Window";
import { useSessionStore } from "~/platform/session";

export function meta(_args: Route.MetaArgs) {
  return [{ title: "Item — Veil 95" }];
}

export default function ItemDetail({ params }: Route.ComponentProps) {
  const vault = useSessionStore((state) => state.vault);
  const { state } = useVaultItems(vault);

  if (state.status === "loading") return <p className="text-[12px]">Opening…</p>;
  if (state.status === "error") return <p role="alert" className="text-[12px] text-[#800000]">{state.message}</p>;

  const item = state.items.find((candidate) => candidate.id === params.id);
  if (!item) {
    return (
      <Window title="Not found">
        <div className="flex flex-col gap-2 text-[12px]">
          <p>That item is not in this vault.</p>
          <BackLink />
        </div>
      </Window>
    );
  }

  return (
    <Window title={item.title}>
      <div className="flex flex-col gap-2 text-[12px]">
        <p className="text-[#404040]">
          {item.category} · {formatPrice(item.priceCents)} · {timeAgo(item.createdAt, new Date())} · ♥ {item.likes}
        </p>
        <p className="whitespace-pre-wrap">{item.description || "No description."}</p>
        <BackLink />
      </div>
    </Window>
  );
}

function BackLink() {
  return (
    <Link to="/" className="text-[#0000cc] underline">
      Back to feed
    </Link>
  );
}

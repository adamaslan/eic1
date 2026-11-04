import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { AppError, formatPrice, timeAgo } from "@veil/core";
import { parseShareBundle } from "@veil/features";
import type { Route } from "./+types/shared";
import { Button95 } from "~/ui95/Button95";
import { Window } from "~/ui95/Window";
import { useSessionStore } from "~/platform/session";
import { fetchSharedBundle, markRelaySaveIntent, RELAY_ENABLED } from "~/platform/share-relay";
import { sessionSlotStore, writeStash } from "~/pending-links";

/**
 * Read-only view of a post someone shared by link. Opening the link reads the post here -
 * no import, nothing written to the reader's vault. Saving stays an explicit tap, which
 * re-enters the standard import prompt (root.tsx) via the relay hash + save intent.
 */
export function meta(_args: Route.MetaArgs) {
  return [{ title: "Shared post — Everybody is Cool" }];
}

type ViewState =
  | { status: "loading" }
  | { status: "unavailable"; message: string }
  | {
      status: "ready";
      title: string;
      description: string;
      category: string;
      priceCents: number | null;
      createdAt: string;
      handle: string;
      media: { mime: string; data: string }[];
    };

export default function SharedPost({ params }: Route.ComponentProps) {
  const vault = useSessionStore((state) => state.vault);
  const navigate = useNavigate();
  const [state, setState] = useState<ViewState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    if (!RELAY_ENABLED) {
      setState({ status: "unavailable", message: "Link sharing is not enabled on this deployment." });
      return;
    }
    setState({ status: "loading" });
    fetchSharedBundle(params.id)
      .then((text) => {
        if (cancelled) return;
        const bundle = parseShareBundle(text);
        const post = bundle.posts[0];
        if (!post) {
          setState({ status: "unavailable", message: "That share does not contain a post." });
          return;
        }
        setState({
          status: "ready",
          title: post.title,
          description: post.description,
          category: post.category,
          priceCents: post.priceCents,
          createdAt: post.createdAt,
          handle: bundle.author.handle,
          media: bundle.version === 2 ? post.media : [],
        });
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setState({
          status: "unavailable",
          message: caught instanceof AppError ? caught.message : "That shared post could not be loaded.",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [params.id]);

  const onSave = () => {
    // The import prompt lives in root.tsx's pending-link flow; re-enter it with intent.
    markRelaySaveIntent(params.id);
    if (!vault) {
      // Park the link so it survives the unlock/create detour, then go unlock.
      writeStash(sessionSlotStore(), "post", { hash: `#relay=${params.id}`, forAuthorId: null, stashedAt: Date.now() });
      navigate("/");
      return;
    }
    window.location.hash = `#relay=${params.id}`;
  };

  if (state.status === "loading") {
    return (
      <Window title="Shared post">
        <p className="text-[12px]">Opening the shared post…</p>
      </Window>
    );
  }

  if (state.status === "unavailable") {
    return (
      <Window title="Shared post">
        <div className="flex flex-col gap-2 text-[12px]">
          <p role="alert" className="text-[#800000]">{state.message}</p>
          <p className="text-[#404040]">The link may have been revoked or expired. Ask your friend for a fresh one.</p>
          <Link to="/" className="text-[#0000cc] underline">Back home</Link>
        </div>
      </Window>
    );
  }

  return (
    <Window title={state.title}>
      <div className="flex flex-col gap-2 text-[12px]">
        {state.media.map((media, index) => (
          <img
            key={index}
            src={`data:${media.mime};base64,${media.data}`}
            alt={state.title}
            className="w-full border-2 border-white"
          />
        ))}
        <h1 className="text-[16px] font-bold">{state.title}</h1>
        <p className="text-[#404040]">
          {state.category} · {formatPrice(state.priceCents)} · {timeAgo(state.createdAt, new Date())} · from @{state.handle}
        </p>
        <p className="whitespace-pre-wrap">{state.description || "No description."}</p>
        <p className="text-[11px] text-[#404040]">
          Anyone with this link can read this post. The author name is self-asserted - the post is verified against the
          author's key when you save it.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button95 onClick={onSave} title="Imports a verified copy into your vault. Nothing is saved until you confirm.">
            Save to my vault
          </Button95>
          <Link to="/" className="text-[#0000cc] underline self-center">Just looking</Link>
        </div>
      </div>
    </Window>
  );
}

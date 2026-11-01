import { type RouteConfig, index, layout, route } from "@react-router/dev/routes";

export default [
  index("routes/landing.tsx"),
  layout("layouts/desktop.tsx", [
    route("feed", "routes/feed.tsx"),
    route("market", "routes/market.tsx"),
    route("compose", "routes/compose.tsx"),
    route("draw", "routes/draw.tsx"),
    route("connections", "routes/connections.tsx"),
    route("chat/:authorId", "routes/chat.tsx"),
    route("profile", "routes/profile.tsx"),
    route("profile/:authorId", "routes/profile.tsx", { id: "profile-author" }),
    route("tools", "routes/tools.tsx"),
    route("tools/journal", "routes/journal.tsx"),
    route("vault", "routes/vault.tsx"),
    route("item/:id", "routes/item.tsx"),
  ]),
  route("unlock", "routes/unlock.tsx"),
  route("showcase", "routes/home.tsx"),
] satisfies RouteConfig;

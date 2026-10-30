import { type RouteConfig, index, layout, route } from "@react-router/dev/routes";

export default [
  layout("layouts/desktop.tsx", [
    index("routes/feed.tsx"),
    route("market", "routes/market.tsx"),
    route("compose", "routes/compose.tsx"),
    route("vault", "routes/vault.tsx"),
    route("item/:id", "routes/item.tsx"),
  ]),
  route("unlock", "routes/unlock.tsx"),
  route("showcase", "routes/home.tsx"),
] satisfies RouteConfig;

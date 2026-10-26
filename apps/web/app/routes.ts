import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("unlock", "routes/unlock.tsx"),
] satisfies RouteConfig;

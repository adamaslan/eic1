import type { Route } from "./+types/not-found";

export function meta(_args: Route.MetaArgs) {
  return [{ title: "Not found — Everybody is Cool" }];
}

/**
 * Catch-all for unmatched paths. This exists as a real route (not only the root
 * ErrorBoundary) because SPA-mode hydration resolves an unmatched path to the root
 * error boundary on the FIRST client render, which never matches the empty static
 * shell (React error #418 on every unknown-URL hard load). A matched splat route
 * hydrates like every other route and then renders this page.
 */
export default function NotFound() {
  return (
    <main className="pt-16 p-4 container mx-auto">
      <h1>404</h1>
      <p>The requested page could not be found.</p>
    </main>
  );
}

import { useEffect } from "react";
import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "react-router";

import type { Route } from "./+types/root";
import stylesheet from "./app.css?url";
import { useSessionStore } from "~/platform/session";
import { useAutoLock, useSessionExpiry } from "~/platform/use-auto-lock";
import { vaultResume } from "~/platform/vault-service";

export const links: Route.LinksFunction = () => [
  { rel: "stylesheet", href: stylesheet },
];

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  const vault = useSessionStore((state) => state.vault);
  const lock = useSessionStore((state) => state.lock);
  const expiresAt = useSessionStore((state) => state.expiresAt);
  useAutoLock(vault !== null, lock);
  useSessionExpiry(expiresAt, lock);

  // A reload drops the in-memory vault; reopen it from the session saved in the last hour, if any.
  useEffect(() => {
    let cancelled = false;
    vaultResume().then((resumed) => {
      if (cancelled) return;
      const { setVault, doneResuming } = useSessionStore.getState();
      if (resumed) setVault(resumed.vault, resumed.expiresAt);
      else doneResuming();
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let message = "Oops!";
  let details = "An unexpected error occurred.";
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? "404" : "Error";
    details =
      error.status === 404
        ? "The requested page could not be found."
        : error.statusText || details;
  } else if (import.meta.env.DEV && error && error instanceof Error) {
    details = error.message;
    stack = error.stack;
  }

  return (
    <main className="pt-16 p-4 container mx-auto">
      <h1>{message}</h1>
      <p>{details}</p>
      {stack && (
        <pre className="w-full p-4 overflow-x-auto">
          <code>{stack}</code>
        </pre>
      )}
    </main>
  );
}

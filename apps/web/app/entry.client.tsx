import { startTransition, StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import { HydratedRouter } from "react-router/dom";

// Netlify injects its HUD script after </html>; the HTML parser hoists it into <body>,
// which breaks hydration (React error #418 on every hard load). Strip injected third-party
// scripts before hydrating so the DOM matches the streamed shell.
document.querySelectorAll('script[src*=".netlify/"]').forEach((node) => node.remove());

// Deploy previews go further: a whole badge <div data-netlify-deploy-id> (with its own
// script and comment) is appended after </html> and hoisted to the end of <body>.
// Strip that container too or previews keep mismatching.
document.querySelectorAll("[data-netlify-deploy-id]").forEach((node) => node.remove());

// Netlify Edge also injects an HTML comment (the "hosted on Netlify" hosting-facts banner)
// into <head> and at the end of the served page. The extra comment node shifts the DOM the
// client hydrates against, which is the current source of React #418 on every hard load.
// Strip injected Netlify comments before hydrating as well.
for (const root of [document.head, document.body]) {
  if (!root) continue;
  for (const node of Array.from(root.childNodes)) {
    if (node.nodeType === Node.COMMENT_NODE && /netlify/i.test(node.textContent ?? "")) {
      node.remove();
    }
  }
}

startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <HydratedRouter />
    </StrictMode>,
  );
});

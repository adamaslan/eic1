import { startTransition, StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import { HydratedRouter } from "react-router/dom";

// Netlify injects markup after </html>: a HUD script in production, and a whole badge
// <div data-netlify-deploy-id> (with its own comment + script) on deploy previews, plus a
// "hosted on Netlify" comment in <head> on production. The HTML parser hoists all of it
// into <body>, which breaks hydration (React error #418 on every hard load).
//
// Timing matters: this module executes while the parser may not have reached the
// post-</html> injection yet, so stripping immediately races the parser. Wait until the
// document is fully parsed (DOMContentLoaded), strip the injected nodes, then hydrate.
function stripNetlifyInjections() {
  document.querySelectorAll('script[src*=".netlify/"]').forEach((node) => node.remove());
  document.querySelectorAll("[data-netlify-deploy-id]").forEach((node) => node.remove());
  for (const root of [document.head, document.body]) {
    if (!root) continue;
    for (const node of Array.from(root.childNodes)) {
      if (node.nodeType === Node.COMMENT_NODE && /netlify/i.test(node.textContent ?? "")) {
        node.remove();
      }
    }
  }
}

function hydrate() {
  stripNetlifyInjections();
  startTransition(() => {
    hydrateRoot(
      document,
      <StrictMode>
        <HydratedRouter />
      </StrictMode>,
    );
  });
}

if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", hydrate, { once: true });
} else {
  hydrate();
}

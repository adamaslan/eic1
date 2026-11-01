import { startTransition, StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import { HydratedRouter } from "react-router/dom";

// Netlify rewrites the served document: a HUD script after </html> in production, a whole
// badge <div data-netlify-deploy-id> (with its own comment + script) after </html> on
// deploy previews, and a "hosted on Netlify" comment inside <head> on the production free
// tier. The head comment carries a leading newline, so after parsing, a whitespace text
// node sits between the two <meta> tags that the prerendered shell has adjacent - that one
// text node is what breaks document hydration (React error #418 on every hard load). The
// HTML parser hoists the post-</html> markup into <body>, which hydration tolerates.
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
  // The branding comment's leading newline survives comment removal as a whitespace-only
  // text node between the <meta> tags, and React's prerendered <head> has them adjacent.
  // Whitespace-only text is never meaningful <head> content (head carries elements only),
  // so drop it; any text node with real content stays untouched.
  for (const node of Array.from(document.head.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim() === "") {
      node.remove();
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

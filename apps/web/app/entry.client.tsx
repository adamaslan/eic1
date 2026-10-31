import { startTransition, StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import { HydratedRouter } from "react-router/dom";

// Netlify injects its HUD script after </html>; the HTML parser hoists it into <body>,
// which breaks hydration (React error #418 on every hard load). Strip injected third-party
// scripts before hydrating so the DOM matches the streamed shell.
document.querySelectorAll('script[src*=".netlify/"]').forEach((node) => node.remove());

startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <HydratedRouter />
    </StrictMode>,
  );
});

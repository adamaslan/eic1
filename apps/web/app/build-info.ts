// Injected by vite.config.ts `define` at build time (Netlify COMMIT_REF + build date).
declare const __BUILD_SHA__: string;
declare const __BUILD_DATE__: string;

// Root-level tests do not load the web Vite config. Keep those imports safe
// without inventing a build identity; Vite replaces the constants in real builds.
export const BUILD_SHA = typeof __BUILD_SHA__ === "string" ? __BUILD_SHA__ : "dev";
export const BUILD_DATE = typeof __BUILD_DATE__ === "string" ? __BUILD_DATE__ : "unknown";

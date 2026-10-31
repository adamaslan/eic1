// Injected by vite.config.ts `define` at build time (Netlify COMMIT_REF + build date).
declare const __BUILD_SHA__: string;
declare const __BUILD_DATE__: string;

export const BUILD_SHA = __BUILD_SHA__;
export const BUILD_DATE = __BUILD_DATE__;

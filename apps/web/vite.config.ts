import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// Netlify sets COMMIT_REF at build time; fall back to "dev" locally.
const buildSha = (process.env.COMMIT_REF ?? "dev").slice(0, 7);
const buildDate = new Date().toISOString().slice(0, 10);

export default defineConfig({
  define: {
    __BUILD_SHA__: JSON.stringify(buildSha),
    __BUILD_DATE__: JSON.stringify(buildDate),
  },
  resolve: {
    tsconfigPaths: true,
  },
  plugins: [tailwindcss(), reactRouter()],
});

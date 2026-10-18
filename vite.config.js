import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    /* Font files stay files. Vite inlines anything under 4KB, which put every
       small subset (and its unused .woff fallback) into the stylesheet as
       base64 — 45KB of CSS parsed on every load for glyphs never shown. As
       files, the browser fetches only the subsets a page actually uses. */
    assetsInlineLimit: (file) => (/\.woff2?$/.test(file) ? false : undefined),
  },
  server: {
    proxy: {
      '/api': 'http://localhost:4001',
    },
  },
});

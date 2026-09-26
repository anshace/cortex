import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import wasm from "vite-plugin-wasm";

import { BRAND } from "./src/brand";

// In Docker dev, the backend is another service ("backend"); locally it's
// 127.0.0.1. Overridable via VITE_PROXY_TARGET.
const proxyTarget = process.env.VITE_PROXY_TARGET || "http://127.0.0.1:3030";

export default defineConfig({
  base: "",
  build: {
    // esnext supports top-level await natively (needed by the wasm import), so
    // we don't need vite-plugin-top-level-await.
    target: "esnext",
    chunkSizeWarningLimit: 1000,
  },
  plugins: [
    wasm(),
    react(),
    VitePWA({
      registerType: "prompt",
      includeAssets: ["favicon.svg", "chat-bg.svg"],
      manifest: {
        id: "/",
        name: BRAND.name,
        short_name: BRAND.name,
        description: BRAND.description,
        // Matches surface.bg in src/theme.ts, which is what the first paint
        // actually shows. A splash in a colour the app never renders reads as a
        // different product for the half-second it is up.
        theme_color: "#0a0b0e",
        background_color: "#0a0b0e",
        display: "standalone",
        orientation: "any",
        scope: "/",
        start_url: "/",
        lang: "en",
        categories: ["productivity", "business"],
        prefer_related_applications: false,
        icons: [
          { src: "pwa-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "pwa-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          {
            src: "pwa-maskable-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
          { src: "apple-touch-icon.png", sizes: "180x180", type: "image/png" },
        ],
      },
      workbox: {
        // The app talks to the backend over /api (REST + WebSocket); never
        // cache those — only precache the built assets.
        navigateFallback: "index.html",
        navigateFallbackDenylist: [/^\/api\//],
        // The chat wallpapers are 2.3 MB of JPEG the average user never opens.
        // Precaching them charges every install for them; instead they are
        // cached on first use, so picking one offline still works afterwards.
        globIgnores: ["**/wallpaper-*.jpg"],
        runtimeCaching: [
          {
            urlPattern: /\/wallpaper-[a-z-]+\.jpg$/,
            handler: "StaleWhileRevalidate",
            options: {
              cacheName: "wallpapers",
              expiration: { maxEntries: 6, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
        ],
        // Monaco's ts.worker and the main/editor bundles exceed the default
        // 2 MiB precache limit; allow them so offline mode actually works.
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
      },
    }),
  ],
  server: {
    host: true,
    port: 5173,
    proxy: {
      "/api": {
        target: proxyTarget,
        changeOrigin: true,
        secure: false,
        ws: true,
      },
    },
  },
});

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import wasm from "vite-plugin-wasm";

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
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg", "chat-bg.svg"],
      manifest: {
        name: "Cortex",
        short_name: "Cortex",
        description: "Cortex — a private, collaborative workspace.",
        theme_color: "#14122a",
        background_color: "#0c0a1a",
        display: "standalone",
        start_url: ".",
        icons: [
          { src: "pwa-192.png", sizes: "192x192", type: "image/png" },
          { src: "pwa-512.png", sizes: "512x512", type: "image/png" },
          {
            src: "pwa-maskable-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        // The app talks to the backend over /api (REST + WebSocket); never
        // cache those — only precache the built assets.
        navigateFallback: "index.html",
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [],
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

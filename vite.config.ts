import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
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
  plugins: [wasm(), react()],
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

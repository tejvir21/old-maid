import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

const target = process.env["VITE_DEV_BACKEND"] ?? "http://localhost:10000";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: false, // registered explicitly in src/app/pwa.ts
      includeAssets: ["favicon.svg", "icons/*.png"],
      manifest: {
        name: "Old Maid",
        short_name: "Old Maid",
        description: "A game of memory, deception and chance. Play offline against AI or online with friends.",
        theme_color: "#0b0b0d",
        background_color: "#0b0b0d",
        display: "standalone",
        orientation: "any",
        start_url: "/",
        scope: "/",
        categories: ["games", "entertainment"],
        icons: [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        // The whole app shell (HTML, JS, CSS, fonts, icons) is precached so it launches with no network.
        globPatterns: ["**/*.{js,css,html,svg,png,woff2,woff,webmanifest}"],
        navigateFallback: "/index.html",
        // API + realtime traffic must never be served from the app-shell fallback or cached.
        navigateFallbackDenylist: [/^\/api\//, /^\/socket\.io\//, /^\/health/],
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
        runtimeCaching: [],
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      "/api": { target, changeOrigin: true },
      "/health": { target, changeOrigin: true },
      "/socket.io": { target, ws: true, changeOrigin: true },
    },
  },
  build: { sourcemap: false, target: "es2022" },
});

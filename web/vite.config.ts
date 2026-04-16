import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  plugins: [svelte()],
  base: "/",
  build: {
    outDir: "dist",
    sourcemap: false,
  },
  server: {
    port: 5273,
    proxy: {
      "/api": {
        target: "http://localhost:8300",
        changeOrigin: true,
      },
      "/auth": {
        target: "http://localhost:8300",
        changeOrigin: true,
      },
      "/health": {
        target: "http://localhost:8300",
        changeOrigin: true,
      },
    },
  },
});

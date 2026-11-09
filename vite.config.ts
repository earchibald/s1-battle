import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: { "@shared": fileURLToPath(new URL("./shared", import.meta.url)) },
  },
  server: {
    port: 5173,
    // API_PORT lets a second checkout run beside the main one.
    proxy: { "/api": { target: `http://localhost:${process.env.API_PORT ?? 8787}`, changeOrigin: true } },
  },
  build: { outDir: "dist", sourcemap: true },
});

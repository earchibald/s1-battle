import { defineConfig } from "vite";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };
/** Short commit hash, with "+" when tracked files have uncommitted changes; "" outside a repository. */
function commitSha(): string {
  try {
    const run = (args: string[]) => execFileSync("git", args, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    const sha = run(["rev-parse", "--short", "HEAD"]);
    return run(["status", "--porcelain", "--untracked-files=no"]) ? `${sha}+` : sha;
  } catch {
    return "";
  }
}

export default defineConfig({
  resolve: {
    alias: { "@shared": fileURLToPath(new URL("./shared", import.meta.url)) },
  },
  // Shown on the page (top bar) so a screenshot or bug report says exactly which build it came from.
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __GIT_SHA__: JSON.stringify(commitSha()),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  server: {
    port: 5173,
    // API_PORT lets a second checkout run beside the main one.
    proxy: { "/api": { target: `http://localhost:${process.env.API_PORT ?? 8787}`, changeOrigin: true } },
  },
  build: { outDir: "dist", sourcemap: true },
});

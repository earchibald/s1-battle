/** Build identity, injected by vite.config.ts `define`. Fallbacks keep tsx scripts (no Vite) working. */
declare const __APP_VERSION__: string;
declare const __GIT_SHA__: string;
declare const __BUILD_TIME__: string;

export const VERSION: string = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";
export const GIT_SHA: string = typeof __GIT_SHA__ === "string" ? __GIT_SHA__ : "";
export const BUILD_TIME: string = typeof __BUILD_TIME__ === "string" ? __BUILD_TIME__ : "";
/** "v0.2.0 · f57210d" */
export const VERSION_LABEL = `v${VERSION}${GIT_SHA ? ` · ${GIT_SHA}` : ""}`;

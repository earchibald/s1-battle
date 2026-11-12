/** Fullscreen for the whole page (arena + HUD). Safari before 16.4 only has the webkit-prefixed API. */

type WebkitDoc = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => Promise<void> | void };
type WebkitEl = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };

const doc = document as WebkitDoc;
const root = document.documentElement as WebkitEl;

export const fullscreenSupported = !!(root.requestFullscreen || root.webkitRequestFullscreen);

export function isFullscreen(): boolean {
  return !!(doc.fullscreenElement ?? doc.webkitFullscreenElement);
}

export function toggleFullscreen(): void {
  try {
    if (isFullscreen()) {
      if (doc.exitFullscreen) void doc.exitFullscreen().catch(() => {});
      else void doc.webkitExitFullscreen?.();
    } else if (root.requestFullscreen) {
      void root.requestFullscreen({ navigationUI: "hide" }).catch(() => {});
    } else {
      void root.webkitRequestFullscreen?.();
    }
  } catch {
    // Denied (not from a user gesture, or in an iframe without allow="fullscreen"): stay windowed.
  }
}

/** Calls `fn` whenever fullscreen is entered or left (including via Esc). */
export function onFullscreenChange(fn: (on: boolean) => void): void {
  const h = () => fn(isFullscreen());
  document.addEventListener("fullscreenchange", h);
  document.addEventListener("webkitfullscreenchange", h);
}

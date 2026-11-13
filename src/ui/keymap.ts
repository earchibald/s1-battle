/**
 * The arena's keyboard map, laid out like a PC action game: the left-hand cluster (WASD, Space, Shift, Q/E/R/F/C)
 * and the arrow keys belong to a pilot driving a bot, and everything else (menus, camera, speed, debug) lives
 * on keys a driving hand doesn't rest on. One table feeds the key handler, the control-bar tooltips and the
 * H help panel, so they can't drift apart.
 *
 * Letter shortcuts match `KeyboardEvent.key`, so they follow the user's layout (U is wherever U is printed).
 * Positional keys (` - = digits, and the reserved pilot cluster) match `KeyboardEvent.code`, the physical key,
 * so WASD stays a diamond on AZERTY.
 */

export type KeyAction =
  | "pause"
  | "newMatch"
  | "slower"
  | "faster"
  | "camera"
  | "debug"
  | "mute"
  | "fullscreen"
  | "help"
  | "garage"
  | "season"
  | "users"
  | "log"
  | "logSearch"
  | "allJev"
  | "allTrained"
  | "allBaseline";

interface Binding {
  action: KeyAction;
  group: "Match" | "View" | "Screens" | "Brains";
  label: string;
  /** How the keys are written in tooltips and the help panel. */
  keys: string[];
  /** Letters, compared to `ev.key` case-insensitively. */
  letters?: string[];
  /** Exact `ev.key` values (named keys and punctuation). */
  named?: string[];
  /** `ev.code` values (physical position). */
  codes?: string[];
  /** Needs Alt/Option held (Alt+Enter). Bindings without it refuse Alt, Ctrl and ⌘ so browser shortcuts pass. */
  alt?: boolean;
}

export const BINDINGS: Binding[] = [
  { action: "pause", group: "Match", label: "Pause / resume", keys: ["P", "Esc"], letters: ["p"], named: ["Pause"] },
  { action: "newMatch", group: "Match", label: "New match", keys: ["N"], letters: ["n"] },
  { action: "slower", group: "Match", label: "Slower (½× · 1× · 2×)", keys: ["−"], codes: ["Minus", "NumpadSubtract"] },
  { action: "faster", group: "Match", label: "Faster", keys: ["="], codes: ["Equal", "NumpadAdd"] },
  { action: "camera", group: "View", label: "Auto / free camera", keys: ["V"], letters: ["v"] },
  { action: "fullscreen", group: "View", label: "Fullscreen", keys: ["F11", "Alt+Enter"], named: ["F11"] },
  { action: "fullscreen", group: "View", label: "", keys: [], named: ["Enter"], alt: true },
  { action: "mute", group: "View", label: "Mute", keys: ["M"], letters: ["m"] },
  { action: "debug", group: "View", label: "Debug nav lines", keys: ["`", "F3"], codes: ["Backquote"], named: ["F3"] },
  { action: "help", group: "View", label: "This key list", keys: ["H", "?"], letters: ["h"], named: ["?"] },
  { action: "season", group: "Screens", label: "Season hub", keys: ["Tab"], named: ["Tab"] },
  { action: "garage", group: "Screens", label: "Garage", keys: ["G"], letters: ["g"] },
  { action: "users", group: "Screens", label: "Users and wallets", keys: ["U"], letters: ["u"] },
  { action: "log", group: "Screens", label: "Event log", keys: ["L"], letters: ["l"] },
  { action: "logSearch", group: "Screens", label: "Search the event log", keys: ["/"], named: ["/"] },
  { action: "allJev", group: "Brains", label: "Every bot on Jev", keys: ["8"], codes: ["Digit8"] },
  { action: "allTrained", group: "Brains", label: "Every bot on trained", keys: ["9"], codes: ["Digit9"] },
  { action: "allBaseline", group: "Brains", label: "Every bot on baseline", keys: ["0"], codes: ["Digit0"] },
];

/**
 * Keys held back for piloting (see the pilot-mode plan): player one drives on WASD or the arrows, fires on Space,
 * boosts on Shift, releases a grip on E, cycles target on Q; R, F and C are kept free for more pilot actions.
 * Nothing in BINDINGS may use them. Space and the arrows are swallowed so they never scroll the page or press
 * a focused button.
 */
export const PILOT_RESERVED = new Set([
  "KeyW", "KeyA", "KeyS", "KeyD", "KeyQ", "KeyE", "KeyR", "KeyF", "KeyC",
  "Space", "ShiftLeft", "ShiftRight", "ControlLeft",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
]);
const SWALLOW = new Set(["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);

export const PILOT_KEYS: { keys: string[]; label: string }[] = [
  { keys: ["W A S D", "↑ ← ↓ →"], label: "Drive (pilot mode)" },
  { keys: ["Space"], label: "Fire / hold the weapon" },
  { keys: ["Shift"], label: "Boost" },
  { keys: ["E"], label: "Release a grip" },
  { keys: ["Q"], label: "Cycle target" },
  { keys: ["R", "F", "C"], label: "Kept free" },
];

function matches(b: Binding, ev: KeyboardEvent): boolean {
  const mods = ev.ctrlKey || ev.metaKey || ev.altKey;
  if (b.alt ? !ev.altKey || ev.ctrlKey || ev.metaKey : mods) return false;
  if (b.codes?.includes(ev.code)) return true;
  if (b.named?.includes(ev.key)) return true;
  return !!b.letters?.includes(ev.key.toLowerCase());
}

/** The arena action a key press asks for, or null. Reserved pilot keys never map to an action. */
export function actionFor(ev: KeyboardEvent): KeyAction | null {
  if (PILOT_RESERVED.has(ev.code)) return null;
  for (const b of BINDINGS) if (matches(b, ev)) return b.action;
  return null;
}

/** Whether this press is a reserved pilot key the page should swallow (no scrolling, no button presses). */
export function swallowPilotKey(ev: KeyboardEvent): boolean {
  return SWALLOW.has(ev.code) && !(ev.ctrlKey || ev.metaKey || ev.altKey);
}

/** Does this press match `action`? Used by overlays that close on their own key. */
export function isKey(ev: KeyboardEvent, action: KeyAction): boolean {
  return BINDINGS.some((b) => b.action === action && matches(b, ev));
}

/** "P or Esc": the keys for an action, written for a tooltip. */
export function keyHint(action: KeyAction): string {
  return BINDINGS.filter((b) => b.action === action)
    .flatMap((b) => b.keys)
    .join(" or ");
}

/** Visible rows for the help panel, grouped. */
export function helpRows(): { group: string; rows: { keys: string[]; label: string }[] }[] {
  const out: { group: string; rows: { keys: string[]; label: string }[] }[] = [];
  for (const b of BINDINGS) {
    if (!b.label) continue;
    let g = out.find((x) => x.group === b.group);
    if (!g) out.push((g = { group: b.group, rows: [] }));
    g.rows.push({ keys: b.keys, label: b.label });
  }
  return out;
}

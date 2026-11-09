import type { Vec } from "./math";

/** Arena geometry and hazard timing. Units are meters; the arena is a square centered on the origin. */
export const ARENA = {
  half: 10,
  wallHeight: 1.2,
  /** Pit: a square trapdoor against the north wall. */
  pit: { center: { x: 0, y: 7.6 } as Vec, half: 2.1, opensAt: 30, openSeconds: 12, closedSeconds: 18, warnSeconds: 3 },
  /** Kill saws: two floor slots that cycle retracted -> rising -> up. */
  saws: {
    slots: [
      { center: { x: -5.6, y: 0 } as Vec, halfX: 0.9, halfY: 3.0 },
      { center: { x: 5.6, y: 0 } as Vec, halfX: 0.9, halfY: 3.0 },
    ],
    period: 10,
    riseAt: 6.5,
    upAt: 7.5,
    /** damage per second while standing on a raised saw */
    dps: 14,
  },
  /**
   * Flame vents: a row of floor nozzles south of center. They erupt one after another, sweeping west to
   * east and back on alternate cycles; each glows for `warnSeconds` before it fires. Burns and ignites.
   */
  vents: {
    slots: [
      { x: -3.6, y: -4.6 },
      { x: -1.8, y: -4.6 },
      { x: 0, y: -4.6 },
      { x: 1.8, y: -4.6 },
      { x: 3.6, y: -4.6 },
    ] as Vec[],
    radius: 0.9,
    /** fightTime of the first eruption; the sweep repeats every `period`. */
    firstAt: 12,
    period: 11,
    /** seconds between one vent lighting and the next */
    step: 1.1,
    warnSeconds: 1.0,
    burnSeconds: 1.2,
    /** damage per second on a lit vent, plus `burnTime` seconds on fire afterwards */
    dps: 12,
    burnTime: 2.0,
  },
  /**
   * Launch pad: a pneumatic floor tile north of center. Every `period` seconds it charges, then kicks
   * whatever stands on it into the air toward the pit.
   */
  pad: {
    center: { x: 0, y: 1.8 } as Vec,
    half: 1.1,
    firstAt: 9,
    period: 9,
    warnSeconds: 1.6,
    launchVz: 8.5,
    launchForward: 12,
    /** throw direction: north, at the pit */
    dir: { x: 0, y: 1 } as Vec,
  },
  /**
   * Shock plates: two electrified floor panels flanking the pit approach. They take turns: one charges
   * (arcing, `warnSeconds`) and discharges every `period` seconds, stunning whatever is on it.
   */
  shock: {
    plates: [{ center: { x: -5.4, y: 7.0 } as Vec }, { center: { x: 5.4, y: 7.0 } as Vec }],
    half: 1.5,
    firstAt: 16,
    period: 7,
    warnSeconds: 2.0,
    /** how long the plate keeps arcing after the discharge (rendering and avoidance only) */
    liveSeconds: 0.5,
    stun: 1.6,
    damage: 8,
  },
  matchSeconds: 180,
  countdownSeconds: 3,
  /** Start positions, one per lineup slot, facing the center. */
  starts: [
    { x: -6.8, y: -6.8 },
    { x: 6.8, y: -6.8 },
    { x: 6.8, y: 4.6 },
    { x: -6.8, y: 4.6 },
  ] as Vec[],
};

export type SawPhase = "down" | "rising" | "up";

export function sawPhase(t: number): SawPhase {
  const m = ((t % ARENA.saws.period) + ARENA.saws.period) % ARENA.saws.period;
  if (m >= ARENA.saws.upAt) return "up";
  if (m >= ARENA.saws.riseAt) return "rising";
  return "down";
}
/** 0..1 how far the saws are out of the floor, for rendering. */
export function sawRaise(t: number): number {
  const m = ((t % ARENA.saws.period) + ARENA.saws.period) % ARENA.saws.period;
  if (m >= ARENA.saws.upAt) return 1;
  if (m >= ARENA.saws.riseAt) return (m - ARENA.saws.riseAt) / (ARENA.saws.upAt - ARENA.saws.riseAt);
  return 0;
}

export type PitPhase = "closed" | "warning" | "open";
export function pitPhase(t: number): PitPhase {
  const { opensAt, openSeconds, closedSeconds, warnSeconds } = ARENA.pit;
  if (t < opensAt - warnSeconds) return "closed";
  if (t < opensAt) return "warning";
  const cycle = openSeconds + closedSeconds;
  const m = (t - opensAt) % cycle;
  if (m < openSeconds) return "open";
  if (m >= cycle - warnSeconds) return "warning";
  return "closed";
}
/** Seconds until the pit next opens (0 while open), for the HUD. */
export function pitCountdown(t: number): number {
  const { opensAt, openSeconds, closedSeconds } = ARENA.pit;
  if (t < opensAt) return opensAt - t;
  const cycle = openSeconds + closedSeconds;
  const m = (t - opensAt) % cycle;
  return m < openSeconds ? 0 : cycle - m;
}
/** 0..1 how far the trapdoor has slid open, for rendering. */
export function pitOpenAmount(t: number): number {
  const { opensAt, openSeconds, closedSeconds } = ARENA.pit;
  if (t < opensAt) return 0;
  const cycle = openSeconds + closedSeconds;
  const m = (t - opensAt) % cycle;
  if (m < 0.6) return m / 0.6;
  if (m < openSeconds) return 1;
  if (m < openSeconds + 0.6) return 1 - (m - openSeconds) / 0.6;
  return 0;
}

export function insidePit(p: Vec, margin = 0): boolean {
  const { center, half } = ARENA.pit;
  return Math.abs(p.x - center.x) < half - margin && Math.abs(p.y - center.y) < half - margin;
}

export function onSaws(p: Vec, radius: number): boolean {
  for (const s of ARENA.saws.slots) {
    if (Math.abs(p.x - s.center.x) < s.halfX + radius * 0.5 && Math.abs(p.y - s.center.y) < s.halfY + radius * 0.5) return true;
  }
  return false;
}

export function nearestSawSlot(p: Vec): { center: Vec; d: number } {
  let best = ARENA.saws.slots[0];
  let bd = Infinity;
  for (const s of ARENA.saws.slots) {
    const d = Math.hypot(p.x - s.center.x, p.y - s.center.y);
    if (d < bd) {
      bd = d;
      best = s;
    }
  }
  return { center: best.center, d: bd };
}

/* ------------------------------------------------------------------------------------------------ */
/* Traps: flame vents, launch pad, shock plates. All pure functions of fightTime, like the pit/saws. */
/* ------------------------------------------------------------------------------------------------ */

export type VentPhase = "idle" | "warning" | "erupting";
/** Seconds since vent `i` started glowing in the current sweep (negative: not yet), or null before the first. */
function ventSince(i: number, t: number): number | null {
  const V = ARENA.vents;
  const u = t - (V.firstAt - V.warnSeconds);
  if (u < 0) return null;
  const n = Math.floor(u / V.period);
  const order = n % 2 === 1 ? V.slots.length - 1 - i : i;
  return u - n * V.period - order * V.step;
}
export function ventPhase(i: number, t: number): VentPhase {
  const V = ARENA.vents;
  const since = ventSince(i, t);
  if (since === null || since < 0) return "idle";
  if (since < V.warnSeconds) return "warning";
  if (since < V.warnSeconds + V.burnSeconds) return "erupting";
  return "idle";
}
/** 0..1 flame height for rendering: a low pilot glow while warning, full while erupting. */
export function ventLevel(i: number, t: number): number {
  const V = ARENA.vents;
  const since = ventSince(i, t);
  if (since === null || since < 0) return 0;
  if (since < V.warnSeconds) return 0.1 + 0.12 * (since / V.warnSeconds);
  const b = since - V.warnSeconds;
  if (b < V.burnSeconds) return Math.max(0.2, Math.min(1, b / 0.12) * Math.min(1, (V.burnSeconds - b) / 0.25));
  return 0;
}
/** The row as a whole, for the HUD and Jev. */
export function ventsPhase(t: number): VentPhase {
  let out: VentPhase = "idle";
  for (let i = 0; i < ARENA.vents.slots.length; i++) {
    const p = ventPhase(i, t);
    if (p === "erupting") return "erupting";
    if (p === "warning") out = "warning";
  }
  return out;
}
/** Which way the current (or next) sweep runs. */
export function ventSweep(t: number): "west to east" | "east to west" {
  const V = ARENA.vents;
  const u = t - (V.firstAt - V.warnSeconds);
  return u >= 0 && Math.floor(u / V.period) % 2 === 1 ? "east to west" : "west to east";
}
/** Index of the vent `p` is standing on, or -1. */
export function onVent(p: Vec, radius: number): number {
  const V = ARENA.vents;
  for (let i = 0; i < V.slots.length; i++) {
    if (Math.hypot(p.x - V.slots[i].x, p.y - V.slots[i].y) < V.radius + radius * 0.3) return i;
  }
  return -1;
}

export type PadPhase = "idle" | "charging";
export function padPhase(t: number): PadPhase {
  return padCharge(t) > 0 ? "charging" : "idle";
}
/** How many times the pad has fired so far; the world launches when this ticks up. */
export function padFireCount(t: number): number {
  const P = ARENA.pad;
  return t < P.firstAt ? 0 : Math.floor((t - P.firstAt) / P.period) + 1;
}
/** 0..1 charge while charging (0 when idle), for rendering. */
export function padCharge(t: number): number {
  const P = ARENA.pad;
  const u = t - (P.firstAt - P.warnSeconds);
  if (u < 0) return 0;
  const m = u % P.period;
  return m < P.warnSeconds ? Math.max(0.001, m / P.warnSeconds) : 0;
}
/** Seconds since the pad last fired (Infinity before the first), for the kick animation. */
export function padSinceFire(t: number): number {
  const P = ARENA.pad;
  return t < P.firstAt ? Infinity : (t - P.firstAt) % P.period;
}
export function onPad(p: Vec, margin = 0): boolean {
  const { center, half } = ARENA.pad;
  return Math.abs(p.x - center.x) < half + margin && Math.abs(p.y - center.y) < half + margin;
}

export type ShockPhase = "idle" | "charging" | "live";
/** How many discharges so far. Pulse k (0-based) belongs to plate k % plates. */
export function shockPulseCount(t: number): number {
  const S = ARENA.shock;
  return t < S.firstAt ? 0 : Math.floor((t - S.firstAt) / S.period) + 1;
}
/** Seconds since this plate's most recent discharge slot, wrapped to its own cycle; `u` is unwrapped. */
function shockClock(plate: number, t: number): { u: number; m: number; cycle: number } {
  const S = ARENA.shock;
  const cycle = S.period * S.plates.length;
  const u = t - (S.firstAt + plate * S.period);
  return { u, m: ((u % cycle) + cycle) % cycle, cycle };
}
export function shockPhase(plate: number, t: number): ShockPhase {
  const S = ARENA.shock;
  const { u, m, cycle } = shockClock(plate, t);
  if (u >= 0 && m < S.liveSeconds) return "live";
  if (u >= -S.warnSeconds && m >= cycle - S.warnSeconds) return "charging";
  return "idle";
}
/** 0..1 charge while charging (1 while live), for rendering. */
export function shockCharge(plate: number, t: number): number {
  const ph = shockPhase(plate, t);
  if (ph === "live") return 1;
  if (ph === "idle") return 0;
  const { m, cycle } = shockClock(plate, t);
  return 1 - (cycle - m) / ARENA.shock.warnSeconds;
}
export function onShockPlate(p: Vec, radius: number, plate: number): boolean {
  const S = ARENA.shock;
  const c = S.plates[plate].center;
  return Math.abs(p.x - c.x) < S.half + radius * 0.3 && Math.abs(p.y - c.y) < S.half + radius * 0.3;
}

/** A trap that is telegraphing or firing right now, as a floor rectangle. */
export interface TrapZone {
  kind: "vent" | "pad" | "shock";
  /** vent or plate index (0 for the pad) */
  index: number;
  center: Vec;
  halfX: number;
  halfY: number;
  phase: "warning" | "active";
}
export const TRAP_NAMES: Record<TrapZone["kind"], string> = { vent: "flame vent", pad: "launch pad", shock: "shock plate" };

export function liveTraps(t: number): TrapZone[] {
  const out: TrapZone[] = [];
  const V = ARENA.vents;
  for (let i = 0; i < V.slots.length; i++) {
    const p = ventPhase(i, t);
    if (p !== "idle") out.push({ kind: "vent", index: i, center: V.slots[i], halfX: V.radius, halfY: V.radius, phase: p === "erupting" ? "active" : "warning" });
  }
  if (padPhase(t) === "charging") out.push({ kind: "pad", index: 0, center: ARENA.pad.center, halfX: ARENA.pad.half, halfY: ARENA.pad.half, phase: "warning" });
  const S = ARENA.shock;
  for (let i = 0; i < S.plates.length; i++) {
    const p = shockPhase(i, t);
    if (p !== "idle") out.push({ kind: "shock", index: i, center: S.plates[i].center, halfX: S.half, halfY: S.half, phase: p === "live" ? "active" : "warning" });
  }
  return out;
}
/** Distance from `p` to the edge of a zone (0 inside it). */
export function trapGap(p: Vec, z: TrapZone): number {
  const dx = Math.max(0, Math.abs(p.x - z.center.x) - z.halfX);
  const dy = Math.max(0, Math.abs(p.y - z.center.y) - z.halfY);
  return Math.hypot(dx, dy);
}
export function nearestLiveTrap(p: Vec, t: number): { zone: TrapZone; d: number } | null {
  let best: { zone: TrapZone; d: number } | null = null;
  for (const zone of liveTraps(t)) {
    const d = trapGap(p, zone);
    if (!best || d < best.d) best = { zone, d };
  }
  return best;
}

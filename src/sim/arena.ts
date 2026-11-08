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

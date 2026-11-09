import type { Footprint } from "@shared/build";
import { dot, type Vec } from "./math";

/**
 * Oriented bounding boxes for bot chassis. A box is the bot's footprint (front / back / half-width) placed
 * at its position and turned to its heading. Everything here is plain arithmetic so the sim stays
 * deterministic and identical in the browser and in Node.
 */
export interface Obb {
  /** Box centre (the chassis centre, not the axle). */
  c: Vec;
  /** Unit forward axis. */
  f: Vec;
  /** Unit lateral axis (left of forward). */
  s: Vec;
  /** Half-length along `f`. */
  hx: number;
  /** Half-width along `s`. */
  hy: number;
}

export function makeObb(p: Vec, heading: number, fp: Footprint): Obb {
  const f = { x: Math.cos(heading), y: Math.sin(heading) };
  const off = (fp.front - fp.back) / 2;
  return {
    c: { x: p.x + f.x * off, y: p.y + f.y * off },
    f,
    s: { x: -f.y, y: f.x },
    hx: (fp.front + fp.back) / 2,
    hy: fp.half,
  };
}

/** Half-extent of the box projected onto a unit axis. */
function extent(b: Obb, axis: Vec): number {
  return b.hx * Math.abs(dot(b.f, axis)) + b.hy * Math.abs(dot(b.s, axis));
}

/** World-axis-aligned half extents, for wall clamping. */
export function aabbExtents(b: Obb): Vec {
  return { x: extent(b, { x: 1, y: 0 }), y: extent(b, { x: 0, y: 1 }) };
}

export interface Contact {
  /** Unit normal pointing from box `a` into box `b`. */
  n: Vec;
  /** Penetration depth along `n`. */
  depth: number;
}

/**
 * Separating-axis test. Returns the minimum-translation contact when the boxes overlap, or null.
 * The four candidate axes are the two boxes' forward and side directions.
 */
export function obbContact(a: Obb, b: Obb): Contact | null {
  const d = { x: b.c.x - a.c.x, y: b.c.y - a.c.y };
  let best: Contact | null = null;
  const axes = [a.f, a.s, b.f, b.s];
  for (const axis of axes) {
    const dist = dot(d, axis);
    const overlap = extent(a, axis) + extent(b, axis) - Math.abs(dist);
    if (overlap <= 0) return null;
    if (!best || overlap < best.depth) {
      const sign = dist < 0 ? -1 : 1;
      best = { n: { x: axis.x * sign, y: axis.y * sign }, depth: overlap };
    }
  }
  return best;
}

/** The four corners, for debug drawing. */
export function obbCorners(b: Obb): Vec[] {
  const out: Vec[] = [];
  for (const [sx, sy] of [
    [1, 1],
    [1, -1],
    [-1, -1],
    [-1, 1],
  ]) {
    out.push({ x: b.c.x + b.f.x * b.hx * sx + b.s.x * b.hy * sy, y: b.c.y + b.f.y * b.hx * sx + b.s.y * b.hy * sy });
  }
  return out;
}

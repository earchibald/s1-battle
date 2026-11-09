import { BOT_KINDS, type Maneuver } from "@shared/types";
import { TECHNIQUES, derive } from "@shared/build";
import { ARENA, nearestSawSlot, pitPhase, sawPhase } from "./arena";
import type { Bot } from "./bot";
import { inReachOf } from "./perception";
import { isBehind } from "./weapons";
import { angleOf, dist, dot, fromAngle, norm, sub, wrap } from "./math";

/**
 * The trained brain's view of a moment: plain numbers, no words. One vector for "me" and one per living
 * opponent, all relative to my own position and heading so the network does not have to learn rotation.
 *
 * The layout is part of the model's contract: changing it means retraining. FEATURE_VERSION is written into
 * every dataset and model file so a mismatch fails loudly instead of producing a confused bot.
 */

export const FEATURE_VERSION = 1;
/** Opponent slots. The roster has four bots, so at most three opponents. */
export const MAX_OPPS = 3;
/** Every maneuver in a fixed order; the network has one output per maneuver (masked to what is installed). */
export const MANEUVERS: Maneuver[] = TECHNIQUES.map((t) => t.m);
export const N_MANEUVERS = MANEUVERS.length;
export const MANEUVER_INDEX: Record<string, number> = Object.fromEntries(MANEUVERS.map((m, i) => [m, i]));

const HAMMER_PHASES = ["idle", "windup", "strike", "recover"] as const;
const PIT_PHASES = ["closed", "warning", "open"] as const;
const SAW_PHASES = ["down", "rising", "up"] as const;

const oneHot = (out: number[], n: number, i: number) => {
  for (let k = 0; k < n; k++) out.push(k === i ? 1 : 0);
};
const b = (x: boolean) => (x ? 1 : 0);

/** Vector `v` rotated into `me`'s frame: x = ahead, y = to my left. */
function local(me: Bot, v: { x: number; y: number }): { x: number; y: number } {
  const f = me.forward;
  return { x: v.x * f.x + v.y * f.y, y: -v.x * f.y + v.y * f.x };
}
function wallGap(p: { x: number; y: number }): number {
  return Math.min(ARENA.half - Math.abs(p.x), ARENA.half - Math.abs(p.y));
}
function buildStats(bot: Bot, out: number[]) {
  const s = bot.def.stats;
  const d = derive(bot.def.build);
  const L = bot.def.build.levels;
  out.push(s.mass / 2, s.maxSpeed / 6, s.accel / 15, s.turnRate / 4, s.armor, s.radius, s.knockResist, s.stunResist, s.impactResist, d.flipResist, s.cadence, s.awareness);
  out.push(L.power / 5, L.cycle / 5);
}

export function selfFeatures(me: Bot, bots: Bot[], time: number, timeLeft: number): number[] {
  const out: number[] = [];
  const w = me.weapon;
  oneHot(out, BOT_KINDS.length, BOT_KINDS.indexOf(me.kind));
  out.push(me.hpFrac, me.hp / 300);
  out.push(b(me.weaponReady), me.weaponCharge);
  oneHot(out, 4, me.kind === "hammer" ? HAMMER_PHASES.indexOf(w.hammerPhase) : -1);
  const maxHold = me.def.tuning.grabber.maxHold;
  out.push(b(!!me.holding), me.holding ? Math.max(0, maxHold - w.holdTime) / maxHold : 0);
  out.push(b(!!me.heldBy), b(me.airborne), Math.min(1, me.stun), Math.min(1, me.burn / 3));
  out.push(b(w.firing), b(w.boosting));
  // Where I am and how I am moving. World-frame position is fine: the hazards sit at fixed places.
  out.push(me.p.x / 10, me.p.y / 10, Math.hypot(me.p.x, me.p.y) / 14, Math.cos(me.heading), Math.sin(me.heading), wallGap(me.p) / 10);
  const v = local(me, me.vel);
  const k = local(me, me.knock);
  out.push(v.x / 6, v.y / 6, k.x / 6, k.y / 6);
  // Hazards, relative to my heading.
  const pit = pitPhase(time);
  oneHot(out, 3, PIT_PHASES.indexOf(pit));
  const pitRel = wrap(angleOf(sub(ARENA.pit.center, me.p)) - me.heading);
  out.push(Math.max(0, dist(me.p, ARENA.pit.center) - ARENA.pit.half) / 10, Math.cos(pitRel), Math.sin(pitRel));
  const saws = sawPhase(time);
  oneHot(out, 3, SAW_PHASES.indexOf(saws));
  const slot = nearestSawSlot(me.p);
  const sawRel = wrap(angleOf(sub(slot.center, me.p)) - me.heading);
  out.push(slot.d / 10, Math.cos(sawRel), Math.sin(sawRel));
  out.push(time / 180, timeLeft / 180, bots.filter((o) => o !== me && o.alive).length / MAX_OPPS);
  buildStats(me, out);
  // What I am doing now, so the network can value continuing (a flank half done) against switching.
  oneHot(out, N_MANEUVERS, MANEUVER_INDEX[me.intent.maneuver] ?? -1);
  return out;
}

export function oppFeatures(me: Bot, o: Bot, time: number): number[] {
  const out: number[] = [];
  const w = o.weapon;
  oneHot(out, BOT_KINDS.length, BOT_KINDS.indexOf(o.kind));
  out.push(o.hpFrac, o.hp / 300);
  const gap = Math.max(0, dist(me.p, o.p) - me.radius - o.radius);
  const rel = wrap(angleOf(sub(o.p, me.p)) - me.heading);
  const facingMe = dot(fromAngle(o.heading), norm(sub(me.p, o.p)));
  out.push(gap / 10, Math.cos(rel), Math.sin(rel), facingMe);
  const lp = local(me, sub(o.p, me.p));
  out.push(lp.x / 10, lp.y / 10);
  const ov = local(me, { x: o.vel.x + o.knock.x, y: o.vel.y + o.knock.y });
  out.push(ov.x / 6, ov.y / 6);
  const relVel = { x: o.vel.x + o.knock.x - me.vel.x - me.knock.x, y: o.vel.y + o.knock.y - me.vel.y - me.knock.y };
  out.push(-dot(relVel, norm(sub(o.p, me.p))) / 6);
  out.push(b(o.weaponReady), o.weaponCharge, b(o.kind === "hammer" && w.hammerPhase === "windup"), b(w.firing), b(w.boosting));
  out.push(b(o.airborne), Math.min(1, o.z / 2), Math.min(1, o.stun), b(!!o.heldBy), b(o.heldBy === me), b(o.holding === me), b(!!o.holding && o.holding !== me), Math.min(1, o.burn / 3));
  out.push(b(inReachOf(me, o)), b(o.alive && inReachOf(o, me)), b(isBehind(me, o)), b(isBehind(o, me)));
  out.push(Math.max(0, dist(o.p, ARENA.pit.center) - ARENA.pit.half) / 10, nearestSawSlot(o.p).d / 10, wallGap(o.p) / 10);
  out.push(o.def.stats.mass / 2, o.def.stats.armor, o.def.stats.maxSpeed / 6, o.def.stats.radius);
  // Grudges: did I hit them recently, did they hit me recently, and are they my current target.
  out.push(b(o.lastHitBy === me.id && time - o.lastHitAt < 3), b(me.lastHitBy === o.id && time - me.lastHitAt < 3), b(me.intent.target === o.id));
  return out;
}

export interface Encoded {
  self: Float32Array;
  /** MAX_OPPS rows of OPP_DIM, zero-padded. */
  opps: Float32Array;
  /** 1 for a real opponent slot. */
  oppMask: Float32Array;
  /** Bot ids in slot order. */
  oppIds: string[];
}

export function encode(me: Bot, bots: Bot[], time: number, timeLeft: number): Encoded {
  const others = bots.filter((o) => o !== me && o.alive).slice(0, MAX_OPPS);
  const self = Float32Array.from(selfFeatures(me, bots, time, timeLeft));
  if (self.length !== SELF_DIM) throw new Error(`self features: ${self.length} != ${SELF_DIM}`);
  const opps = new Float32Array(MAX_OPPS * OPP_DIM);
  const oppMask = new Float32Array(MAX_OPPS);
  others.forEach((o, i) => {
    const f = oppFeatures(me, o, time);
    if (f.length !== OPP_DIM) throw new Error(`opponent features: ${f.length} != ${OPP_DIM}`);
    opps.set(f, i * OPP_DIM);
    oppMask[i] = 1;
  });
  return { self, opps, oppMask, oppIds: others.map((o) => o.id) };
}

/* Vector sizes. Counted by hand from the pushes above; `encode` checks them on every call. */
function dims(): { self: number; opp: number } {
  const self = BOT_KINDS.length + 2 + 2 + 4 + 2 + 4 + 2 + 6 + 4 + 3 + 3 + 3 + 3 + 3 + 14 + N_MANEUVERS;
  const opp = BOT_KINDS.length + 2 + 4 + 2 + 2 + 1 + 5 + 8 + 4 + 3 + 4 + 3;
  return { self, opp };
}
export const SELF_DIM = dims().self;
export const OPP_DIM = dims().opp;

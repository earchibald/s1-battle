import { ARENA, insidePit, nearestSawSlot, pitPhase, sawPhase } from "./arena";
import type { Bot } from "./bot";
import { inReachOf } from "./perception";
import { FIRE_TECHNIQUES } from "@shared/build";
import { add, angleOf, clamp, dist, dot, fromAngle, len, norm, perp, scale, sub, wrap, type Vec } from "./math";

/**
 * Turns an Intent (what the brain wants) into throttle/steer/trigger (what the motors do), every tick.
 * Brains decide a few times a second; this runs at 60 Hz and handles steering, hazard avoidance,
 * and the reflex of firing a weapon when a target slides into reach during an aggressive maneuver.
 */

interface Drive {
  throttle: number;
  steer: number;
}

const HALF = ARENA.half;

function clampToArena(p: Vec, margin: number): Vec {
  return { x: clamp(p.x, -HALF + margin, HALF - margin), y: clamp(p.y, -HALF + margin, HALF - margin) };
}

/** Push a navigation point away from hazards that are live right now. */
function avoidHazards(me: Bot, point: Vec, time: number, ignorePit = false): Vec {
  let out = { ...point };
  const pit = pitPhase(time);
  if (!ignorePit && pit !== "closed") {
    const c = ARENA.pit.center;
    const keep = ARENA.pit.half + me.radius + 0.6;
    if (Math.abs(out.x - c.x) < keep && Math.abs(out.y - c.y) < keep) {
      // Slide the point out of the square along the shortest axis.
      const dx = out.x - c.x;
      const dy = out.y - c.y;
      if (Math.abs(dx) > Math.abs(dy) || Math.abs(dy) < 0.2) out.x = c.x + Math.sign(dx || 1) * keep;
      else out.y = c.y + Math.sign(dy || -1) * keep;
    }
    // Also: if I'm standing beside the pit and the path crosses it, steer around (cheap check at midpoint).
    const mid = scale(add(me.p, out), 0.5);
    if (insidePit(mid, -me.radius)) {
      const side = perp(norm(sub(out, me.p)));
      out = add(out, scale(side, Math.sign(side.x * (me.p.x - c.x) + side.y * (me.p.y - c.y)) * 3.5));
    }
  }
  const saws = sawPhase(time);
  if (saws !== "down") {
    for (const s of ARENA.saws.slots) {
      const kx = s.halfX + me.radius + 0.4;
      const ky = s.halfY + me.radius + 0.2;
      if (Math.abs(out.x - s.center.x) < kx && Math.abs(out.y - s.center.y) < ky) {
        out.x = s.center.x + Math.sign(out.x - s.center.x || me.p.x - s.center.x || 1) * kx;
      }
    }
  }
  return clampToArena(out, me.radius + 0.2);
}

function driveTo(me: Bot, point: Vec, speed = 1): Drive {
  const to = sub(point, me.p);
  const d = len(to);
  if (d < 0.25) return { throttle: 0, steer: 0 };
  const rel = wrap(angleOf(to) - me.heading);
  // Reverse when the point is behind us and close; cheaper than a full turn.
  if (Math.abs(rel) > 2.3 && d < 3.5) {
    const relBack = wrap(rel + Math.PI);
    return { throttle: -speed * 0.8, steer: clamp(-relBack * 2.5, -1, 1) };
  }
  const steer = clamp(rel * 2.6, -1, 1);
  const align = Math.cos(rel);
  const throttle = align > 0.35 ? speed * clamp(align + 0.25, 0.3, 1) : speed * 0.15;
  return { throttle, steer };
}

function face(me: Bot, point: Vec): Drive {
  const rel = wrap(angleOf(sub(point, me.p)) - me.heading);
  return { throttle: Math.abs(rel) < 0.2 ? 0 : 0.05, steer: clamp(rel * 3, -1, 1) };
}
/** Keep the nozzle on the target and keep closing slowly so the flame stays on it. */
function faceAndCreep(me: Bot, point: Vec): Drive {
  const rel = wrap(angleOf(sub(point, me.p)) - me.heading);
  const d = dist(me.p, point);
  return { throttle: d > 2.2 ? 0.45 : 0.1, steer: clamp(rel * 3, -1, 1) };
}

function orbitPoint(me: Bot, target: Bot, radius: number, dir: number): Vec {
  const toMe = norm(sub(me.p, target.p));
  const tangent = scale(perp(toMe), dir);
  // Aim a little ahead along the orbit, and pull in/out toward the desired radius.
  const d = dist(me.p, target.p);
  const radial = scale(toMe, clamp(radius - d, -1.5, 1.5) * 0.6);
  return add(add(target.p, scale(toMe, radius)), add(scale(tangent, 2.2), radial));
}

function flankPoint(me: Bot, target: Bot): Vec {
  // A spot behind the target; approach it from whichever side we're already on.
  const back = scale(fromAngle(target.heading), -(target.radius + me.radius + 1.0));
  const behind = add(target.p, back);
  const side = perp(fromAngle(target.heading));
  const sideSign = Math.sign(side.x * (me.p.x - target.p.x) + side.y * (me.p.y - target.p.y)) || 1;
  // If we're in front of the target, swing wide around the side first.
  const inFront = Math.cos(wrap(angleOf(sub(me.p, target.p)) - target.heading)) > 0.2;
  if (inFront) return add(target.p, scale(side, sideSign * (target.radius + me.radius + 2.6)));
  return behind;
}

/**
 * Herding: to push `target` toward `goal`, get on the far side of it first (the point behind the target
 * as seen from the goal), then drive through it toward the goal. Returns the nav point and whether we
 * are already lined up to push.
 */
function shovePlan(me: Bot, target: Bot, goal: Vec): { nav: Vec; pushing: boolean } {
  const away = norm(sub(target.p, goal)); // from goal, through target, toward where we want to be
  const toMe = norm(sub(me.p, target.p));
  const lined = dot(toMe, away) > 0.75;
  if (lined) {
    // Aim at a point just past the target on the goal line so we keep leaning on it.
    return { nav: add(target.p, scale(away, -(target.radius + 1.2))), pushing: true };
  }
  // Swing to the far side, around the target rather than through it.
  const standoff = target.radius + me.radius + 1.0;
  const side = perp(away);
  const sideSign = Math.sign(dot(side, toMe)) || 1;
  const mid = add(target.p, scale(add(away, scale(side, sideSign * 0.9)), standoff * 1.15));
  const far = add(target.p, scale(away, standoff));
  return { nav: dot(toMe, away) > 0.1 ? far : mid, pushing: false };
}

function retreatPoint(me: Bot, from: Vec | null, time: number): Vec {
  const away = from ? norm(sub(me.p, from)) : norm(scale(me.p, -1));
  // Bias toward the arena center so we don't pin ourselves in a corner.
  const toCenter = len(me.p) > 0.1 ? norm(scale(me.p, -1)) : { x: 0, y: 0 };
  const dir = norm(add(scale(away, 1), scale(toCenter, 0.55)));
  return avoidHazards(me, add(me.p, scale(dir, 5)), time);
}

export function control(me: Bot, bots: Bot[], time: number) {
  me.trigger = false;
  me.wantRelease = false;
  if (!me.controllable) {
    me.throttle = 0;
    me.steer = 0;
    return;
  }
  const intent = me.intent;
  const alive = bots.filter((b) => b !== me && b.alive);
  const target = alive.find((b) => b.id === intent.target) ?? alive.sort((a, b) => dist(a.p, me.p) - dist(b.p, me.p))[0] ?? null;
  const threat = alive
    .filter((o) => o.weaponReady && o.controllable)
    .sort((a, b) => dist(a.p, me.p) - dist(b.p, me.p))[0] ?? target;

  let drive: Drive = { throttle: 0, steer: 0 };
  let nav: Vec | null = null;
  const aggressive = intent.maneuver === "engage" || intent.maneuver === "flank" || FIRE_TECHNIQUES.includes(intent.maneuver);
  // A nervous bot drives harder and weaves a little; it reads as evasive on screen.
  const nerves = intent.danger > 0.65 ? 1 : 0;
  const weave = nerves ? Math.sin(time * 9) * 0.35 : 0;

  switch (intent.maneuver) {
    case "engage": {
      if (!target) break;
      // Aim slightly ahead of a moving target.
      const lead = add(target.p, scale(add(target.vel, target.knock), 0.18));
      nav = avoidHazards(me, lead, time);
      drive = driveTo(me, nav, 1);
      break;
    }
    case "flank": {
      if (!target) break;
      const facingMe = Math.cos(wrap(angleOf(sub(me.p, target.p)) - target.heading));
      const behind = dist(me.p, add(target.p, scale(fromAngle(target.heading), -(target.radius + me.radius + 1)))) < 1.2;
      // Once we're behind or they've turned away, this is just an engage.
      if (behind || facingMe < 0.1) {
        nav = avoidHazards(me, target.p, time);
        drive = driveTo(me, nav, 1);
      } else {
        nav = avoidHazards(me, flankPoint(me, target), time);
        drive = driveTo(me, nav, 1);
      }
      break;
    }
    case "circle": {
      if (!target) break;
      const dir = Math.sin(me.id.length + Math.floor(time / 4)) > 0 ? 1 : -1;
      nav = avoidHazards(me, orbitPoint(me, target, 4.2, dir), time);
      drive = driveTo(me, nav, 0.85);
      break;
    }
    case "retreat":
    case "spin_up": {
      nav = retreatPoint(me, threat?.p ?? null, time);
      drive = driveTo(me, nav, intent.maneuver === "spin_up" ? 0.7 : 1);
      // Spinning up: keep the blade pointed at whoever is nearest once we have space.
      if (intent.maneuver === "spin_up" && threat && dist(me.p, threat.p) > 5) drive = face(me, threat.p);
      break;
    }
    case "hold": {
      if (target) drive = face(me, target.p);
      break;
    }
    case "strike_now":
    case "grab_now":
    case "flip_now":
    case "burn":
    case "ram_now": {
      if (target) {
        if (me.kind === "ram") {
          // A charge: boost the whole way in while roughly lined up, lean on them once we arrive.
          const lead = add(target.p, scale(add(target.vel, target.knock), 0.15));
          nav = avoidHazards(me, lead, time);
          drive = driveTo(me, nav, 1);
          const rel = Math.abs(wrap(angleOf(sub(target.p, me.p)) - me.heading));
          me.trigger = rel < 0.5 && dist(me.p, target.p) < 7;
        } else if (inReachOf(me, target)) {
          drive = me.kind === "torch" ? faceAndCreep(me, target.p) : face(me, target.p);
          me.trigger = true;
        } else {
          nav = avoidHazards(me, target.p, time);
          drive = driveTo(me, nav, 1);
          // Fire the moment they come into reach.
          me.trigger = alive.some((o) => inReachOf(me, o));
        }
      }
      break;
    }
    case "shove_to_pit":
    case "shove_to_saws": {
      if (!target) break;
      const goal = intent.maneuver === "shove_to_pit" ? ARENA.pit.center : nearestSawSlot(target.p).center;
      const plan = shovePlan(me, target, goal);
      if (plan.pushing) {
        // We're behind the target relative to the hazard: drive through it. The hazard is for them, not us,
        // so stop short of following them in.
        const stop = intent.maneuver === "shove_to_pit" ? insidePit(me.p, -me.radius * 0.5) : false;
        nav = plan.nav;
        drive = stop ? { throttle: -1, steer: 0 } : driveTo(me, plan.nav, 1);
        const gap = dist(me.p, target.p) - me.radius - target.radius;
        me.trigger = gap < 1.6 && !stop;
      } else {
        nav = avoidHazards(me, plan.nav, time, intent.maneuver === "shove_to_pit");
        drive = driveTo(me, nav, 1);
      }
      break;
    }
    case "drag_to_pit": {
      if (!me.holding) break;
      const held = me.holding;
      if (insidePit(held.p, -0.1)) {
        // Victim is over the hole: let go and back off hard so we don't follow it in.
        me.wantRelease = true;
        drive = { throttle: -1, steer: 0 };
      } else {
        nav = ARENA.pit.center;
        drive = driveTo(me, nav, 0.9);
      }
      break;
    }
    case "drag_to_saws": {
      if (!me.holding) break;
      const held = me.holding;
      const slot = nearestSawSlot(held.p).center;
      const over = Math.abs(held.p.x - slot.x) < 0.8 && Math.abs(held.p.y - slot.y) < 3.0;
      if (over) drive = { throttle: 0, steer: 0 };
      else {
        nav = avoidHazards(me, slot, time, true);
        // The saws are a hazard for us too; we aim the victim (in front of us) at the slot center.
        const standoff = sub(slot, scale(me.forward, me.radius + held.radius - 0.2));
        drive = driveTo(me, standoff, 0.8);
        nav = standoff;
      }
      break;
    }
    case "crush": {
      drive = { throttle: 0, steer: 0 };
      break;
    }
    case "release": {
      me.wantRelease = true;
      drive = { throttle: -0.8, steer: 0 };
      break;
    }
  }

  // Reflex: during an aggressive maneuver, fire the one-shot weapon when something is in reach.
  // The hammer also fires from a hold, since that is the whole point of holding. Continuous weapons
  // (saw, spinner) need no trigger; the torch's reflex is to flame whatever drives into the cone.
  const continuous = me.kind === "saw" || me.kind === "spinner";
  if (!me.trigger && !continuous && me.weaponReady && (aggressive || (me.kind === "hammer" && intent.maneuver === "hold") || (me.kind === "torch" && intent.maneuver === "hold"))) {
    if (me.kind === "ram") {
      // The ram's reflex is to boost when a target is lined up a few meters ahead, so it arrives at speed.
      if (target && Math.abs(wrap(angleOf(sub(target.p, me.p)) - me.heading)) < 0.45 && dist(me.p, target.p) < 5.5 && !target.heldBy) me.trigger = true;
    } else if (alive.some((o) => inReachOf(me, o) && !o.heldBy)) me.trigger = true;
  }

  // Dragging slows us down; holding with a dead-weight victim is heavy work.
  const dragFactor = me.holding ? 0.62 : 1;
  me.throttle = clamp(drive.throttle * dragFactor * (1 + nerves * 0.1), -1, 1);
  me.steer = clamp(drive.steer + weave, -1, 1);
  me.navTarget = nav;
}

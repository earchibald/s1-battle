import type { BotSense, Facts, OpponentFacts } from "@shared/bots/common";
import type { Bearing, DistanceBucket, FacingMe, HealthBucket, OpponentView, Perception, TimeLeft } from "@shared/types";
import { ARENA, TRAP_NAMES, insidePit, liveTraps, nearestLiveTrap, nearestSawSlot, padPhase, pitPhase, sawPhase, shockPhase, trapGap, ventSweep, ventsPhase } from "./arena";
import type { Bot } from "./bot";
import { angleOf, dist, dot, fromAngle, norm, sub, wrap } from "./math";

/**
 * Builds what a bot "knows" at this instant, twice over:
 *  - Perception: the semantic, word-based state Jev reads. No raw numbers; buckets and plain English.
 *  - Facts: the same moment as numbers/booleans for the scripted brains and for validating Jev's answer.
 */

export function healthBucket(frac: number): HealthBucket {
  if (frac > 0.75) return "healthy";
  if (frac > 0.5) return "scratched";
  if (frac > 0.25) return "damaged";
  return "critical";
}
export function distanceBucket(gap: number): DistanceBucket {
  if (gap < 0.5) return "touching";
  if (gap < 2.6) return "close";
  if (gap < 6.5) return "medium";
  return "far";
}
export function bearingBucket(rel: number): Bearing {
  const a = Math.abs(rel);
  if (a < Math.PI / 8) return "dead ahead";
  if (a < (3 * Math.PI) / 8) return rel > 0 ? "ahead-left" : "ahead-right";
  if (a < (5 * Math.PI) / 8) return rel > 0 ? "left" : "right";
  if (a < (7 * Math.PI) / 8) return rel > 0 ? "behind-left" : "behind-right";
  return "directly behind";
}
export function facingBucket(c: number): FacingMe {
  if (c > 0.8) return "yes, pointed straight at me";
  if (c > 0.3) return "partly";
  return "no, turned away";
}
function zone(bot: Bot): Perception["me"]["position"] {
  const { x, y } = bot.p;
  const edge = ARENA.half - 3;
  const nx = Math.abs(x) > edge;
  const ny = Math.abs(y) > edge;
  if (nx && ny) return "in a corner";
  if (ny) return y > 0 ? "near the north wall" : "near the south wall";
  if (nx) return x > 0 ? "near the east wall" : "near the west wall";
  return "center of the arena";
}
function distanceWords(d: number): string {
  if (d < 1.5) return "right next to me";
  if (d < 4) return "a few meters away";
  if (d < 8) return "some distance away";
  return "far away";
}
function timeLeftBucket(t: number): TimeLeft {
  if (t <= 30) return "final 30 seconds";
  if (t <= ARENA.matchSeconds / 2) return "about half the match left";
  return "plenty of time";
}

function myWeaponState(bot: Bot): string {
  const w = bot.weapon;
  switch (bot.kind) {
    case "saw":
      if (w.spin > 0.9) return "blade at full speed";
      if (w.spin > 0.6) return "blade spinning fast, nearly full speed";
      if (w.spin > 0.3) return "blade spinning up, about half speed";
      return "blade barely turning";
    case "hammer":
      if (w.hammerPhase === "windup") return "hammer winding up";
      if (w.hammerPhase === "strike" || w.hammerPhase === "recover") return "hammer down after a strike";
      return w.cooldown > 0 ? `hammer recharging (${Math.ceil(w.cooldown)}s)` : "hammer raised and ready";
    case "grabber":
      if (bot.holding) return `jaws clamped on ${bot.holding.id}, ${Math.ceil(Math.max(0, bot.def.tuning.grabber.maxHold - w.holdTime))}s of grip left`;
      return w.cooldown > 0 ? `jaws recharging (${Math.ceil(w.cooldown)}s)` : "jaws open and ready";
    case "flipper":
      return w.cooldown > 0 ? `flipper recharging (${Math.ceil(w.cooldown)}s)` : "flipper charged and ready";
    case "spinner":
      if (w.spin > 0.9) return "bar at full speed";
      if (w.spin > 0.6) return "bar spinning fast, nearly full speed";
      if (w.spin > 0.3) return "bar spinning up, about half speed";
      return "bar barely turning";
    case "torch":
      if (w.firing) return `flame on, ${Math.round(w.spin * 100)}% fuel left`;
      if (w.spin > 0.7) return "fuel tank full, flame ready";
      if (w.spin > 0.25) return `about ${Math.round(w.spin * 100)}% fuel, flame ready`;
      return "fuel nearly out, refilling";
    case "ram":
      if (w.boosting) return "boosting";
      if (w.spin > 0.9) return "boost reserve full";
      if (w.spin > 0.5) return "boost reserve about half, ready";
      return "boost reserve low, refilling";
  }
}
/** ", standing on a shock plate that is about to fire" when it is, so Jev can dodge it or exploit it. */
function trapWords(bot: Bot, t: number): string {
  if (!bot.alive || bot.airborne) return "";
  const z = liveTraps(t).find((z) => trapGap(bot.p, z) < bot.radius * 0.3);
  if (!z) return "";
  return `, standing on a ${TRAP_NAMES[z.kind]} that is ${z.phase === "active" ? "firing" : "about to fire"}`;
}
function statusWords(bot: Bot): string {
  if (!bot.alive) return bot.eliminated === "pitted" ? "gone, fell in the pit" : "destroyed";
  const fire = bot.burn > 0 ? ", on fire" : "";
  if (bot.airborne) return "airborne, tumbling" + fire;
  if (bot.heldBy) return `held in ${bot.heldBy.id}'s jaws, cannot drive` + fire;
  if (bot.stun > 0) return "stunned, not moving" + fire;
  if (bot.holding) return `holding ${bot.holding.id} in the jaws` + fire;
  return "driving normally" + fire;
}
function theirWeaponState(o: Bot): string {
  const w = o.weapon;
  switch (o.kind) {
    case "saw":
      return w.spin > 0.6 ? "saw blade spinning at speed" : "saw blade slow, not dangerous yet";
    case "hammer":
      if (w.hammerPhase === "windup") return "hammer winding up to strike";
      return o.weaponReady ? "hammer raised and ready to strike" : "hammer down, recharging";
    case "grabber":
      if (o.holding) return `jaws busy holding ${o.holding.id}`;
      return o.weaponReady ? "jaws open and ready to grab" : "jaws recharging";
    case "flipper":
      return o.weaponReady ? "flipper charged and ready" : "flipper recharging";
    case "spinner":
      return w.spin > 0.6 ? "bar spinning at speed, do not touch" : "bar slow, not dangerous yet";
    case "torch":
      if (w.firing) return "flamethrower firing";
      return o.weaponReady ? "flamethrower has fuel" : "flamethrower out of fuel";
    case "ram":
      if (w.boosting) return "charging at full boost";
      return o.weaponReady ? "ram plate with boost in reserve" : "ram plate, boost spent";
  }
}

export function inReachOf(me: Bot, o: Bot): boolean {
  if (me.kind === "torch") return me.torchCovers(o);
  const { at, r } = me.weaponHitbox();
  return dist(at, o.p) < r + o.radius * 0.85 && !o.airborne;
}

/** How close a ready, facing opponent has to be before it counts as a threat, by its weapon. */
function threatRange(o: Bot, me: Bot): number {
  const base = o.kind === "torch" ? o.def.tuning.torch.range + 0.4 : o.kind === "ram" ? 3.4 : 2.6;
  return base + me.def.stats.awareness;
}

function opponentFacts(me: Bot, o: Bot, time: number): OpponentFacts {
  const to = sub(o.p, me.p);
  const d = dist(me.p, o.p);
  const relBearing = wrap(angleOf(to) - me.heading);
  const facingMe = dot(fromAngle(o.heading), norm(sub(me.p, o.p)));
  const gap = d - me.radius - o.radius;
  return {
    name: o.id,
    kind: o.kind,
    hpFrac: o.hpFrac,
    dist: Math.max(0, gap),
    relBearing,
    facingMe,
    weaponReady: o.weaponReady,
    airborne: o.airborne,
    stunned: o.stun > 0,
    heldBy: o.heldBy?.id ?? null,
    burning: o.burn > 0,
    inReach: inReachOf(me, o),
    threatening: o.weaponReady && facingMe > 0.7 && gap < threatRange(o, me) && o.controllable,
    trapDist: nearestLiveTrap(o.p, time)?.d ?? 99,
  };
}

function hazardWords(me: Bot, t: number): string {
  const parts: string[] = [];
  const pit = pitPhase(t);
  const pitD = dist(me.p, ARENA.pit.center) - ARENA.pit.half;
  if (pit !== "closed") {
    const rel = wrap(angleOf(sub(ARENA.pit.center, me.p)) - me.heading);
    parts.push(`the pit (${pit}) is ${distanceWords(pitD)}, ${bearingBucket(rel)}`);
  }
  const saws = sawPhase(t);
  const slot = nearestSawSlot(me.p);
  const rel = wrap(angleOf(sub(slot.center, me.p)) - me.heading);
  parts.push(`the nearest kill saw slot (${saws === "down" ? "retracted" : saws === "rising" ? "about to rise" : "up and spinning"}) is ${distanceWords(slot.d - 1)}, ${bearingBucket(rel)}`);
  // Traps only get a mention while they are telegraphing or firing, and only when they are near enough to matter.
  const trap = nearestLiveTrap(me.p, t);
  if (trap && trap.d < 6) {
    const z = trap.zone;
    const trel = wrap(angleOf(sub(z.center, me.p)) - me.heading);
    const where = trap.d < 0.2 ? "under me" : `${distanceWords(trap.d)}, ${bearingBucket(trel)}`;
    parts.push(`a ${TRAP_NAMES[z.kind]} (${z.phase === "active" ? "firing" : "about to fire"}) is ${where}`);
  }
  return parts.join("; ");
}

export function sense(me: Bot, bots: Bot[], time: number, timeLeft: number): BotSense {
  const opponents = bots.filter((b) => b !== me && b.alive);
  const facts: Facts = {
    hpFrac: me.hpFrac,
    weaponReady: me.weaponReady,
    weaponCharge: me.weaponCharge,
    holding: me.holding?.id ?? null,
    heldBy: me.heldBy?.id ?? null,
    airborne: me.airborne,
    stunned: me.stun > 0,
    burning: me.burn > 0,
    pitOpen: pitPhase(time) === "open",
    pitDist: Math.max(0, dist(me.p, ARENA.pit.center) - ARENA.pit.half),
    sawsUp: sawPhase(time) === "up",
    sawsSoon: sawPhase(time) === "rising",
    sawsDist: nearestSawSlot(me.p).d,
    trapLive: liveTraps(time).length > 0,
    trapDist: nearestLiveTrap(me.p, time)?.d ?? 99,
    timeLeft,
    opponents: opponents.map((o) => opponentFacts(me, o, time)),
  };

  const views: OpponentView[] = facts.opponents.map((f, i) => {
    const o = opponents[i];
    return {
      name: o.id,
      weapon: o.def.weapon,
      health: healthBucket(o.hpFrac),
      distance: distanceBucket(f.dist),
      bearing: bearingBucket(f.relBearing),
      facing_me: facingBucket(f.facingMe),
      status: statusWords(o) + trapWords(o, time),
      weapon_state: theirWeaponState(o),
    };
  });

  const pit = pitPhase(time);
  const saws = sawPhase(time);
  const vents = ventsPhase(time);
  const chargingPlate = ARENA.shock.plates.findIndex((_, i) => shockPhase(i, time) !== "idle");
  const perception: Perception = {
    me: {
      name: me.id,
      weapon: me.def.weapon,
      health: healthBucket(me.hpFrac),
      weapon_state: myWeaponState(me),
      position: zone(me),
      status: statusWords(me) + trapWords(me, time),
      nearest_hazard: hazardWords(me, time),
      ...(me.holding ? { holding: me.holding.id, held_bot_is_over_pit: insidePit(me.holding.p) ? "yes" : "no" } : {}),
    },
    opponents: views,
    arena: {
      pit: pit === "open" ? "open: any bot that drives or is dragged into it is eliminated" : pit === "warning" ? "about to open" : "closed",
      kill_saws: saws === "up" ? "up and spinning" : saws === "rising" ? "about to rise" : "retracted",
      flame_vents:
        vents === "idle"
          ? "quiet"
          : `row of floor vents south of center ${vents === "erupting" ? "erupting" : "about to erupt"} one after another, ${ventSweep(time)}: a bot on a lit vent burns and catches fire`,
      launch_pad: padPhase(time) === "charging" ? "charging, north of center: about to throw any bot standing on it north toward the pit" : "idle",
      shock_plates:
        chargingPlate < 0 ? "idle" : `${chargingPlate === 0 ? "north-west" : "north-east"} plate beside the pit is about to discharge: any bot on it is stunned and helpless for a moment`,
      time_left: timeLeftBucket(timeLeft),
    },
  };

  return { perception, facts };
}

import type { BotDef } from "@shared/bots/common";
import {
  ARENA,
  insidePit,
  onPad,
  onSaws,
  onShockPlate,
  onVent,
  padFireCount,
  padPhase,
  pitPhase,
  sawPhase,
  shockPhase,
  shockPulseCount,
  ventPhase,
  type PitPhase,
  type SawPhase,
} from "./arena";
import { Bot } from "./bot";
import { control } from "./controller";
import type { SimEvent } from "./events";
import { angleOf, clamp, dot, fromAngle, len, makeRng, norm, scale, sub, type Rng, type Vec } from "./math";
import { aabbExtents, obbContact } from "./obb";
import { applyDamage, destroy, ramSlam, releaseHold, updateBurn, updateWeapon, type WeaponContext } from "./weapons";

export type MatchPhase = "countdown" | "fighting" | "ended";

export interface MatchResult {
  winner: string | null;
  reason: "last_standing" | "judges" | "draw";
  standings: { id: string; hp: number; damageDealt: number; eliminated: string | null }[];
}

const GRAVITY = 24;
const LATERAL_GRIP = 9; // how quickly sideways slip is killed (tank treads)
const ROLL_FRICTION = 2.2;
const KNOCK_DECAY = 2.6;
const WALL_HURT_SPEED = 3.2;

/**
 * The whole simulation: bodies, weapons, hazards, and match rules. Deterministic for a given seed and
 * identical control inputs, so it can run headless for tuning as well as in the browser.
 */
export class World {
  readonly bots: Bot[] = [];
  readonly rng: Rng;
  time = 0;
  /** Time since the bell; hazards and the clock key off this. */
  fightTime = 0;
  phase: MatchPhase = "countdown";
  countdown = ARENA.countdownSeconds;
  result: MatchResult | null = null;
  matchNumber = 1;
  private events: SimEvent[] = [];
  private lastPit: PitPhase = "closed";
  private lastSaws: SawPhase = "down";
  private sawSparkTick = 0;
  // Trap bookkeeping. Primitives only, so World.clone copies them for free.
  private lastVents = "";
  private lastPadCharging = false;
  private lastPadFires = 0;
  private lastShockCharging = -1;
  private lastShockPulses = 0;

  constructor(lineup: BotDef[], seed = 1) {
    this.rng = makeRng(seed);
    lineup.forEach((def, i) => {
      const start = ARENA.starts[i % ARENA.starts.length];
      const heading = angleOf(scale(start, -1));
      this.bots.push(new Bot(def, start, heading));
    });
  }

  /**
   * An independent copy of the whole match state, for counterfactual rollouts ("what if this bot flanked
   * instead?"). The RNG stream is copied too, so a fork stepped with the same controls replays identically,
   * and sibling forks share their random numbers (common random numbers keep comparisons low-noise).
   * Defs are shared: they are read-only during a match.
   */
  clone(): World {
    // Writable view of the readonly/private fields that need fresh copies.
    const w = Object.assign(Object.create(World.prototype) as World, this) as unknown as { bots: Bot[]; rng: Rng; events: SimEvent[]; result: MatchResult | null };
    const map = new Map<Bot, Bot>();
    w.bots = this.bots.map((b) => {
      const c = b.cloneForFork();
      map.set(b, c);
      return c;
    });
    for (const c of w.bots) {
      c.heldBy = c.heldBy ? map.get(c.heldBy)! : null;
      c.holding = c.holding ? map.get(c.holding)! : null;
    }
    w.rng = makeRng(this.rng.state());
    w.events = [];
    w.result = this.result ? { ...this.result, standings: this.result.standings.map((s) => ({ ...s })) } : null;
    return w as unknown as World;
  }

  get timeLeft(): number {
    return Math.max(0, ARENA.matchSeconds - this.fightTime);
  }
  get alive(): Bot[] {
    return this.bots.filter((b) => b.alive);
  }
  bot(id: string): Bot | undefined {
    return this.bots.find((b) => b.id === id);
  }
  /** Drain events since the last call. */
  drainEvents(): SimEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }
  private emit(e: SimEvent) {
    this.events.push(e);
  }

  step(dt: number) {
    this.time += dt;
    if (this.phase === "countdown") {
      this.countdown -= dt;
      for (const b of this.bots) b.weapon.spin = Math.min(0.35, b.weapon.spin + dt * 0.2);
      if (this.countdown <= 0) {
        this.phase = "fighting";
        this.emit({ type: "match_start" });
      }
      return;
    }
    if (this.phase === "ended") {
      this.physics(dt, false);
      return;
    }
    this.fightTime += dt;
    const ctx: WeaponContext = this.ctx();

    for (const b of this.bots) {
      if (b.stun > 0) b.stun = Math.max(0, b.stun - dt);
      control(b, this.bots, this.fightTime);
    }
    this.physics(dt, true);
    for (const b of this.bots) updateWeapon(b, ctx, dt);
    for (const b of this.bots) updateBurn(b, ctx, dt);
    this.hazards(ctx, dt);
    this.checkEnd();
  }

  private physics(dt: number, live: boolean) {
    for (const b of this.bots) {
      if (b.eliminated === "pitted") {
        b.pitFall = Math.min(1, b.pitFall + dt * 0.8);
        continue;
      }
      const st = b.def.stats;
      if (b.heldBy) {
        // Pinned in the holder's jaws.
        const h = b.heldBy;
        const f = h.forward;
        // Victim's tail sits at the holder's nose, between the jaws.
        const off = h.footprint.front + b.footprint.back - 0.05;
        b.p = { x: h.p.x + f.x * off, y: h.p.y + f.y * off };
        b.vel = { x: 0, y: 0 };
        b.knock = { x: 0, y: 0 };
        b.heading += (Math.sin(this.time * 7) * 0.4 - (b.heading - h.heading) * 0.6) * dt * 2;
        continue;
      }
      if (live && b.controllable) {
        const f = b.forward;
        const fwd = dot(b.vel, f);
        const lat = b.vel.x * -f.y + b.vel.y * f.x;
        // Accelerate along heading toward throttle target, kill lateral slip, clamp speed.
        // A boosting ram goes faster and harder; a spinner's bar fights the turn (gyroscopic drag).
        const boost = b.kind === "ram" && b.weapon.boosting ? b.def.tuning.ram : null;
        const maxSpeed = st.maxSpeed * (boost ? boost.boostMul : 1);
        const accel = st.accel * (boost ? boost.accelMul : 1);
        const gyro = b.kind === "spinner" ? 1 - b.def.tuning.spinner.gyroDrag * b.weapon.spin : 1;
        const targetSpeed = b.throttle * maxSpeed;
        let nf = fwd + clamp(targetSpeed - fwd, -accel * dt, accel * dt);
        if (Math.abs(b.throttle) < 0.05) nf *= Math.exp(-ROLL_FRICTION * dt);
        const nl = lat * Math.exp(-(LATERAL_GRIP + b.def.build.levels.traction * 1.5) * dt);
        b.vel = { x: f.x * nf - f.y * nl, y: f.y * nf + f.x * nl };
        b.heading += b.steer * st.turnRate * gyro * dt * (0.55 + 0.45 * Math.min(1, Math.abs(nf) / st.maxSpeed + 0.5));
      } else {
        b.vel = scale(b.vel, Math.exp(-ROLL_FRICTION * 1.5 * dt));
      }
      if (!b.alive) b.vel = scale(b.vel, Math.exp(-6 * dt));

      // Knockback decays on its own.
      b.knock = scale(b.knock, Math.exp(-KNOCK_DECAY * dt));
      if (len(b.knock) < 0.02) b.knock = { x: 0, y: 0 };

      b.p = { x: b.p.x + (b.vel.x + b.knock.x) * dt, y: b.p.y + (b.vel.y + b.knock.y) * dt };

      if (b.airborne) {
        b.z += b.vz * dt;
        b.vz -= GRAVITY * dt;
        b.heading += dt * 2.5 * Math.sign(b.knock.x + 0.1);
        if (b.z <= 0) {
          b.z = 0;
          b.airborne = false;
          const impact = Math.abs(b.vz);
          b.vz = 0;
          if (impact > 4 && b.alive && live) {
            const by = b.launchedBy ? this.bot(b.launchedBy) ?? null : null;
            // Coming down from a big throw is a critical landing.
            const crit = impact > 10;
            applyDamage(this.ctx(), b, by, 3 + impact * 0.9, "landing", b.p, Math.min(1, impact / 10), crit);
            b.stunFor(crit ? 0.8 : 0.5);
          }
          b.launchedBy = null;
        }
      }
      this.walls(b, live);
    }
    this.collisions(live);
  }

  private ctx(): WeaponContext {
    return { bots: this.bots, time: this.fightTime, emit: (e) => this.emit(e), rng: () => this.rng.next() };
  }

  private walls(b: Bot, live: boolean) {
    // Keep the whole chassis box inside the arena: clamp its centre, then move the axle by the same amount.
    const box = b.obb();
    const ext = aabbExtents(box);
    let hit: Vec | null = null;
    let speed = 0;
    const total = { x: b.vel.x + b.knock.x, y: b.vel.y + b.knock.y };
    const limX = ARENA.half - ext.x;
    if (box.c.x < -limX || box.c.x > limX) {
      hit = { x: Math.sign(box.c.x) * ARENA.half, y: b.p.y };
      speed = Math.abs(total.x);
      b.p.x += clamp(box.c.x, -limX, limX) - box.c.x;
      b.vel.x *= -0.2;
      b.knock.x *= -0.35;
    }
    const limY = ARENA.half - ext.y;
    if (box.c.y < -limY || box.c.y > limY) {
      hit = { x: b.p.x, y: Math.sign(box.c.y) * ARENA.half };
      speed = Math.max(speed, Math.abs(total.y));
      b.p.y += clamp(box.c.y, -limY, limY) - box.c.y;
      b.vel.y *= -0.2;
      b.knock.y *= -0.35;
    }
    if (hit && live && speed > WALL_HURT_SPEED && b.alive) {
      const airborneMul = b.airborne || b.z > 0.2 ? 1.8 : 1;
      const dmg = (speed - WALL_HURT_SPEED) * 2.2 * airborneMul;
      const recent = this.fightTime - b.lastHitAt < 2.5 ? this.bot(b.lastHitBy ?? "") ?? null : null;
      this.emit({ type: "wall", bot: b.id, speed, at: hit });
      // Hitting the wall while airborne is a critical: nothing to brace with.
      const crit = airborneMul > 1 && speed > 5.5;
      applyDamage(this.ctx(), b, recent, dmg, "wall", hit, Math.min(1, speed / 9), crit);
    } else if (hit && live && speed > 1.2) {
      this.emit({ type: "wall", bot: b.id, speed, at: hit });
    }
  }

  private collisions(live: boolean) {
    const bs = this.bots.filter((b) => b.eliminated !== "pitted");
    for (let i = 0; i < bs.length; i++) {
      for (let j = i + 1; j < bs.length; j++) {
        const a = bs[i];
        const b = bs[j];
        if (a.airborne !== b.airborne) continue; // one flies over the other
        if (a.heldBy === b || b.heldBy === a) continue;
        // Chassis are oriented boxes, so bodies meet at their drawn edges instead of at a circle.
        const contact = obbContact(a.obb(), b.obb());
        if (!contact) continue;
        const n = contact.n;
        const overlap = contact.depth;
        const ma = a.alive ? a.mass : a.mass * 3;
        const mb = b.alive ? b.mass : b.mass * 3;
        const wa = mb / (ma + mb);
        const wb = ma / (ma + mb);
        a.p = sub(a.p, scale(n, overlap * wa));
        b.p = { x: b.p.x + n.x * overlap * wb, y: b.p.y + n.y * overlap * wb };
        const va = { x: a.vel.x + a.knock.x, y: a.vel.y + a.knock.y };
        const vb = { x: b.vel.x + b.knock.x, y: b.vel.y + b.knock.y };
        const relN = dot(sub(vb, va), n);
        if (relN < 0) {
          const e = 0.25;
          const jimp = (-(1 + e) * relN) / (1 / ma + 1 / mb);
          a.knock = sub(a.knock, scale(n, jimp / ma));
          b.knock = { x: b.knock.x + (n.x * jimp) / mb, y: b.knock.y + (n.y * jimp) / mb };
          if (!live) continue;
          // A ram plate meeting something front-on is a slam, not a bump.
          const ctx = this.ctx();
          const slamA = a.kind === "ram" && a.alive && b.alive && ramSlam(ctx, a, b, n, -relN);
          const slamB = b.kind === "ram" && b.alive && a.alive && ramSlam(ctx, b, a, { x: -n.x, y: -n.y }, -relN);
          // Hard shoves hurt a little; a ram plate shrugs most of it off.
          if (-relN > 5.5) {
            const dmg = (-relN - 5.5) * 0.8;
            if (a.alive && !slamB) applyDamage(ctx, a, b.alive ? b : null, dmg * (slamA ? 0.3 : 1), "wall", a.p, 0.3);
            if (b.alive && !slamA) applyDamage(ctx, b, a.alive ? a : null, dmg * (slamB ? 0.3 : 1), "wall", b.p, 0.3);
          }
        }
      }
    }
  }

  private hazards(ctx: WeaponContext, dt: number) {
    const t = this.fightTime;
    const pit = pitPhase(t);
    if (pit !== this.lastPit) {
      if (pit === "warning") this.emit({ type: "pit_warning" });
      if (pit === "open") this.emit({ type: "pit_open" });
      this.lastPit = pit;
    }
    const saws = sawPhase(t);
    if (saws !== this.lastSaws) {
      if (saws === "rising") this.emit({ type: "saws_rising" });
      if (saws === "up") this.emit({ type: "saws_up" });
      this.lastSaws = saws;
    }
    this.sawSparkTick += dt;
    const spark = this.sawSparkTick > 0.22;
    if (spark) this.sawSparkTick = 0;
    this.traps(ctx, dt, spark);

    for (const b of this.bots) {
      if (!b.alive) continue;
      if (pit === "open" && !b.airborne && insidePit(b.p, b.radius * 0.35)) {
        const by = b.heldBy?.id ?? (t - b.lastHitAt < 3 ? b.lastHitBy : null);
        if (b.heldBy) releaseHold(ctx, b.heldBy, "chosen");
        if (b.holding) releaseHold(ctx, b, "stunned");
        b.alive = false;
        b.eliminated = "pitted";
        b.vel = { x: 0, y: 0 };
        b.knock = { x: 0, y: 0 };
        if (by) {
          const killer = this.bot(by);
          if (killer) killer.stats.damageDealt += b.hp; // credit the remaining health
        }
        b.hp = 0;
        this.emit({ type: "pitted", bot: b.id, by, at: { ...b.p } });
        continue;
      }
      if (saws === "up" && !b.airborne && onSaws(b.p, b.radius)) {
        const by = b.heldBy ?? (t - b.lastHitAt < 2.5 ? this.bot(b.lastHitBy ?? "") ?? null : null);
        applyDamage(ctx, b, by, ARENA.saws.dps * dt, "saws", b.p, spark ? 0.7 : 0);
        // The blades chew and shove.
        b.knock.x += this.rng.range(-1, 1) * 6 * dt;
        b.knock.y += this.rng.range(-1, 1) * 6 * dt;
        if (!b.airborne && this.rng.next() < dt * 0.6 && b.alive && !b.heldBy) {
          b.airborne = true;
          b.vz = 3.5;
          b.launchedBy = by?.id ?? null;
        }
      }
    }
  }

  /** Whoever gets the credit when the arena hurts `b`: its holder, or a bot that hit it moments ago. */
  private creditFor(b: Bot, window = 3): Bot | null {
    if (b.heldBy) return b.heldBy;
    return this.fightTime - b.lastHitAt < window ? this.bot(b.lastHitBy ?? "") ?? null : null;
  }

  /** Flame vents, launch pad and shock plates. Timing comes from arena.ts; this applies it to the bots. */
  private traps(ctx: WeaponContext, dt: number, spark: boolean) {
    const t = this.fightTime;

    // Flame vents: continuous burn while a vent is lit.
    const V = ARENA.vents;
    const phases = V.slots.map((_, i) => ventPhase(i, t));
    const key = phases.map((p) => p[0]).join("");
    if (key !== this.lastVents) {
      const quiet = (k: string) => !/[we]/.test(k);
      if (quiet(this.lastVents) && !quiet(key)) this.emit({ type: "vents_warning" });
      phases.forEach((p, i) => {
        if (p === "erupting" && this.lastVents[i] !== "e") this.emit({ type: "vent_erupt", vent: i, at: { ...V.slots[i] } });
      });
      this.lastVents = key;
    }
    if (phases.includes("erupting")) {
      for (const b of this.bots) {
        if (!b.alive || b.airborne) continue;
        const i = onVent(b.p, b.radius);
        if (i < 0 || phases[i] !== "erupting") continue;
        const by = this.creditFor(b);
        if (t - b.ventedAt > 3) this.emit({ type: "trapped", trap: "vent", bot: b.id, by: by?.id ?? null, at: { ...b.p } });
        b.ventedAt = t;
        if (b.burn <= 0) b.burnBy = by?.id ?? null;
        b.burn = Math.max(b.burn, V.burnTime);
        applyDamage(ctx, b, by, V.dps * dt, "vent", b.p, spark ? 0.7 : 0);
      }
    }

    // Launch pad: one kick at the instant the charge completes.
    const P = ARENA.pad;
    const charging = padPhase(t) === "charging";
    if (charging && !this.lastPadCharging) this.emit({ type: "pad_warning", at: { ...P.center } });
    this.lastPadCharging = charging;
    const fires = padFireCount(t);
    if (fires !== this.lastPadFires) {
      this.lastPadFires = fires;
      let caught = 0;
      for (const b of this.bots) {
        if (!b.alive || b.airborne || !onPad(b.p, b.radius * 0.3)) continue;
        const by = this.creditFor(b);
        if (b.heldBy) releaseHold(ctx, b.heldBy, "stunned");
        if (b.holding) releaseHold(ctx, b, "stunned");
        // Heavy bots leave the pad more slowly and land shorter.
        const massFactor = Math.min(1, 1.25 / b.mass);
        b.airborne = true;
        b.vz = P.launchVz * massFactor;
        b.launchedBy = by?.id ?? null;
        b.vel = { x: 0, y: 0 };
        b.knock.x += P.dir.x * P.launchForward * massFactor;
        b.knock.y += P.dir.y * P.launchForward * massFactor;
        caught++;
        this.emit({ type: "trapped", trap: "pad", bot: b.id, by: by?.id ?? null, at: { ...b.p } });
      }
      this.emit({ type: "pad_fire", at: { ...P.center }, caught });
    }

    // Shock plates: one discharge per pulse, alternating plates.
    const S = ARENA.shock;
    const chargingPlate = S.plates.findIndex((_, i) => shockPhase(i, t) === "charging");
    if (chargingPlate !== this.lastShockCharging) {
      if (chargingPlate >= 0) this.emit({ type: "shock_warning", plate: chargingPlate, at: { ...S.plates[chargingPlate].center } });
      this.lastShockCharging = chargingPlate;
    }
    const pulses = shockPulseCount(t);
    if (pulses !== this.lastShockPulses) {
      this.lastShockPulses = pulses;
      const plate = (pulses - 1) % S.plates.length;
      let caught = 0;
      for (const b of this.bots) {
        if (!b.alive || b.airborne || !onShockPlate(b.p, b.radius, plate)) continue;
        const by = this.creditFor(b);
        caught++;
        this.emit({ type: "trapped", trap: "shock", bot: b.id, by: by?.id ?? null, at: { ...b.p } });
        b.stunFor(S.stun);
        applyDamage(ctx, b, by, S.damage, "shock", b.p, 1);
      }
      this.emit({ type: "shock_fire", plate, at: { ...S.plates[plate].center }, caught });
    }
  }

  private checkEnd() {
    const alive = this.alive;
    if (alive.length <= 1) {
      this.finish(alive[0]?.id ?? null, alive.length === 1 ? "last_standing" : "draw");
      return;
    }
    if (this.timeLeft <= 0) {
      // Judges' decision: health first, damage dealt as tiebreak.
      const ranked = alive.slice().sort((a, b) => b.hpFrac - a.hpFrac || b.stats.damageDealt - a.stats.damageDealt);
      this.finish(ranked[0].id, "judges");
    }
  }

  private finish(winner: string | null, reason: MatchResult["reason"]) {
    this.phase = "ended";
    const standings = this.bots
      .slice()
      .sort((a, b) => Number(b.alive) - Number(a.alive) || b.hp - a.hp || b.stats.damageDealt - a.stats.damageDealt)
      .map((b) => ({ id: b.id, hp: Math.max(0, Math.round(b.hp)), damageDealt: Math.round(b.stats.damageDealt), eliminated: b.eliminated }));
    this.result = { winner, reason, standings };
    for (const b of this.bots) {
      b.throttle = 0;
      b.steer = 0;
      b.trigger = false;
      if (b.holding) releaseHold(this.ctx(), b, "chosen");
    }
    this.emit({ type: "match_end", winner, reason });
  }
}

export { fromAngle, norm };

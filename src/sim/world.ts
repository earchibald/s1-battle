import type { BotDef } from "@shared/bots/common";
import { ARENA, insidePit, onSaws, pitPhase, sawPhase, type PitPhase, type SawPhase } from "./arena";
import { Bot } from "./bot";
import { control } from "./controller";
import type { SimEvent } from "./events";
import { angleOf, clamp, dot, fromAngle, len, makeRng, norm, scale, sub, type Rng, type Vec } from "./math";
import { applyDamage, destroy, releaseHold, updateWeapon, type WeaponContext } from "./weapons";

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

  constructor(lineup: BotDef[], seed = 1) {
    this.rng = makeRng(seed);
    lineup.forEach((def, i) => {
      const start = ARENA.starts[i % ARENA.starts.length];
      const heading = angleOf(scale(start, -1));
      this.bots.push(new Bot(def, start, heading));
    });
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
    const ctx: WeaponContext = { bots: this.bots, time: this.fightTime, emit: (e) => this.emit(e) };

    for (const b of this.bots) {
      if (b.stun > 0) b.stun = Math.max(0, b.stun - dt);
      control(b, this.bots, this.fightTime);
    }
    this.physics(dt, true);
    for (const b of this.bots) updateWeapon(b, ctx, dt);
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
        const off = h.radius + b.radius - 0.35;
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
        const targetSpeed = b.throttle * st.maxSpeed;
        let nf = fwd + clamp(targetSpeed - fwd, -st.accel * dt, st.accel * dt);
        if (Math.abs(b.throttle) < 0.05) nf *= Math.exp(-ROLL_FRICTION * dt);
        const nl = lat * Math.exp(-LATERAL_GRIP * dt);
        b.vel = { x: f.x * nf - f.y * nl, y: f.y * nf + f.x * nl };
        b.heading += b.steer * st.turnRate * dt * (0.55 + 0.45 * Math.min(1, Math.abs(nf) / st.maxSpeed + 0.5));
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
            applyDamage(this.ctx(), b, by, 3 + impact * 0.9, "landing", b.p, Math.min(1, impact / 10));
            b.stun = Math.max(b.stun, 0.5);
          }
          b.launchedBy = null;
        }
      }
      this.walls(b, live);
    }
    this.collisions(live);
  }

  private ctx(): WeaponContext {
    return { bots: this.bots, time: this.fightTime, emit: (e) => this.emit(e) };
  }

  private walls(b: Bot, live: boolean) {
    const lim = ARENA.half - b.radius;
    let hit: Vec | null = null;
    let speed = 0;
    const total = { x: b.vel.x + b.knock.x, y: b.vel.y + b.knock.y };
    if (b.p.x < -lim || b.p.x > lim) {
      hit = { x: Math.sign(b.p.x) * ARENA.half, y: b.p.y };
      speed = Math.abs(total.x);
      b.p.x = clamp(b.p.x, -lim, lim);
      b.vel.x *= -0.2;
      b.knock.x *= -0.35;
    }
    if (b.p.y < -lim || b.p.y > lim) {
      hit = { x: b.p.x, y: Math.sign(b.p.y) * ARENA.half };
      speed = Math.max(speed, Math.abs(total.y));
      b.p.y = clamp(b.p.y, -lim, lim);
      b.vel.y *= -0.2;
      b.knock.y *= -0.35;
    }
    if (hit && live && speed > WALL_HURT_SPEED && b.alive) {
      const airborneMul = b.airborne || b.z > 0.2 ? 1.8 : 1;
      const dmg = (speed - WALL_HURT_SPEED) * 2.2 * airborneMul;
      const recent = this.fightTime - b.lastHitAt < 2.5 ? this.bot(b.lastHitBy ?? "") ?? null : null;
      this.emit({ type: "wall", bot: b.id, speed, at: hit });
      applyDamage(this.ctx(), b, recent, dmg, "wall", hit, Math.min(1, speed / 9));
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
        const d = sub(b.p, a.p);
        const dist = len(d);
        const minD = a.radius + b.radius;
        if (dist >= minD || dist < 1e-6) continue;
        const n = scale(d, 1 / dist);
        const overlap = minD - dist;
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
          // Hard shoves hurt a little; the wedge-shaped bots take less.
          if (live && -relN > 5.5) {
            const dmg = (-relN - 5.5) * 0.8;
            if (a.alive) applyDamage(this.ctx(), a, b.alive ? b : null, dmg, "wall", a.p, 0.3);
            if (b.alive) applyDamage(this.ctx(), b, a.alive ? a : null, dmg, "wall", b.p, 0.3);
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

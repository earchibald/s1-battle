import type { BotDef } from "@shared/bots/common";
import type { Footprint } from "@shared/build";
import type { BotKind, Intent } from "@shared/types";
import type { Vec } from "./math";
import { fromAngle } from "./math";
import { makeObb, type Obb } from "./obb";

export type HammerPhase = "idle" | "windup" | "strike" | "recover";

export interface WeaponState {
  /** saw/spinner: blade or bar spin 0..1. torch: fuel 0..1. ram: boost reserve 0..1. Others: unused (see cooldown). */
  spin: number;
  /** One-shot weapons: seconds until usable again. */
  cooldown: number;
  /** Total cooldown length, so the HUD can show a recharge fraction. */
  cooldownMax: number;
  hammerPhase: HammerPhase;
  /** Generic phase timer (hammer phases, flipper plate animation). */
  timer: number;
  /** Flipper plate animation 0..1 (1 = fully fired). */
  flipAnim: number;
  /** Per-victim hit throttle so the saw doesn't deal damage every physics tick. */
  hitCooldowns: Map<string, number>;
  /** How long the grabber has held its current victim. */
  holdTime: number;
  /** Crush tick accumulator for periodic spark events. */
  crushTick: number;
  /** Grabber: current hold was taken from behind, so crush ticks are critical. */
  critHold: boolean;
  /** Torch: flame is out of the nozzle this tick. */
  firing: boolean;
  /** Ram: boost is burning this tick. */
  boosting: boolean;
  /** Burn-tick accumulator for a bot that is on fire. */
  burnTick: number;
}

export interface BotStatsSheet {
  damageDealt: number;
  damageTaken: number;
  hits: number;
  decisions: number;
  jevDecisions: number;
}

export type Elimination = null | "destroyed" | "pitted";

/** One robot: physical body, health, weapon state, and the last intent its brain produced. */
export class Bot {
  readonly id: string;
  readonly kind: BotKind;
  readonly def: BotDef;

  p: Vec;
  /** Velocity under the bot's own power. */
  vel: Vec = { x: 0, y: 0 };
  /** Velocity imparted by hits; decays on its own and ignores the speed cap. */
  knock: Vec = { x: 0, y: 0 };
  heading: number;
  z = 0;
  vz = 0;
  airborne = false;

  hp: number;
  alive = true;
  eliminated: Elimination = null;
  /** Seconds of remaining stun. */
  stun = 0;
  heldBy: Bot | null = null;
  holding: Bot | null = null;
  /** Who most recently damaged us and when, for kill attribution. */
  lastHitBy: string | null = null;
  lastHitAt = -Infinity;
  /** Who launched us into the air, for landing-damage attribution. */
  launchedBy: string | null = null;
  /** 0..1 animation progress when falling into the pit. */
  pitFall = 0;
  /** Timestamps for renderer flashes. */
  lastDamagedAt = -Infinity;
  /** Seconds left on fire (flamethrower), and who lit it. */
  burn = 0;
  burnBy: string | null = null;

  weapon: WeaponState = {
    spin: 0,
    cooldown: 0,
    cooldownMax: 1,
    hammerPhase: "idle",
    timer: 0,
    flipAnim: 0,
    hitCooldowns: new Map(),
    holdTime: 0,
    crushTick: 0,
    critHold: false,
    firing: false,
    boosting: false,
    burnTick: 0,
  };

  // Controls written by the controller each tick, read by the physics/weapon update.
  throttle = 0;
  steer = 0;
  trigger = false;
  wantRelease = false;

  intent: Intent;
  /** Where the controller is currently steering toward, for debug rendering. */
  navTarget: Vec | null = null;

  stats: BotStatsSheet = { damageDealt: 0, damageTaken: 0, hits: 0, decisions: 0, jevDecisions: 0 };

  constructor(def: BotDef, start: Vec, heading: number) {
    this.def = def;
    this.id = def.name;
    this.kind = def.kind;
    this.p = { ...start };
    this.heading = heading;
    this.hp = def.stats.hp;
    this.intent = {
      target: null,
      maneuver: "hold",
      danger: 0,
      source: "baseline",
      confidence: 1,
      probabilities: {},
      targetProbabilities: {},
      latencyMs: 0,
      note: "waiting for the bell",
    };
  }

  /** Rough size for ranges, perception and hazards. Collisions use `obb()` instead. */
  get radius(): number {
    return this.def.stats.radius;
  }
  get footprint(): Footprint {
    return this.def.stats.footprint;
  }
  /** The chassis as an oriented box at the current pose. */
  obb(): Obb {
    return makeObb(this.p, this.heading, this.footprint);
  }
  get mass(): number {
    return this.def.stats.mass;
  }
  get hpFrac(): number {
    return Math.max(0, this.hp / this.def.stats.hp);
  }
  get forward(): Vec {
    return fromAngle(this.heading);
  }
  /** Can this bot drive right now? */
  get controllable(): boolean {
    return this.alive && !this.airborne && this.stun <= 0 && !this.heldBy;
  }
  get weaponReady(): boolean {
    switch (this.kind) {
      case "saw":
        return this.weapon.spin > 0.6;
      case "hammer":
        return this.weapon.hammerPhase === "idle" && this.weapon.cooldown <= 0;
      case "grabber":
        return !this.holding && this.weapon.cooldown <= 0;
      case "flipper":
        return this.weapon.cooldown <= 0;
      case "spinner":
        return this.weapon.spin > 0.6;
      case "torch":
        return this.weapon.spin > 0.25;
      case "ram":
        return this.weapon.spin > 0.5;
    }
  }
  /** Knockback scale after traction. Hits call this instead of poking `knock` directly. */
  shove(x: number, y: number) {
    const k = 1 - this.def.stats.knockResist;
    this.knock.x += x * k;
    this.knock.y += y * k;
  }
  /** Stun after the gyro has had its say. */
  stunFor(seconds: number) {
    this.stun = Math.max(this.stun, seconds * (1 - this.def.stats.stunResist));
  }
  /** Is `o` inside the flame cone right now? */
  torchCovers(o: Bot): boolean {
    if (o.airborne) return false;
    const T = this.def.tuning.torch;
    const f = this.forward;
    const nx = this.p.x + f.x * this.radius * 0.8;
    const ny = this.p.y + f.y * this.radius * 0.8;
    const dx = o.p.x - nx;
    const dy = o.p.y - ny;
    const d = Math.hypot(dx, dy);
    if (d > T.range + o.radius * 0.6) return false;
    if (d < 1e-6) return true;
    const cos = (dx * f.x + dy * f.y) / d;
    // Allow the cone to widen with the target's own size so a touching bot always counts.
    return cos > Math.cos(T.halfAngle + Math.min(0.6, (o.radius * 0.7) / Math.max(0.5, d)));
  }
  /** 0..1 readiness for the HUD. */
  get weaponCharge(): number {
    if (this.kind === "saw" || this.kind === "spinner" || this.kind === "torch" || this.kind === "ram") return this.weapon.spin;
    if (this.weapon.cooldownMax <= 0) return 1;
    return 1 - Math.min(1, Math.max(0, this.weapon.cooldown / this.weapon.cooldownMax));
  }
  /** Weapon hitbox center (world) and radius for the kind. */
  weaponHitbox(): { at: Vec; r: number } {
    const f = this.forward;
    const R = this.radius;
    switch (this.kind) {
      case "saw":
        return { at: { x: this.p.x + f.x * (R + 0.25), y: this.p.y + f.y * (R + 0.25) }, r: 0.55 };
      case "hammer":
        return { at: { x: this.p.x + f.x * (R + 0.95), y: this.p.y + f.y * (R + 0.95) }, r: 0.8 };
      case "grabber":
        return { at: { x: this.p.x + f.x * (R + 0.6), y: this.p.y + f.y * (R + 0.6) }, r: 0.7 };
      case "flipper":
        return { at: { x: this.p.x + f.x * (R + 0.65), y: this.p.y + f.y * (R + 0.65) }, r: 0.85 };
      case "spinner":
        // The bar sweeps the whole front half: a big disc centred just ahead of the axle.
        return { at: { x: this.p.x + f.x * (R * 0.5), y: this.p.y + f.y * (R * 0.5) }, r: R * 0.6 + 0.45 };
      case "torch": {
        const range = this.def.tuning.torch.range;
        return { at: { x: this.p.x + f.x * (R * 0.8 + range * 0.5), y: this.p.y + f.y * (R * 0.8 + range * 0.5) }, r: range * 0.5 };
      }
      case "ram":
        return { at: { x: this.p.x + f.x * (R + 0.55), y: this.p.y + f.y * (R + 0.55) }, r: 0.75 };
    }
  }
}

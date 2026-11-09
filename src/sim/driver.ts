import type { BotDef } from "@shared/bots/common";
import type { Intent } from "@shared/types";
import type { Bot } from "./bot";
import type { SimEvent } from "./events";
import { sense } from "./perception";
import { World } from "./world";

/**
 * Headless match driver: a World plus each bot's decision timer and a synchronous policy per bot. It is the
 * piece the tuning scripts, the training-data generator and the tournament share, and it can fork itself
 * mid-match so a generator can ask "what if this bot did X for the next second?".
 */

export const DT = 1 / 60;
const MAX_STEPS = 60 * 400;

/** A brain that answers immediately: baseline rule trees and the trained network both fit. */
export type Policy = (bot: Bot, world: World) => Intent;

export const baselinePolicy: Policy = (bot, w) => bot.def.baseline(sense(bot, w.bots, w.fightTime, w.timeLeft));

/** Events that make a bot rethink right away instead of waiting for its next tick (the browser does this too). */
export function isUrgent(e: SimEvent, bot: Bot): boolean {
  const id = bot.id;
  return (
    (e.type === "hit" && e.victim === id && e.amount > 6) ||
    (e.type === "grab" && (e.bot === id || e.victim === id)) ||
    (e.type === "release" && (e.bot === id || e.victim === id)) ||
    (e.type === "flip" && e.victim === id) ||
    ((e.type === "destroyed" || e.type === "pitted") && bot.intent.target === e.bot) ||
    e.type === "pit_open"
  );
}

export interface DriverOptions {
  /** Seconds between decisions for every bot; default: each bot's own (its sensors level). */
  cadence?: number;
  /** Rethink early on urgent events, like the browser's brains. Off for the balance scripts. */
  nudges?: boolean;
  onDecision?(bot: Bot, intent: Intent, world: World): void;
}

export class Driver {
  world: World;
  readonly policyFor: (bot: Bot) => Policy;
  readonly opts: DriverOptions;
  /** Seconds until each bot's next decision. */
  timers: Map<string, number>;
  /** Intents forced on a bot until fight time `until`; its policy is not consulted meanwhile. */
  pins = new Map<string, { intent: Intent; until: number }>();
  steps = 0;

  constructor(world: World, policyFor: (bot: Bot) => Policy, opts: DriverOptions = {}, timers?: Map<string, number>) {
    this.world = world;
    this.policyFor = policyFor;
    this.opts = opts;
    this.timers = timers ?? new Map(world.bots.map((b) => [b.id, 0]));
  }

  /** A new match. First decisions are staggered deterministically from the seed. */
  static start(lineup: BotDef[], seed: number, policyFor: (bot: Bot) => Policy, opts: DriverOptions = {}): Driver {
    const w = new World(lineup, seed);
    const d = new Driver(w, policyFor, opts);
    w.bots.forEach((b, i) => d.timers.set(b.id, (((seed * 7 + i * 13) % 10) / 10) * d.cadenceOf(b)));
    return d;
  }

  cadenceOf(b: Bot): number {
    return this.opts.cadence ?? b.def.stats.cadence;
  }

  get over(): boolean {
    return this.world.phase === "ended" || this.steps >= MAX_STEPS;
  }

  /** One physics tick plus any decisions that fall due. Returns the tick's events. */
  step(): SimEvent[] {
    const w = this.world;
    w.step(DT);
    this.steps++;
    if (w.phase !== "fighting") return w.drainEvents();
    for (const b of w.bots) {
      if (!b.alive) continue;
      const t = this.timers.get(b.id)! - DT;
      if (t > 0) {
        this.timers.set(b.id, t);
        continue;
      }
      this.timers.set(b.id, this.cadenceOf(b));
      this.decide(b);
    }
    const events = w.drainEvents();
    if (this.opts.nudges) {
      for (const e of events) for (const b of w.bots) if (b.alive && isUrgent(e, b)) this.timers.set(b.id, Math.min(this.timers.get(b.id)!, 0.08));
    }
    return events;
  }

  decide(b: Bot) {
    const pin = this.pins.get(b.id);
    if (pin && this.world.fightTime < pin.until) {
      b.intent = pin.intent;
      return;
    }
    if (pin) this.pins.delete(b.id);
    const intent = this.policyFor(b)(b, this.world);
    b.intent = intent;
    b.stats.decisions++;
    this.opts.onDecision?.(b, intent, this.world);
  }

  run(): World {
    while (!this.over) this.step();
    return this.world;
  }

  /** An independent copy: world, timers and pins. Decision hooks are not carried over. */
  fork(policyFor = this.policyFor): Driver {
    const d = new Driver(this.world.clone(), policyFor, { ...this.opts, onDecision: undefined }, new Map(this.timers));
    d.pins = new Map(this.pins);
    d.steps = this.steps;
    return d;
  }
}

import type { BotSense } from "@shared/bots/common";
import { styleOf } from "@shared/build";
import { interpretAnswers } from "@shared/logic";
import type { DecideError, DecideResponse, Intent } from "@shared/types";
import type { Bot } from "../sim/bot";
import { isUrgent } from "../sim/driver";
import type { SimEvent } from "../sim/events";
import { makeRng } from "../sim/math";
import { sense } from "../sim/perception";
import type { World } from "../sim/world";
import type { TrainedNet } from "./trained/net";
import { decideTrained, type TrainedDecision } from "./trained/policy";

/**
 * Brains decide; controllers drive. A brain is polled every `cadence` seconds (and nudged early by
 * notable events) and hands the bot a fresh Intent. The Jev brain is asynchronous: it sends the
 * bot's Perception to the server, which asks Jev, and applies the answer when it comes back,
 * unless the world has moved on so far that the answer is stale. The trained brain is a small local network
 * (src/brain/trained) that answers synchronously in well under a millisecond.
 */

export type BrainMode = "jev" | "trained" | "baseline";
export const BRAIN_MODES: BrainMode[] = ["jev", "trained", "baseline"];

export interface BrainStatus {
  mode: BrainMode;
  inFlight: boolean;
  lastLatencyMs: number;
  avgLatencyMs: number;
  decisions: number;
  fallbacks: number;
  lastError: string | null;
}

export interface BrainOptions {
  /** Seconds between decisions when the build does not say (sensors level sets it per bot). */
  cadence: number;
  decideUrl: string;
}

export class Brain {
  mode: BrainMode;
  readonly bot: Bot;
  private timer = 0;
  private inFlight = false;
  private seq = 0;
  private latencies: number[] = [];
  status: BrainStatus;
  readonly opts: BrainOptions;
  /** Set by the UI when the server reports Jev is unavailable, so every brain falls back silently. */
  static jevAvailable = true;
  /** The trained brain's network, once /models/trained-brain.json has loaded. */
  static trainedNet: TrainedNet | null = null;
  /** The trained brain's last full decision (every scored option), for the Garage readout. */
  lastTrained: TrainedDecision | null = null;
  private rng = makeRng((Math.random() * 2 ** 31) | 0);

  constructor(bot: Bot, mode: BrainMode, opts: BrainOptions) {
    this.bot = bot;
    this.mode = mode;
    this.opts = opts;
    // Stagger first decisions so four requests don't fire on the same frame.
    this.timer = Math.random() * this.cadence;
    this.status = { mode, inFlight: false, lastLatencyMs: 0, avgLatencyMs: 0, decisions: 0, fallbacks: 0, lastError: null };
  }

  /** Seconds between decisions for this bot: its sensors level, else the default. */
  get cadence(): number {
    return this.bot.def.stats.cadence || this.opts.cadence;
  }

  /** Events that should make a bot rethink right away rather than wait for the next tick. */
  nudge(e: SimEvent) {
    if (isUrgent(e, this.bot)) this.timer = Math.min(this.timer, 0.08);
  }

  /** What actually drives the bot right now: Jev falls back to the trained brain (or baseline) when offline. */
  get effectiveMode(): BrainMode {
    if (this.mode === "jev" && !Brain.jevAvailable) return Brain.trainedNet ? "trained" : "baseline";
    if (this.mode === "trained" && !Brain.trainedNet) return "baseline";
    return this.mode;
  }

  update(world: World, dt: number, emit: (e: SimEvent) => void) {
    if (world.phase !== "fighting" || !this.bot.alive) return;
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = this.cadence;
    const mode = this.effectiveMode;
    if (mode === "trained") {
      const d = decideTrained(Brain.trainedNet!, this.bot, world, styleOf(this.bot.def.build), this.rng);
      this.lastTrained = d;
      this.status.lastLatencyMs = d.micros / 1000;
      this.apply(d.intent, emit);
      return;
    }
    const s = sense(this.bot, world.bots, world.fightTime, world.timeLeft);
    if (mode === "baseline") {
      this.apply(this.bot.def.baseline(s), emit);
      return;
    }
    if (this.inFlight) return; // the previous answer is still on its way; don't pile up
    void this.askJev(world, s, emit);
  }

  private apply(intent: Intent, emit: (e: SimEvent) => void) {
    const changed = intent.maneuver !== this.bot.intent.maneuver || intent.target !== this.bot.intent.target;
    this.bot.intent = intent;
    this.bot.stats.decisions++;
    if (intent.source === "jev") this.bot.stats.jevDecisions++;
    if (intent.source === "trained") this.bot.stats.trainedDecisions++;
    this.status.decisions++;
    if (changed) emit({ type: "decision", bot: this.bot.id, note: intent.note, source: intent.source });
  }

  private async askJev(world: World, s: BotSense, emit: (e: SimEvent) => void) {
    const mySeq = ++this.seq;
    const askedAt = world.fightTime;
    this.inFlight = true;
    this.status.inFlight = true;
    try {
      const res = await fetch(this.opts.decideUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // The bot's editable brain rides along: the server is stateless and builds the questions from it.
        body: JSON.stringify({ kind: this.bot.kind, sense: s, build: this.bot.def.build }),
      });
      const data = (await res.json()) as DecideResponse | DecideError;
      if (!data.ok) throw new Error(data.error);
      this.latencies.push(data.latencyMs);
      if (this.latencies.length > 30) this.latencies.shift();
      this.status.lastLatencyMs = data.latencyMs;
      this.status.avgLatencyMs = Math.round(this.latencies.reduce((a, b) => a + b, 0) / this.latencies.length);
      this.status.lastError = null;
      // Stale guard: if the world moved on by more than a second, re-sense instead of acting on the past.
      if (mySeq !== this.seq || !this.bot.alive) return;
      if (world.fightTime - askedAt > 1.2) {
        this.timer = 0;
        return;
      }
      const fresh = sense(this.bot, world.bots, world.fightTime, world.timeLeft);
      this.apply(interpretAnswers(this.bot.def.build, fresh, data.answers, data.latencyMs), emit);
    } catch (err) {
      this.status.fallbacks++;
      this.status.lastError = err instanceof Error ? err.message : String(err);
      const fallback = this.bot.def.baseline(s);
      fallback.source = "fallback";
      fallback.note = `fallback: ${fallback.note}`;
      this.apply(fallback, emit);
    } finally {
      this.inFlight = false;
      this.status.inFlight = false;
    }
  }
}

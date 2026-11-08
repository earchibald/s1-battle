import type { BotSense } from "@shared/bots/common";
import { interpretAnswers } from "@shared/logic";
import type { DecideError, DecideResponse, Intent } from "@shared/types";
import type { Bot } from "../sim/bot";
import type { SimEvent } from "../sim/events";
import { sense } from "../sim/perception";
import type { World } from "../sim/world";

/**
 * Brains decide; controllers drive. A brain is polled every `cadence` seconds (and nudged early by
 * notable events) and hands the bot a fresh Intent. The Jev brain is asynchronous: it sends the
 * bot's Perception to the server, which asks Jev, and applies the answer when it comes back,
 * unless the world has moved on so far that the answer is stale.
 */

export type BrainMode = "jev" | "baseline";

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
  /** Seconds between decisions. */
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

  constructor(bot: Bot, mode: BrainMode, opts: BrainOptions) {
    this.bot = bot;
    this.mode = mode;
    this.opts = opts;
    // Stagger first decisions so four requests don't fire on the same frame.
    this.timer = Math.random() * opts.cadence;
    this.status = { mode, inFlight: false, lastLatencyMs: 0, avgLatencyMs: 0, decisions: 0, fallbacks: 0, lastError: null };
  }

  /** Events that should make a bot rethink right away rather than wait for the next tick. */
  nudge(e: SimEvent) {
    const id = this.bot.id;
    const urgent =
      (e.type === "hit" && e.victim === id && e.amount > 6) ||
      (e.type === "grab" && (e.bot === id || e.victim === id)) ||
      (e.type === "release" && (e.bot === id || e.victim === id)) ||
      (e.type === "flip" && e.victim === id) ||
      ((e.type === "destroyed" || e.type === "pitted") && this.bot.intent.target === e.bot) ||
      e.type === "pit_open";
    if (urgent) this.timer = Math.min(this.timer, 0.08);
  }

  update(world: World, dt: number, emit: (e: SimEvent) => void) {
    if (world.phase !== "fighting" || !this.bot.alive) return;
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = this.opts.cadence;
    const s = sense(this.bot, world.bots, world.fightTime, world.timeLeft);
    if (this.mode === "baseline" || !Brain.jevAvailable) {
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

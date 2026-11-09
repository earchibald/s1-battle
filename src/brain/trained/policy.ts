import { availableManeuvers } from "@shared/logic";
import { styleOf, type TrainedStyle } from "@shared/build";
import type { Intent, Maneuver } from "@shared/types";
import type { Bot } from "../../sim/bot";
import type { Policy } from "../../sim/driver";
import { MANEUVERS, MANEUVER_INDEX, MAX_OPPS, encode } from "../../sim/features";
import { makeRng, type Rng } from "../../sim/math";
import { sense } from "../../sim/perception";
import { N_COMPONENTS } from "../../sim/rollout";
import type { World } from "../../sim/world";
import { TrainedNet, type NetOutput } from "./net";

/**
 * The trained brain's decision: run the network, weigh its predicted outcomes with the bot's style, and pick
 * a (technique, target) pair among the techniques that are installed and whose gates hold right now (the
 * same gates the Jev brain is limited by).
 */

/** Outcome weights in COMPONENTS order: dealt, taken, kills, died, crit, hazard. */
export function styleWeights(s: TrainedStyle): number[] {
  return [s.aggression, -s.caution, 0.5 * s.killer, -1.5 * s.survival, s.showboat, s.hazards];
}

/** Softmax temperature in value units (1.0 = 100 hp). Decisiveness 1 means pure argmax. */
export function temperature(s: TrainedStyle): number {
  return s.decisiveness >= 0.999 ? 0 : 0.004 + 0.12 * (1 - s.decisiveness) ** 2;
}

const HOLDING: Maneuver[] = ["crush", "drag_to_pit", "drag_to_saws", "release"];

export interface Scored {
  maneuver: Maneuver;
  target: string;
  value: number;
}

export interface TrainedDecision {
  intent: Intent;
  /** Every candidate pair with its style-weighted value, best first (for the Garage readout). */
  scored: Scored[];
  out: NetOutput;
  micros: number;
}

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

export function decideTrained(net: TrainedNet, bot: Bot, world: World, style: TrainedStyle, rng: Rng | null): TrainedDecision {
  const t0 = now();
  const s = sense(bot, world.bots, world.fightTime, world.timeLeft);
  const x = encode(bot, world.bots, world.fightTime, world.timeLeft);
  const out = net.forward(x);
  const allowed = availableManeuvers(bot.def.build, s);
  const W = styleWeights(style);
  const nm = MANEUVERS.length;

  const grudgeId = world.fightTime - bot.lastHitAt < 3 ? bot.lastHitBy : null;
  const scored: Scored[] = [];
  for (let k = 0; k < Math.min(MAX_OPPS, x.oppIds.length); k++) {
    const id = x.oppIds[k];
    for (const m of allowed) {
      const mi = MANEUVER_INDEX[m];
      const base = (k * nm + mi) * N_COMPONENTS;
      let v = 0;
      for (let c = 0; c < N_COMPONENTS; c++) v += W[c] * out.q[base + c];
      // Habits, in the same units (0.01 = 1 hp).
      if (bot.intent.maneuver === m && bot.intent.target === id) v += 0.06 * style.commitment;
      else if (bot.intent.target === id) v += 0.03 * style.commitment;
      if (grudgeId === id) v += 0.08 * style.grudge;
      v += 0.1 * (style.bias[m] ?? 0);
      scored.push({ maneuver: m, target: id, value: v });
    }
  }
  scored.sort((a, b) => b.value - a.value);
  const danger = Math.min(1, out.danger * style.nerves);

  if (!scored.length) {
    return { intent: intentFrom("hold", null, danger, 1, { hold: 1 }, {}, t0, "Net: nobody left"), scored, out, micros: (now() - t0) * 1000 };
  }

  // Probabilities over pairs: softmax at the style's temperature (argmax when decisive).
  const T = temperature(style);
  const best = scored[0].value;
  const p = scored.map((c) => (T === 0 ? (c === scored[0] ? 1 : 0) : Math.exp((c.value - best) / T)));
  const z = p.reduce((a, b) => a + b, 0);
  for (let i = 0; i < p.length; i++) p[i] /= z;
  let pick = 0;
  if (T > 0 && rng) {
    let r = rng.next();
    while (pick < p.length - 1 && r > p[pick]) r -= p[pick++];
  }
  const choice = scored[pick];
  const probabilities: Record<string, number> = {};
  const targetProbabilities: Record<string, number> = {};
  scored.forEach((c, i) => {
    probabilities[c.maneuver] = (probabilities[c.maneuver] ?? 0) + p[i];
    targetProbabilities[c.target] = (targetProbabilities[c.target] ?? 0) + p[i];
  });
  // Holding techniques act on whoever is in the jaws, whichever slot the pair was scored under.
  const target = s.facts.holding && HOLDING.includes(choice.maneuver) ? s.facts.holding : choice.target;
  const pct = Math.round((probabilities[choice.maneuver] ?? 0) * 100);
  const note = `Net: ${choice.maneuver} → ${target} (${pct}%) value ${(choice.value * 100).toFixed(0)} danger=${out.danger.toFixed(2)}`;
  const intent = intentFrom(choice.maneuver, target, danger, probabilities[choice.maneuver] ?? 0, probabilities, targetProbabilities, t0, note);
  return { intent, scored, out, micros: (now() - t0) * 1000 };
}

function intentFrom(
  maneuver: Maneuver,
  target: string | null,
  danger: number,
  confidence: number,
  probabilities: Record<string, number>,
  targetProbabilities: Record<string, number>,
  t0: number,
  note: string,
): Intent {
  return { target, maneuver, danger, source: "trained", confidence, probabilities, targetProbabilities, latencyMs: now() - t0, note };
}

export interface TrainedPolicyOptions {
  /** Ignore the style's decisiveness and always take the best pair (training rollouts, deterministic tests). */
  greedy?: boolean;
  /** Seed for sampling when the style is not fully decisive. */
  seed?: number;
  /** Override every bot's style (tournaments with one personality). */
  style?: TrainedStyle;
}

/** A synchronous Policy for the headless Driver: each bot reads its own build's style unless overridden. */
export function trainedPolicy(net: TrainedNet, opts: TrainedPolicyOptions = {}): Policy {
  const rng = makeRng(opts.seed ?? 7);
  return (bot, world) => {
    const style = opts.style ?? styleOf(bot.def.build);
    return decideTrained(net, bot, world, opts.greedy ? { ...style, decisiveness: 1 } : style, rng).intent;
  };
}

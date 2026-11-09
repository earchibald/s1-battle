/**
 * Plays one *pair* of matches between two contenders: same roster, same seed, the two sides swapped between
 * the halves. Everything that decides a pair (roster, which bots start on which side, the sim seed) is a
 * function of the pair seed, so any pair can be replayed, and two different comparisons run on the same
 * seeds are paired with each other too (used by the non-regression guards).
 */
import { readFileSync } from "node:fs";
import { STOCK_ORDER, stockBuild } from "../../shared/bots/index";
import { DEFAULT_STYLE, STYLE_PRESETS, type TrainedStyle } from "../../shared/build";
import { defFromBuild } from "../../shared/logic";
import type { BotBuild } from "../../shared/build";
import { Driver, baselinePolicy, type Policy } from "../../src/sim/driver";
import { makeRng, type Rng } from "../../src/sim/math";
import { TrainedNet, type ModelFile } from "../../src/brain/trained/net";
import { trainedPolicy } from "../../src/brain/trained/policy";
import { randomRoster } from "../train/builds";

/** "baseline", or a model file with an optional style preset: "data/league/models/g3.json@turtle". */
export type ContenderSpec = string;
export type Builds = "stock" | "random" | "mixed";

export interface KindTally {
  /** Bot-matches this weapon played on side A, and A's score in them. */
  games: number;
  score: number;
}

export interface PairResult {
  seed: number;
  /** Side A's score in each half (1 win, ½ draw, 0 loss). */
  s: [number, number];
  stock: boolean;
  /** Per weapon kind, from side A's point of view (A's bots only). */
  kindsA: Record<string, KindTally>;
  /** Per weapon kind, from side B's point of view (B's bots only). */
  kindsB: Record<string, KindTally>;
  damageA: number;
  damageB: number;
  lengths: [number, number];
}

const nets = new Map<string, TrainedNet>();
function netAt(path: string): TrainedNet {
  let n = nets.get(path);
  if (!n) nets.set(path, (n = new TrainedNet(JSON.parse(readFileSync(path, "utf8")) as ModelFile)));
  return n;
}

function styleFor(key: string): TrainedStyle {
  const p = STYLE_PRESETS.find((s) => s.key === key);
  if (!p) throw new Error(`unknown style preset ${key}`);
  return { ...DEFAULT_STYLE, ...p.style };
}

/** A fresh policy for one match (sampling styles get a deterministic per-match seed). */
export function policyOf(spec: ContenderSpec, seed: number): Policy {
  if (spec === "baseline") return baselinePolicy;
  const [path, style] = spec.split("@");
  return trainedPolicy(netAt(path), { style: style ? styleFor(style) : DEFAULT_STYLE, seed });
}

function stockRoster(rng: Rng): BotBuild[] {
  const kinds = STOCK_ORDER.slice();
  for (let i = kinds.length - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    [kinds[i], kinds[j]] = [kinds[j], kinds[i]];
  }
  return kinds.slice(0, 4).map((k, i) => ({ ...stockBuild(k), id: `slot-${i}` }));
}

export function playPair(a: ContenderSpec, b: ContenderSpec, seed: number, builds: Builds): PairResult {
  const rng = makeRng(seed * 977 + 13);
  const stock = builds === "stock" || (builds === "mixed" && rng.next() < 0.5);
  const roster = stock ? stockRoster(rng) : randomRoster(rng);
  const defs = roster.map(defFromBuild);
  // Two random bots start on side A; the second half swaps them.
  const order = [0, 1, 2, 3];
  for (let i = 3; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const firstA = new Set(order.slice(0, 2).map((i) => defs[i].name));
  const res: PairResult = { seed, s: [0, 0], stock, kindsA: {}, kindsB: {}, damageA: 0, damageB: 0, lengths: [0, 0] };
  for (let half = 0; half < 2; half++) {
    const onA = (id: string) => firstA.has(id) !== (half === 1);
    const pa = policyOf(a, seed * 4 + half);
    const pb = policyOf(b, seed * 4 + half + 2);
    const d = Driver.start(defs, seed, (bot) => (onA(bot.id) ? pa : pb), { nudges: true });
    d.run();
    const w = d.world;
    const winner = w.result?.winner ?? null;
    const sA = winner === null ? 0.5 : onA(winner) ? 1 : 0;
    res.s[half] = sA;
    res.lengths[half] = w.fightTime;
    for (const bot of w.bots) {
      const mine = onA(bot.id);
      const t = ((mine ? res.kindsA : res.kindsB)[bot.kind] ??= { games: 0, score: 0 });
      t.games++;
      t.score += mine ? sA : 1 - sA;
      if (mine) res.damageA += bot.stats.damageDealt;
      else res.damageB += bot.stats.damageDealt;
    }
  }
  return res;
}

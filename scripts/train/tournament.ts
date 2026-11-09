/**
 * Head-to-head tournament: in every match two bots run the trained brain and two run the opponent brain
 * (baseline rule trees, or Jev). Which bots get which brain rotates, so every weapon plays both sides equally.
 *
 *   npx tsx scripts/train/tournament.ts --model public/models/trained-brain.json --matches 200
 *   npx tsx --env-file=../../../.env scripts/train/tournament.ts --vs jev --matches 12      (needs TYPESAFE_API_KEY)
 *
 * Options: --seed 1 · --builds stock|random · --vs baseline|jev|trained (trained vs trained: style or model A/B) ·
 * --style <preset> and --style-b <preset> (personalities for the two sides) · --model-b <file> (side B's network
 * for --vs trained; default: the same model) · --out data/tournament.json
 */
import { readFileSync, writeFileSync } from "node:fs";
import { STOCK_ORDER, stockBuild } from "../../shared/bots/index";
import { DEFAULT_STYLE, STYLE_PRESETS, type TrainedStyle } from "../../shared/build";
import { defFromBuild, interpretAnswers } from "../../shared/logic";
import type { Intent } from "../../shared/types";
import type { Bot } from "../../src/sim/bot";
import { Driver, baselinePolicy, type Policy } from "../../src/sim/driver";
import { makeRng } from "../../src/sim/math";
import { sense } from "../../src/sim/perception";
import { TrainedNet, type ModelFile } from "../../src/brain/trained/net";
import { trainedPolicy } from "../../src/brain/trained/policy";
import { randomRoster } from "./builds";

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d;
};
const modelPath = opt("model", "public/models/trained-brain.json");
const matches = Number(opt("matches", "200"));
const seed0 = Number(opt("seed", "1"));
const builds = opt("builds", "stock");
const vs = opt("vs", "baseline") as "baseline" | "jev" | "trained";
const out = opt("out", "");
const preset = (key: string): TrainedStyle => {
  const p = STYLE_PRESETS.find((s) => s.key === key);
  if (!p) throw new Error(`unknown style preset ${key}; one of ${STYLE_PRESETS.map((s) => s.key).join(", ")}`);
  return { ...DEFAULT_STYLE, ...p.style };
};
const styleA = preset(opt("style", "balanced"));
const styleB = preset(opt("style-b", "balanced"));

const net = new TrainedNet(JSON.parse(readFileSync(modelPath, "utf8")) as ModelFile);
const sideA: Policy = trainedPolicy(net, { style: styleA, seed: seed0 });
const modelB = opt("model-b", "");
const netB = modelB ? new TrainedNet(JSON.parse(readFileSync(modelB, "utf8")) as ModelFile) : net;
const sideBTrained: Policy = trainedPolicy(netB, { style: styleB, seed: seed0 + 1 });
const short = (f: string) => f.split("/").pop()!.replace(".json", "");
const labelA = `${modelB ? short(modelPath) : "trained"}(${opt("style", "balanced")})`;
const labelB = vs === "trained" ? `${modelB ? short(modelB) : "trained"}(${opt("style-b", "balanced")})` : vs;

type Tally = { bots: number; wins: number; damage: number; survived: number; kills: number; decisions: number };
const tally: Record<string, Tally> = {};
/** Technique mix per side, counted per decision. */
const mix: Record<string, Record<string, number>> = {};
const T = (k: string) => (tally[k] ??= { bots: 0, wins: 0, damage: 0, survived: 0, kills: 0, decisions: 0 });
const byKind: Record<string, Record<string, { bots: number; wins: number }>> = {};
const lengths: number[] = [];
let jevLatency: number[] = [];
let jevErrors = 0;

const jev = vs === "jev" ? await import("../../server/jev") : null;
if (jev && !jev.jevConfigured) throw new Error("--vs jev needs TYPESAFE_API_KEY (try: npx tsx --env-file=<path to .env> ...)");

const rng = makeRng(seed0 * 977);
let roster: ReturnType<typeof randomRoster> = [];
for (let m = 0; m < matches; m++) {
  // A new roster every pair of matches; the second match of the pair swaps which bots are on which brain.
  if (m % 2 === 0)
    roster =
      builds === "random"
      ? randomRoster(rng)
      : (() => {
          const kinds = STOCK_ORDER.slice();
          for (let i = kinds.length - 1; i > 0; i--) {
            const j = Math.floor(rng.next() * (i + 1));
            [kinds[i], kinds[j]] = [kinds[j], kinds[i]];
          }
          return kinds.slice(0, 4).map((k, i) => ({ ...stockBuild(k), id: `slot-${i}` }));
        })();
  const defs = roster.map(defFromBuild);
  // Two bots per side; matches come in pairs with the sides swapped so every bot plays both brains.
  const pairBase = Math.floor(m / 2);
  const swap = m % 2 === 1;
  const order = [0, 1, 2, 3].sort((a, b) => ((a * 7 + pairBase * 3) % 4) - ((b * 7 + pairBase * 3) % 4));
  const onA = new Set(defs.filter((_, i) => order.indexOf(i) < 2 !== swap).map((d) => d.name));
  const side = (id: string) => (onA.has(id) ? labelA : labelB);

  const jevWant = new Set<string>();
  const policyFor = (b: Bot): Policy => {
    if (onA.has(b.id)) return sideA;
    if (vs === "trained") return sideBTrained;
    if (vs === "baseline") return baselinePolicy;
    // Jev: ask asynchronously (below) and keep doing what we were doing meanwhile.
    return (bot) => {
      jevWant.add(bot.id);
      return bot.intent;
    };
  };
  // Same seed for both halves of a pair, so the swap is the only difference.
  const d = Driver.start(defs, seed0 * 10000 + pairBase, policyFor, {
    nudges: true,
    onDecision: (b, intent) => {
      const mm = (mix[side(b.id)] ??= {});
      mm[intent.maneuver] = (mm[intent.maneuver] ?? 0) + 1;
    },
  });
  const inFlight = new Map<string, { applyAt: number; intent: Intent | null }>();
  while (!d.over) {
    const w = d.world;
    for (const [id, p] of inFlight) {
      if (w.fightTime < p.applyAt) continue;
      const bot = w.bot(id)!;
      if (p.intent && bot.alive) bot.intent = p.intent;
      inFlight.delete(id);
    }
    d.step();
    if (!jev) continue;
    for (const id of jevWant) {
      if (inFlight.has(id)) continue;
      const bot = w.bot(id)!;
      if (!bot.alive) continue;
      const s = sense(bot, w.bots, w.fightTime, w.timeLeft);
      const askedAt = w.fightTime;
      const res = await jev.decide(bot.kind, s, bot.def.build);
      if (!res.ok) {
        jevErrors++;
        inFlight.set(id, { applyAt: askedAt, intent: { ...bot.def.baseline(s), source: "fallback" } });
        continue;
      }
      jevLatency.push(res.latencyMs);
      // The answer lands after its real latency, in sim time, like in the browser. Stale answers are dropped.
      const applyAt = askedAt + res.latencyMs / 1000;
      if (res.latencyMs > 1200) {
        inFlight.set(id, { applyAt, intent: null });
        continue;
      }
      // Re-sense at apply time is approximated by interpreting against the sense at ask time.
      inFlight.set(id, { applyAt, intent: interpretAnswers(bot.def.build, s, res.answers, res.latencyMs) });
    }
    jevWant.clear();
  }
  const w = d.world;
  lengths.push(w.fightTime);
  const winner = w.result?.winner ?? null;
  const kills = new Map<string, number>();
  for (const b of w.bots) {
    const k = T(side(b.id));
    k.bots++;
    k.damage += b.stats.damageDealt;
    k.decisions += b.stats.decisions;
    if (b.alive) k.survived++;
    if (b.id === winner) k.wins++;
    const kk = ((byKind[b.kind] ??= {})[side(b.id)] ??= { bots: 0, wins: 0 });
    kk.bots++;
    if (b.id === winner) kk.wins++;
    if (b.lastHitBy && !b.alive) kills.set(b.lastHitBy, (kills.get(b.lastHitBy) ?? 0) + 1);
  }
  for (const [id, n] of kills) if (w.bot(id)) T(side(id)).kills += n;
  if (vs === "jev" || (m + 1) % 50 === 0) {
    const a = T(labelA);
    const b = T(labelB);
    console.log(`after ${m + 1}: ${labelA} ${a.wins} wins · ${labelB} ${b.wins} wins${jev ? ` · jev p50 ${med(jevLatency)} ms, ${jevErrors} errors` : ""}`);
  }
}

function med(xs: number[]): number {
  if (!xs.length) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  return Math.round(s[Math.floor(s.length / 2)]);
}

console.log(`\n${matches} matches (${builds} builds), two bots per side. Win share 50% = even.`);
for (const k of [labelA, labelB]) {
  const t = T(k);
  const games = matches;
  console.log(
    `  ${k.padEnd(22)} win share ${((t.wins / games) * 100).toFixed(1).padStart(5)}%  avg damage ${(t.damage / t.bots).toFixed(0).padStart(4)}  survived ${((t.survived / t.bots) * 100).toFixed(0)}%  kills/bot ${(t.kills / t.bots).toFixed(2)}`,
  );
}
console.log("  technique mix (share of decisions):");
for (const k of [labelA, labelB]) {
  const mm = mix[k] ?? {};
  const n = Object.values(mm).reduce((a, b) => a + b, 0) || 1;
  const top = Object.entries(mm).sort((a, b) => b[1] - a[1]).slice(0, 7);
  console.log(`    ${k.padEnd(22)} ${top.map(([m, c]) => `${m} ${((c / n) * 100).toFixed(0)}%`).join(" · ")}`);
}
console.log("  by weapon (win share of the matches that weapon was on that side):");
for (const kind of Object.keys(byKind).sort()) {
  const row = [labelA, labelB].map((k) => {
    const v = byKind[kind][k] ?? { bots: 0, wins: 0 };
    return `${k} ${v.bots ? ((v.wins / v.bots) * 100).toFixed(0).padStart(3) : "  -"}% of ${v.bots}`;
  });
  console.log(`    ${kind.padEnd(8)} ${row.join("   ")}`);
}
const L = lengths.slice().sort((a, b) => a - b);
console.log(`  match length median ${L[Math.floor(L.length / 2)].toFixed(0)} s`);
if (jev) console.log(`  jev: ${jevLatency.length} answers, p50 ${med(jevLatency)} ms, ${jevErrors} errors`);
if (out) writeFileSync(out, JSON.stringify({ args: argv, model: net.file.info, tally, byKind, medianLength: L[Math.floor(L.length / 2)], jevLatencyP50: med(jevLatency), jevErrors }, null, 1));

/**
 * Training-data generator. Plays headless matches between random legal builds and, at sampled decision
 * moments, forks the match once per (installed technique × opponent), forces that choice for `commit`
 * seconds, plays on to `horizon`, and records the outcome vector (see src/sim/rollout.ts). Also records
 * whether the bot actually got hit within 1.5 s, for the danger head.
 *
 *   npx tsx scripts/train/gen.ts --name iter0 --workers 16 --matches 40 [--model public/models/trained.json]
 *
 * --matches is per worker. Options: --seed 1 · --label 0.5 (fraction of decisions rolled out) · --eps 0.15
 * (random exploratory choices on the real trajectory) · --commit 1.0 · --horizon 2.5 · --model-share 0.7
 * (bots driven by the model when --model is given; the rest use their baseline trees, and rollout
 * continuations do the same) · --focus data/league/focus-g3.json (weapon weights for roster sampling, written by
 * the league's diagnosis so the data oversamples the champion's weak spots).
 *
 * Output: data/<name>/shard-<i>.f32 (rows in the layout of scripts/train/spec.ts) and data/<name>/meta.json.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { availableManeuvers, defFromBuild, intentOf } from "../../shared/logic";
import type { Intent, Maneuver } from "../../shared/types";
import type { Bot } from "../../src/sim/bot";
import { Driver, baselinePolicy, type Policy } from "../../src/sim/driver";
import { MANEUVER_INDEX, N_MANEUVERS, encode } from "../../src/sim/features";
import { makeRng } from "../../src/sim/math";
import { sense } from "../../src/sim/perception";
import { N_COMPONENTS, rollout } from "../../src/sim/rollout";
import { TrainedNet, type ModelFile } from "../../src/brain/trained/net";
import { trainedPolicy } from "../../src/brain/trained/policy";
import { randomRoster } from "./builds";
import { HIT_HORIZON, OFFSET, ROW, meta } from "./spec";

const argv: string[] = isMainThread ? process.argv.slice(2) : (workerData as { argv: string[] }).argv;
const opt = (k: string, d: string) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d;
};
const name = opt("name", "iter0");
const workers = Number(opt("workers", "1"));
const shard = isMainThread ? 0 : (workerData as { shard: number }).shard;
const matches = Number(opt("matches", "20"));
const seed0 = Number(opt("seed", "1"));
const labelP = Number(opt("label", "0.5"));
const eps = Number(opt("eps", "0.15"));
const commit = Number(opt("commit", "1.0"));
const horizon = Number(opt("horizon", "2.5"));
const modelPath = opt("model", "");
const modelShare = Number(opt("model-share", "0.7"));
const dir = `data/${name}`;
const focusPath = opt("focus", "");
const focus = focusPath ? (JSON.parse(readFileSync(focusPath, "utf8")) as { kinds: Record<string, number> }).kinds : undefined;
const HOLDING: Maneuver[] = ["crush", "drag_to_pit", "drag_to_saws", "release"];

function generate(): { rows: number; rollouts: number } {
  const net = modelPath ? new TrainedNet(JSON.parse(readFileSync(modelPath, "utf8")) as ModelFile) : null;
  const greedyModel: Policy | null = net ? trainedPolicy(net, { greedy: true }) : null;
  const rng = makeRng(seed0 * 1000003 + shard * 7919);
  const rows: Float32Array[] = [];
  const t0 = Date.now();
  let rollouts = 0;

  for (let m = 0; m < matches; m++) {
    const seed = seed0 * 100000 + shard * 1000 + m;
    const roster = randomRoster(rng, focus).map(defFromBuild);
    // Which brain each bot plays with, on the real trajectory and in every rollout continuation.
    const usesModel = new Map<string, boolean>(roster.map((d) => [d.name, !!greedyModel && rng.next() < modelShare]));
    const continuation = (b: Bot): Policy => (usesModel.get(b.id) ? greedyModel! : baselinePolicy);
    const pending: { row: Float32Array; bot: Bot; hp: number; until: number }[] = [];
    let driver!: Driver;

    // The behavior policy: labels some decisions with rollouts, then acts (with a little exploration).
    const behavior = (): Policy => (bot, w) => {
      const own = continuation(bot)(bot, w);
      const s = sense(bot, w.bots, w.fightTime, w.timeLeft);
      const allowed = availableManeuvers(bot.def.build, s);
      if (rng.next() < labelP && s.facts.opponents.length > 0) {
        const x = encode(bot, w.bots, w.fightTime, w.timeLeft);
        const row = new Float32Array(ROW);
        row.set(x.self, OFFSET.self);
        row.set(x.opps, OFFSET.opps);
        row.set(x.oppMask, OFFSET.opp_mask);
        for (const a of allowed) row[OFFSET.avail + MANEUVER_INDEX[a]] = 1;
        x.oppIds.forEach((id, k) => {
          for (const a of allowed) {
            const q = rollout(driver, bot.id, intentOf(id, a, own.danger, "", "rollout"), { commit, horizon }, continuation);
            rollouts++;
            const mi = MANEUVER_INDEX[a];
            row.set(q, OFFSET.q + (k * N_MANEUVERS + mi) * N_COMPONENTS);
            row[OFFSET.q_mask + k * N_MANEUVERS + mi] = 1;
          }
        });
        row[OFFSET.behavior_model] = usesModel.get(bot.id) ? 1 : 0;
        rows.push(row);
        pending.push({ row, bot, hp: bot.hp, until: w.fightTime + HIT_HORIZON });
      }
      if (rng.next() < eps && allowed.length) {
        const ops = s.facts.opponents;
        const a = allowed[Math.floor(rng.next() * allowed.length)];
        const t = ops.length ? ops[Math.floor(rng.next() * ops.length)].name : null;
        const explore: Intent = intentOf(s.facts.holding && HOLDING.includes(a) ? s.facts.holding : t, a, own.danger, `explore: ${a}`, "explore");
        return explore;
      }
      return own;
    };

    driver = Driver.start(roster, seed, behavior, { nudges: true });
    while (!driver.over) {
      driver.step();
      const w = driver.world;
      for (let i = pending.length - 1; i >= 0; i--) {
        const p = pending[i];
        if (p.bot.hp < p.hp - 0.5 || !p.bot.alive) p.row[OFFSET.hit_soon] = 1;
        else if (w.fightTime < p.until && w.phase === "fighting") continue;
        pending.splice(i, 1);
      }
    }
    if (workers <= 1) process.stderr.write(`match ${m + 1}/${matches}: ${rows.length} rows, ${rollouts} rollouts, ${((Date.now() - t0) / 1000).toFixed(0)} s\n`);
  }

  const buf = new Float32Array(rows.length * ROW);
  rows.forEach((r, i) => buf.set(r, i * ROW));
  writeFileSync(`${dir}/shard-${shard}.f32`, Buffer.from(buf.buffer));
  return { rows: rows.length, rollouts };
}

if (!isMainThread) {
  parentPort!.postMessage(generate());
} else {
  mkdirSync(dir, { recursive: true });
  const t0 = Date.now();
  let results: { rows: number; rollouts: number }[];
  if (workers <= 1) results = [generate()];
  else {
    results = await Promise.all(
      Array.from(
        { length: workers },
        (_, i) =>
          new Promise<{ rows: number; rollouts: number }>((resolve, reject) => {
            const wk = new Worker(new URL(import.meta.url), { workerData: { shard: i, argv } });
            wk.once("message", resolve);
            wk.once("error", reject);
          }),
      ),
    );
  }
  const total = results.reduce((a, r) => a + r.rows, 0);
  const shards = results.map((r, i) => ({ file: `shard-${i}.f32`, rows: r.rows }));
  writeFileSync(`${dir}/meta.json`, JSON.stringify(meta({ name, shards, rows: total, args: argv, model: modelPath || null, focus: focus ?? null }), null, 1));
  const ro = results.reduce((a, r) => a + r.rollouts, 0);
  console.log(`${total} rows, ${ro} rollouts, ${shards.length} shards → ${dir} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  process.exit(0);
}

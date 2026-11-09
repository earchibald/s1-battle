/**
 * The improvement league: a registry of trained-brain models, every head-to-head result ever played between
 * them, and the statistical gate that decides whether a newly trained model replaces the champion.
 *
 *   npx tsx scripts/league/league.ts <command> [options]
 *
 *   init --champion iter2=data/models/iter2.json --history iter0=…,iter1=… --datasets data/iter0,… --first-gen 3
 *   status                       champion, models, datasets, generations
 *   diagnose --gen N             champion vs baseline (per-weapon breakdown) → curriculum weights for gen N's data
 *   add-dataset data/gN          append a dataset to the training pool
 *   window                       the dataset paths the next model trains on (newest `window`)
 *   gate --gen N --candidates a.json,b.json [--ship]
 *                                screen candidates vs champion, SPRT the best on fresh seeds, non-regression
 *                                guards vs baseline and the previous champion; promote on success
 *   duel A B [--pairs N | --sprt] any two players (names, model paths, or "baseline"); recorded for the ladder
 *   ladder                       Bradley–Terry Elo of every player from all results, baseline = 0, bootstrap 95% CI
 *   report                       rewrite data/league/REPORT.md
 *   champion-path · next-gen     for scripts
 *
 * State lives in data/league/ (gitignored): state.json, results.jsonl, models/, focus-gN.json, REPORT.md.
 * Seeds are allocated from a counter so no two tests share evaluation seeds unless they are meant to be paired.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { basename } from "node:path";
import { Pool } from "./pool";
import type { Builds, KindTally, PairResult } from "./arena";
import { addPenta, emptyPenta, ladder, pairedDiff, pentaIndex, sprt, summarize, wilson, type Penta, type PentaSummary, type SprtConfig } from "./stats";

const ROOT = process.env.LEAGUE_DIR ?? "data/league";
const STATE = `${ROOT}/state.json`;
const RESULTS = `${ROOT}/results.jsonl`;

interface Config {
  builds: Builds;
  sprt: SprtConfig;
  /** Pairs per SPRT look. */
  batchPairs: number;
  maxPairs: number;
  /** Pairs per candidate when more than one candidate is screened. */
  screenPairs: number;
  diagPairs: number;
  guardPairs: number;
  /** Non-inferiority margin (score per match) for the guards: candidate may be at most this much worse. */
  guardMargin: number;
  /** How many former champions (besides baseline) the guards check. */
  guardDepth: number;
  /** Datasets the next model trains on (newest first). */
  window: number;
  /** Curriculum: shrinkage pseudo-games and temperature (score units) for weapon weights. */
  focusPrior: number;
  focusTemp: number;
}

interface ModelEntry {
  path: string;
  parent: string | null;
  datasets: string[];
  addedAt: string;
  gen?: number;
  val?: Record<string, unknown>;
  promoted?: boolean;
}

interface TestSummary {
  a: string;
  b: string;
  pairs: number;
  score: number;
  elo: number;
  eloLo: number;
  eloHi: number;
  los: number;
}

interface GenRecord {
  gen: number;
  championBefore: string;
  startedAt: string;
  finishedAt?: string;
  diagnosis?: TestSummary & { kinds: Record<string, { score: number; lo: number; hi: number; games: number }> };
  focus?: Record<string, number>;
  dataset?: string;
  candidates?: { name: string; val?: Record<string, unknown>; screen?: TestSummary }[];
  sprt?: TestSummary & { llr: number; lower: number; upper: number; decision: string };
  guards?: { anchor: string; candidate: number; champion: number; diff: number; lo: number; hi: number; pass: boolean }[];
  promoted?: boolean;
  championAfter?: string;
}

interface State {
  version: 1;
  createdAt: string;
  nextSeed: number;
  firstGen: number;
  champion: string;
  /** Champions in order of promotion (oldest first). */
  lineage: string[];
  models: Record<string, ModelEntry>;
  datasets: string[];
  generations: GenRecord[];
  config: Config;
}

const DEFAULT_CONFIG: Config = {
  builds: "mixed",
  sprt: { elo0: 0, elo1: 8, alpha: 0.05, beta: 0.05 },
  batchPairs: 280,
  maxPairs: 30000,
  screenPairs: 1200,
  diagPairs: 3000,
  guardPairs: 2000,
  guardMargin: 0.03,
  guardDepth: 1,
  window: 4,
  focusPrior: 300,
  focusTemp: 0.08,
};

const argv = process.argv.slice(2);
const cmd = argv[0];
const opt = (k: string, d = "") => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d;
};
const flag = (k: string) => argv.includes(`--${k}`);
const now = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");

function load(): State {
  if (!existsSync(STATE)) throw new Error(`no league at ${ROOT}; run: league.ts init …`);
  const s = JSON.parse(readFileSync(STATE, "utf8")) as State;
  s.config = { ...DEFAULT_CONFIG, ...s.config, sprt: { ...DEFAULT_CONFIG.sprt, ...s.config?.sprt } };
  return s;
}
function save(s: State) {
  writeFileSync(STATE, JSON.stringify(s, null, 1));
}
function seeds(s: State, n: number): number[] {
  const out = Array.from({ length: n }, (_, i) => s.nextSeed + i);
  s.nextSeed += n;
  save(s);
  return out;
}
function specOf(s: State, player: string): string {
  if (player === "baseline") return "baseline";
  if (s.models[player]) return s.models[player].path;
  if (existsSync(player)) return player;
  throw new Error(`unknown player ${player}`);
}
const nameOf = (s: State, player: string) => (player === "baseline" || s.models[player] ? player : basename(player, ".json"));

let pool: Pool | null = null;
const getPool = () => (pool ??= new Pool(Number(process.env.LEAGUE_WORKERS ?? 0) || undefined));

interface Played {
  penta: Penta;
  pairs: PairResult[];
  summary: PentaSummary;
}

function tallyPairs(rs: PairResult[]): Penta {
  const p = emptyPenta();
  for (const r of rs) p[pentaIndex(r.s[0], r.s[1])]++;
  return p;
}

function mergeKinds(rs: PairResult[], side: "kindsA" | "kindsB"): Record<string, KindTally> {
  const out: Record<string, KindTally> = {};
  for (const r of rs)
    for (const [k, t] of Object.entries(r[side])) {
      const o = (out[k] ??= { games: 0, score: 0 });
      o.games += t.games;
      o.score += t.score;
    }
  return out;
}

function record(s: State, test: string, a: string, b: string, rs: PairResult[], gen?: number) {
  const penta = tallyPairs(rs);
  const line = {
    test,
    gen,
    a,
    b,
    builds: s.config.builds,
    seeds: [Math.min(...rs.map((r) => r.seed)), Math.max(...rs.map((r) => r.seed))],
    penta,
    kindsA: mergeKinds(rs, "kindsA"),
    kindsB: mergeKinds(rs, "kindsB"),
    damageA: rs.reduce((x, r) => x + r.damageA, 0) / (rs.length * 4),
    damageB: rs.reduce((x, r) => x + r.damageB, 0) / (rs.length * 4),
    at: now(),
  };
  appendFileSync(RESULTS, JSON.stringify(line) + "\n");
}

async function play(s: State, a: string, b: string, n: number, sd?: number[]): Promise<Played> {
  const ss = sd ?? seeds(s, n);
  const pairs = await getPool().run(specOf(s, a), specOf(s, b), ss, s.config.builds);
  const penta = tallyPairs(pairs);
  return { penta, pairs, summary: summarize(penta) };
}

const brief = (a: string, b: string, x: PentaSummary): TestSummary => ({
  a,
  b,
  pairs: x.pairs,
  score: x.score,
  elo: x.elo,
  eloLo: x.eloLo,
  eloHi: x.eloHi,
  los: x.los,
});
const fmtElo = (x: { elo: number; eloLo: number; eloHi: number }) =>
  `${x.elo >= 0 ? "+" : ""}${x.elo.toFixed(1)} Elo [${x.eloLo.toFixed(1)}, ${x.eloHi.toFixed(1)}]`;
const fmt = (a: string, b: string, x: PentaSummary) =>
  `${a} vs ${b}: ${x.pairs} pairs (${x.matches} matches) score ${(x.score * 100).toFixed(2)}% ${fmtElo(x)} LOS ${(x.los * 100).toFixed(1)}%  penta [${x.penta.join(" ")}]`;

function kindTable(k: Record<string, KindTally>) {
  const rows = Object.entries(k)
    .map(([kind, t]) => ({ kind, games: t.games, ...wilson(t.score, t.games) }))
    .sort((x, y) => x.p - y.p);
  for (const r of rows) console.log(`    ${r.kind.padEnd(9)} ${(r.p * 100).toFixed(1).padStart(5)}%  [${(r.lo * 100).toFixed(1)}, ${(r.hi * 100).toFixed(1)}]  of ${r.games} bot-matches`);
  return rows;
}

/** Curriculum: oversample weapons the champion does worst with (shrunk toward its mean, clamped to [0.5, 2.5]). */
function focusWeights(s: State, k: Record<string, KindTally>): Record<string, number> {
  const games = Object.values(k).reduce((a, t) => a + t.games, 0);
  const mean = Object.values(k).reduce((a, t) => a + t.score, 0) / Math.max(1, games);
  const w: Record<string, number> = {};
  for (const [kind, t] of Object.entries(k)) {
    const shrunk = (t.score + s.config.focusPrior * mean) / (t.games + s.config.focusPrior);
    w[kind] = Math.min(2.5, Math.max(0.5, Math.exp((mean - shrunk) / s.config.focusTemp)));
  }
  const z = Object.values(w).reduce((a, b) => a + b, 0) / Math.max(1, Object.keys(w).length);
  for (const kind of Object.keys(w)) w[kind] = Number((w[kind] / z).toFixed(3));
  return w;
}

function genRecord(s: State, gen: number): GenRecord {
  let g = s.generations.find((x) => x.gen === gen);
  if (!g) {
    g = { gen, championBefore: s.champion, startedAt: now() };
    s.generations.push(g);
  }
  return g;
}

function readResults(): { a: string; b: string; penta: Penta }[] {
  if (!existsSync(RESULTS)) return [];
  return readFileSync(RESULTS, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

/** Results merged per unordered matchup, oriented a→b consistently. */
function mergedResults() {
  const m = new Map<string, { a: string; b: string; penta: Penta }>();
  for (const r of readResults()) {
    const flip = r.a > r.b;
    const a = flip ? r.b : r.a;
    const b = flip ? r.a : r.b;
    const p = (flip ? r.penta.slice().reverse() : r.penta) as Penta;
    const key = `${a}\u0000${b}`;
    const cur = m.get(key);
    m.set(key, { a, b, penta: cur ? addPenta(cur.penta, p) : p });
  }
  return [...m.values()];
}

function ladderRows() {
  const res = mergedResults();
  return res.length ? ladder(res, "baseline", 300) : [];
}

function writeReport(s: State) {
  const L = ladderRows();
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const e = (x: { elo: number; eloLo: number; eloHi: number }) => `${x.elo >= 0 ? "+" : ""}${x.elo.toFixed(0)} [${x.eloLo.toFixed(0)}, ${x.eloHi.toFixed(0)}]`;
  const lines: string[] = [];
  lines.push(`# Trained-brain league`, ``, `Generated ${now()} · champion **${s.champion}** · ${s.datasets.length} datasets · ${Object.keys(s.models).length} models`, ``);
  lines.push(
    `Every comparison is played in side-swapped pairs on ${s.config.builds} builds. Promotion needs an SPRT`,
    `(H0: ≤ ${s.config.sprt.elo0} Elo, H1: ≥ ${s.config.sprt.elo1} Elo, α = ${s.config.sprt.alpha}, β = ${s.config.sprt.beta}) against the champion`,
    `on fresh seeds, plus non-inferiority (margin ${pct(s.config.guardMargin)} score) against baseline and the previous champion.`,
    ``,
  );
  lines.push(`## Ladder`, ``, `Bradley–Terry over every recorded pair, baseline = 0, 95% bootstrap intervals.`, ``, `| player | Elo | 95% CI | pairs played |`, `| --- | ---: | --- | ---: |`);
  for (const r of L) lines.push(`| ${r.player === s.champion ? `**${r.player}** (champion)` : r.player} | ${r.elo >= 0 ? "+" : ""}${r.elo.toFixed(0)} | [${r.lo.toFixed(0)}, ${r.hi.toFixed(0)}] | ${r.pairs} |`);
  lines.push(``, `## Generations`, ``, `| gen | champion before | vs baseline | dataset | candidates (screen vs champion) | SPRT vs champion | guards | result |`, `| --- | --- | --- | --- | --- | --- | --- | --- |`);
  for (const g of s.generations) {
    const cands = (g.candidates ?? []).map((c) => (c.screen ? `${c.name} ${e(c.screen)}` : c.name)).join("<br>") || "–";
    const sp = g.sprt ? `${g.sprt.a}: ${e(g.sprt)} in ${g.sprt.pairs} pairs, LLR ${g.sprt.llr.toFixed(2)} → ${g.sprt.decision}` : "–";
    const gd = g.guards?.length ? g.guards.map((x) => `${x.anchor} ${x.diff >= 0 ? "+" : ""}${(x.diff * 100).toFixed(1)} pts [${(x.lo * 100).toFixed(1)}, ${(x.hi * 100).toFixed(1)}] ${x.pass ? "✓" : "✗"}`).join("<br>") : "–";
    const res = g.promoted === undefined ? "in progress" : g.promoted ? `**promoted ${g.championAfter}**` : "kept champion";
    lines.push(`| ${g.gen} | ${g.championBefore} | ${g.diagnosis ? e(g.diagnosis) : "–"} | ${g.dataset ? basename(g.dataset) : "–"} | ${cands} | ${sp} | ${gd} | ${res} |`);
  }
  const last = [...s.generations].reverse().find((g) => g.diagnosis);
  if (last?.diagnosis) {
    lines.push(``, `## Weak spots (gen ${last.gen} diagnosis: ${last.championBefore} vs baseline)`, ``, `| weapon | champion's win share | 95% CI | next-data weight |`, `| --- | ---: | --- | ---: |`);
    for (const [k, v] of Object.entries(last.diagnosis.kinds).sort((a, b) => a[1].score - b[1].score))
      lines.push(`| ${k} | ${pct(v.score)} | [${pct(v.lo)}, ${pct(v.hi)}] | ${last.focus?.[k]?.toFixed(2) ?? "–"} |`);
  }
  writeFileSync(`${ROOT}/REPORT.md`, lines.join("\n") + "\n");
  writeFileSync(`${ROOT}/ladder.json`, JSON.stringify(L, null, 1));
}

async function main() {
  mkdirSync(`${ROOT}/models`, { recursive: true });
  switch (cmd) {
    case "init": {
      if (existsSync(STATE) && !flag("force")) throw new Error(`${STATE} exists (use --force to overwrite)`);
      const [cname, cpath] = opt("champion").split("=");
      if (!cname || !cpath) throw new Error("--champion name=path");
      const history = opt("history")
        .split(",")
        .filter(Boolean)
        .map((x) => x.split("="));
      const datasets = opt("datasets").split(",").filter(Boolean);
      const s: State = {
        version: 1,
        createdAt: now(),
        nextSeed: 1_000_000,
        firstGen: Number(opt("first-gen", "1")),
        champion: cname,
        lineage: [...history.map(([n]) => n), cname],
        models: {},
        datasets,
        generations: [],
        config: DEFAULT_CONFIG,
      };
      let parent: string | null = null;
      for (const [n, p] of [...history, [cname, cpath]]) {
        const dest = `${ROOT}/models/${n}.json`;
        copyFileSync(p, dest);
        const info = (JSON.parse(readFileSync(dest, "utf8")) as { info?: { datasets?: string[]; val?: Record<string, unknown> } }).info;
        s.models[n] = { path: dest, parent, datasets: info?.datasets ?? [], addedAt: now(), val: info?.val, promoted: true };
        parent = n;
      }
      save(s);
      console.log(`league initialised at ${ROOT}: champion ${cname}, lineage ${s.lineage.join(" → ")}, ${datasets.length} datasets`);
      break;
    }
    case "status": {
      const s = load();
      console.log(`champion ${s.champion} (${s.models[s.champion].path}); lineage ${s.lineage.join(" → ")}`);
      console.log(`datasets: ${s.datasets.join(", ")}`);
      console.log(`generations: ${s.generations.map((g) => `${g.gen}:${g.promoted === undefined ? "…" : g.promoted ? "promoted" : "kept"}`).join(" ")}`);
      console.log(`next seed ${s.nextSeed}`);
      break;
    }
    case "champion-path":
      console.log(load().models[load().champion].path);
      break;
    case "next-gen": {
      const s = load();
      const done = s.generations.filter((g) => g.promoted !== undefined).map((g) => g.gen);
      console.log(done.length ? Math.max(...done) + 1 : s.firstGen);
      break;
    }
    case "window": {
      const s = load();
      console.log(s.datasets.slice(-s.config.window).join(" "));
      break;
    }
    case "add-dataset": {
      const s = load();
      const d = argv[1];
      if (!existsSync(`${d}/meta.json`)) throw new Error(`${d}/meta.json missing`);
      if (!s.datasets.includes(d)) s.datasets.push(d);
      const g = s.generations.find((x) => x.gen === Number(opt("gen", "-1")));
      if (g) g.dataset = d;
      save(s);
      console.log(`datasets: ${s.datasets.join(", ")}`);
      break;
    }
    case "diagnose": {
      const s = load();
      const gen = Number(opt("gen"));
      const n = Number(opt("pairs", String(s.config.diagPairs)));
      console.log(`== gen ${gen} diagnosis: ${s.champion} vs baseline, ${n} pairs`);
      const r = await play(s, s.champion, "baseline", n);
      record(s, "diagnose", s.champion, "baseline", r.pairs, gen);
      console.log("  " + fmt(s.champion, "baseline", r.summary));
      console.log("  champion's win share by weapon (worst first):");
      const kinds = mergeKinds(r.pairs, "kindsA");
      const rows = kindTable(kinds);
      const focus = focusWeights(s, kinds);
      console.log(`  next-data weapon weights: ${Object.entries(focus).map(([k, v]) => `${k} ${v}`).join(" · ")}`);
      const g = genRecord(s, gen);
      g.championBefore = s.champion;
      g.diagnosis = { ...brief(s.champion, "baseline", r.summary), kinds: Object.fromEntries(rows.map((x) => [x.kind, { score: x.p, lo: x.lo, hi: x.hi, games: x.games }])) };
      g.focus = focus;
      save(s);
      writeFileSync(`${ROOT}/focus-g${gen}.json`, JSON.stringify({ kinds: focus }, null, 1));
      break;
    }
    case "gate": {
      const s = load();
      const gen = Number(opt("gen"));
      const g = genRecord(s, gen);
      const champ = s.champion;
      const paths = opt("candidates").split(",").filter(Boolean);
      if (!paths.length) throw new Error("--candidates a.json[,b.json]");
      const names: string[] = [];
      paths.forEach((p, i) => {
        const n = `g${gen}${String.fromCharCode(97 + i)}`;
        const dest = `${ROOT}/models/${n}.json`;
        copyFileSync(p, dest);
        const info = (JSON.parse(readFileSync(dest, "utf8")) as { info?: { datasets?: string[]; val?: Record<string, unknown>; note?: string } }).info;
        s.models[n] = { path: dest, parent: champ, datasets: info?.datasets ?? [], addedAt: now(), gen, val: info?.val };
        names.push(n);
      });
      g.candidates = names.map((n) => ({ name: n, val: s.models[n].val }));
      save(s);

      // 1. Screening (only when there is a choice): every candidate on the same fresh seeds.
      let best = names[0];
      if (names.length > 1) {
        const sd = seeds(s, s.config.screenPairs);
        console.log(`== screening ${names.length} candidates vs ${champ}, ${sd.length} pairs each (same seeds)`);
        let bestScore = -1;
        for (const n of names) {
          const r = await play(s, n, champ, 0, sd);
          record(s, "screen", n, champ, r.pairs, gen);
          console.log("  " + fmt(n, champ, r.summary));
          g.candidates.find((c) => c.name === n)!.screen = brief(n, champ, r.summary);
          if (r.summary.score > bestScore) [best, bestScore] = [n, r.summary.score];
        }
        save(s);
      }

      // 2. SPRT on fresh seeds (the screening seeds are not reused, so picking the best does not bias it).
      const cfg = s.config.sprt;
      console.log(`== SPRT ${best} vs ${champ}: H0 ≤ ${cfg.elo0} Elo, H1 ≥ ${cfg.elo1} Elo, α=${cfg.alpha} β=${cfg.beta}`);
      let penta = emptyPenta();
      const all: PairResult[] = [];
      let st = sprt(penta, cfg);
      while (true) {
        const r = await play(s, best, champ, s.config.batchPairs);
        all.push(...r.pairs);
        penta = addPenta(penta, r.penta);
        st = sprt(penta, cfg, s.config.batchPairs);
        const x = summarize(penta);
        console.log(`  ${x.pairs} pairs: score ${(x.score * 100).toFixed(2)}% ${fmtElo(x)}  LLR ${st.llr.toFixed(2)} (${st.lower.toFixed(2)}, ${st.upper.toFixed(2)})`);
        if (st.decision !== "continue" || x.pairs >= s.config.maxPairs) break;
      }
      record(s, "sprt", best, champ, all, gen);
      const sx = summarize(penta);
      g.sprt = { ...brief(best, champ, sx), llr: st.llr, lower: st.lower, upper: st.upper, decision: st.decision === "continue" ? "inconclusive" : st.decision };
      save(s);

      // 3. Non-regression guards: candidate and champion vs each anchor on identical seeds, paired difference.
      let pass = st.decision === "H1";
      g.guards = [];
      if (pass) {
        const anchors = ["baseline", ...s.lineage.slice(0, -1).slice(-s.config.guardDepth)];
        for (const anchor of anchors) {
          const sd = seeds(s, s.config.guardPairs);
          const rc = await play(s, best, anchor, 0, sd);
          const rh = await play(s, champ, anchor, 0, sd);
          record(s, "guard", best, anchor, rc.pairs, gen);
          record(s, "guard", champ, anchor, rh.pairs, gen);
          const d = pairedDiff(rc.pairs.map((p, i) => (p.s[0] + p.s[1]) / 2 - (rh.pairs[i].s[0] + rh.pairs[i].s[1]) / 2));
          const ok = d.lo > -s.config.guardMargin;
          g.guards.push({ anchor, candidate: rc.summary.score, champion: rh.summary.score, diff: d.mean, lo: d.lo, hi: d.hi, pass: ok });
          console.log(
            `== guard vs ${anchor}: ${best} ${(rc.summary.score * 100).toFixed(2)}% · ${champ} ${(rh.summary.score * 100).toFixed(2)}% · Δ ${(d.mean * 100).toFixed(2)} pts [${(d.lo * 100).toFixed(2)}, ${(d.hi * 100).toFixed(2)}] ${ok ? "pass" : "FAIL"}`,
          );
          pass &&= ok;
        }
      }

      // 4. Decision.
      g.promoted = pass;
      g.finishedAt = now();
      if (pass) {
        s.champion = best;
        s.lineage.push(best);
        s.models[best].promoted = true;
        if (flag("ship")) {
          copyFileSync(s.models[best].path, "public/models/trained-brain.json");
          console.log(`shipped ${best} → public/models/trained-brain.json`);
        }
      }
      g.championAfter = s.champion;
      save(s);
      writeReport(s);
      console.log(pass ? `PROMOTED ${best} (was ${champ})` : `kept ${champ} (${best}: ${g.sprt.decision}${g.guards.some((x) => !x.pass) ? ", guard failed" : ""})`);
      break;
    }
    case "duel": {
      const s = load();
      const [a, b] = [argv[1], argv[2]];
      const na = nameOf(s, a);
      const nb = nameOf(s, b);
      if (flag("sprt")) {
        let penta = emptyPenta();
        const all: PairResult[] = [];
        while (true) {
          const r = await play(s, a, b, s.config.batchPairs);
          all.push(...r.pairs);
          penta = addPenta(penta, r.penta);
          const st = sprt(penta, s.config.sprt, s.config.batchPairs);
          console.log(`  ${fmt(na, nb, summarize(penta))} LLR ${st.llr.toFixed(2)}`);
          if (st.decision !== "continue" || all.length >= s.config.maxPairs) {
            console.log(`SPRT: ${st.decision}`);
            break;
          }
        }
        record(s, "duel", na, nb, all);
      } else {
        const r = await play(s, a, b, Number(opt("pairs", "2000")));
        record(s, "duel", na, nb, r.pairs);
        console.log(fmt(na, nb, r.summary));
        console.log("  side A's win share by weapon:");
        kindTable(mergeKinds(r.pairs, "kindsA"));
      }
      break;
    }
    case "ladder": {
      const s = load();
      for (const r of ladderRows())
        console.log(`${(r.player === s.champion ? `${r.player} *` : r.player).padEnd(14)} ${(r.elo >= 0 ? "+" : "") + r.elo.toFixed(1)} [${r.lo.toFixed(1)}, ${r.hi.toFixed(1)}]  ${r.pairs} pairs`);
      writeReport(s);
      break;
    }
    case "report":
      writeReport(load());
      console.log(`wrote ${ROOT}/REPORT.md`);
      break;
    default:
      console.log(readFileSync(new URL(import.meta.url), "utf8").split("*/")[0]);
  }
}

// Piping into `head` must not crash a run after its results are recorded.
process.stdout.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code !== "EPIPE") throw e;
});

try {
  await main();
} finally {
  await (pool as Pool | null)?.close();
}

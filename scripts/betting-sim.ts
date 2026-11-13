/**
 * Runs whole betting seasons against a simulated public and reports whether the book holds up: the house's
 * result, which kinds of bettor win or lose, how well the prices are calibrated, and whether any integrity
 * check ever failed. Seasons run in parallel as child processes.
 *
 *   npx tsx scripts/betting-sim.ts [--seasons 12] [--jobs 8] [--pool 160] [--rollouts 1200] [--z 0.5]
 *                                  [--sharp 3] [--seed 1] [--check]
 *
 *   --pool, --rollouts, --z   The house's pricing effort and safety loading (see src/betting/pricing.ts).
 *   --sharp                   How many times more simulation the sharp syndicate does than the house.
 *   --check                   Exit non-zero if any audit, fairness or fuzz check failed.
 *
 * The crowd is src/betting/punters.ts: 40 accounts with 1000 credits each per season.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { candidatePool, createSeason, isComplete } from "../src/season/season";
import { Book, defaultBookConfig, type MarketKind, type RejectCode } from "../src/betting/book";
import { KIND_LABEL } from "../src/betting/markets";
import { DEFAULT_PRICING, Pricer, type Prices } from "../src/betting/pricing";
import { defaultCrowd, type Style } from "../src/betting/punters";
import { SeasonBook } from "../src/betting/seasonBook";
import { sha256 } from "../src/betting/sha256";

const argv = process.argv.slice(2);
const flag = (name: string, dflt: number) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? Number(argv[i + 1]) : dflt;
};
const opts = {
  seasons: flag("seasons", 12),
  jobs: flag("jobs", 8),
  pool: flag("pool", DEFAULT_PRICING.poolSize),
  rollouts: flag("rollouts", DEFAULT_PRICING.rollouts),
  z: flag("z", DEFAULT_PRICING.z),
  sharp: flag("sharp", 3),
  seed: flag("seed", 1),
  one: flag("one", NaN),
  check: argv.includes("--check"),
};
const GRANT = 1000;

interface KindRow {
  markets: number;
  bets: number;
  staked: number;
  pnl: number;
  /** The house's worst result on a single market of this kind, and the bound it must stay within. */
  worst: number;
  bound: number;
  pushes: number;
  deadHeats: number;
}
interface StyleRow {
  accounts: number;
  requests: number;
  accepted: number;
  staked: number;
  net: number;
  bust: number;
}
interface SeasonReport {
  seed: number;
  champion: string;
  housePnl: number;
  bets: number;
  ledger: number;
  byKind: Partial<Record<MarketKind, KindRow>>;
  byStyle: Partial<Record<Style, StyleRow>>;
  rejects: Partial<Record<RejectCode, number>>;
  /** [model probability, realised win fraction] per priced selection. */
  calib: [number, number][];
  violations: string[];
  breaches: number;
  sims: { house: number; sharp: number };
  ms: number;
  head: string;
}

function runSeason(seed: number): SeasonReport {
  const t0 = performance.now();
  const entrants = candidatePool([], []).filter((c) => c.selected);
  let tick = 1_800_000_000_000;
  const book = new Book(defaultBookConfig(`sim${seed}`), { now: () => (tick += 250) });
  const house = new Pricer({ ...DEFAULT_PRICING, poolSize: opts.pool, rollouts: opts.rollouts, z: opts.z, seed: seed * 31 + 1 });
  const sharp = new Pricer({ ...DEFAULT_PRICING, poolSize: Math.round(opts.pool * opts.sharp), hypoMax: Math.min(96, Math.round(DEFAULT_PRICING.hypoMax * opts.sharp)), rollouts: opts.rollouts, seed: seed * 17 + 5 });
  let e = 0;
  const sb = new SeasonBook({ seasonId: `sim${seed}`, season: createSeason(entrants, seed), book, pricer: house, entropy: () => sha256(`sim-secret|${seed}|${e++}`) });
  const crowd = defaultCrowd(sb.season.entrants.map((x) => x.id));
  for (const p of crowd) book.grant(p.id, GRANT, "registration");
  let a = (seed * 2654435761) >>> 0;
  const rand = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const violations: string[] = [];
  const calib: [number, number][] = [];
  const opening = new Map<string, Record<string, number>>();
  const snapshot = () => {
    for (const m of book.markets.values()) if (!opening.has(m.id)) opening.set(m.id, Object.fromEntries(m.selections.filter((s) => s.price > 0).map((s) => [s.id, s.prob])));
  };

  sb.open();
  snapshot();
  let n = 0;
  while (!isComplete(sb.season)) {
    const finals = sharp.rollouts(sb.season);
    const view = new Map<string, Prices>();
    for (const m of book.markets.values()) if (m.status === "open") view.set(m.id, sharp.price(m, finals));
    const order = crowd.slice().sort(() => rand() - 0.5);
    // Two passes, so late money meets prices the early money has already moved.
    for (let pass = 0; pass < 2; pass++) for (const p of order) p.act({ sb, rand, n: n * 2 + pass, view });
    violations.push(...book.audit().map((v) => `window ${n}: ${v}`));
    sb.play(sb.round()[0].id);
    snapshot();
    n++;
  }
  violations.push(...sb.verify());
  // Restoring the finished season from its saved form must pass the audit and give the same book.
  try {
    const again = SeasonBook.fromJSON(JSON.parse(JSON.stringify(sb.toJSON())), { pricer: house, entropy: () => "x".repeat(32) });
    if (again.book.stateHash() !== book.stateHash()) violations.push("restored book differs from the original");
  } catch (err) {
    violations.push(`restore failed: ${(err as Error).message}`);
  }

  const byKind: SeasonReport["byKind"] = {};
  for (const m of book.markets.values()) {
    const row = (byKind[m.kind] ??= { markets: 0, bets: 0, staked: 0, pnl: 0, worst: 0, bound: 0, pushes: 0, deadHeats: 0 });
    const bets = book.betsOn(m.id);
    const pnl = book.housePnl(m.id);
    row.markets++;
    row.bets += bets.length;
    row.staked += bets.reduce((s, b) => s + b.stake, 0);
    row.pnl += pnl;
    row.worst = Math.min(row.worst, pnl);
    row.bound = m.winners * book.config.limits[m.scope].selectionCap;
    row.pushes += bets.filter((b) => b.status === "void").length;
    row.deadHeats += bets.filter((b) => b.status === "part").length;
    if (m.status !== "settled") violations.push(`market ${m.id} ended ${m.status}`);
    const open = opening.get(m.id) ?? {};
    for (const [sel, prob] of Object.entries(open)) {
      const g = m.grades?.[sel];
      if (g && g !== "void") calib.push([prob, g.num / g.den]);
    }
  }
  const byStyle: SeasonReport["byStyle"] = {};
  const rejects: SeasonReport["rejects"] = {};
  let breaches = 0;
  for (const p of crowd) {
    const row = (byStyle[p.style] ??= { accounts: 0, requests: 0, accepted: 0, staked: 0, net: 0, bust: 0 });
    row.accounts++;
    row.requests += p.stats.requests;
    row.accepted += p.stats.accepted;
    row.staked += p.stats.staked;
    row.net += book.balance(p.id) - GRANT;
    row.bust += book.balance(p.id) < 1 ? 1 : 0;
    breaches += p.stats.breaches;
    for (const [c, k] of Object.entries(p.stats.rejected)) rejects[c as RejectCode] = (rejects[c as RejectCode] ?? 0) + k!;
  }
  const housePnl = book.houseBalance - book.config.houseBank;
  if (housePnl + crowd.reduce((s, p) => s + book.balance(p.id) - GRANT, 0) !== 0) violations.push("house result and bettors' results do not sum to zero");
  return { seed, champion: sb.season.champion!, housePnl, bets: book.bets.length, ledger: book.ledger.entries.length, byKind, byStyle, rejects, calib, violations, breaches, sims: { house: house.sims, sharp: sharp.sims }, ms: Math.round(performance.now() - t0), head: book.ledger.head };
}

/* -------------------------------------------------------------------------------------------------- */

if (Number.isFinite(opts.one)) {
  process.stdout.write(JSON.stringify(runSeason(opts.one)));
} else {
  const self = fileURLToPath(import.meta.url);
  const tsx = path.resolve(path.dirname(self), "../node_modules/.bin/tsx");
  const pass = ["--pool", opts.pool, "--rollouts", opts.rollouts, "--z", opts.z, "--sharp", opts.sharp].map(String);
  const seeds = Array.from({ length: opts.seasons }, (_, i) => opts.seed + i);
  const reports: SeasonReport[] = [];
  const t0 = performance.now();
  const runOne = (seed: number) =>
    new Promise<void>((resolve, reject) => {
      const child = spawn(tsx, [self, "--one", String(seed), ...pass], { stdio: ["ignore", "pipe", "inherit"] });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.on("close", (code) => {
        if (code !== 0) return reject(new Error(`season ${seed} exited ${code}`));
        reports.push(JSON.parse(out) as SeasonReport);
        process.stderr.write(`  season ${seed} done (${reports.length}/${seeds.length})\n`);
        resolve();
      });
    });
  const queue = seeds.slice();
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(opts.jobs, seeds.length)) }, async () => {
      while (queue.length) await runOne(queue.shift()!);
    }),
  );
  reports.sort((x, y) => x.seed - y.seed);
  report(reports, (performance.now() - t0) / 1000);
}

function report(rs: SeasonReport[], secs: number) {
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const mean = (xs: number[]) => sum(xs) / Math.max(1, xs.length);
  const sd = (xs: number[]) => Math.sqrt(mean(xs.map((x) => (x - mean(xs)) ** 2)));
  const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : "-");
  const pad = (s: string | number, n: number) => String(s).padStart(n);
  const pnl = rs.map((r) => r.housePnl);
  const staked = sum(rs.map((r) => sum(Object.values(r.byKind).map((k) => k.staked))));
  console.log(`\nBETTING SIMULATION · ${rs.length} seasons · pool ${opts.pool} · rollouts ${opts.rollouts} · z ${opts.z} · sharp x${opts.sharp} · ${secs.toFixed(0)} s`);
  console.log(`  ${sum(rs.map((r) => r.bets))} bets, ${staked} credits staked, ${sum(rs.map((r) => r.ledger))} ledger entries`);
  console.log(`  house result per season: mean ${mean(pnl).toFixed(0)}, sd ${sd(pnl).toFixed(0)}, worst ${Math.min(...pnl)}, best ${Math.max(...pnl)}; winning seasons ${pnl.filter((x) => x > 0).length}/${rs.length}`);
  console.log(`  overall hold: ${pct(sum(pnl), staked)} of stakes`);

  console.log(`\n  BY MARKET                    markets    bets   staked   house   hold   worst mkt  (bound)  push  dead-heat`);
  for (const kind of Object.keys(KIND_LABEL) as MarketKind[]) {
    const rows = rs.map((r) => r.byKind[kind]).filter((x): x is KindRow => !!x);
    if (!rows.length) continue;
    const st = sum(rows.map((x) => x.staked));
    const p = sum(rows.map((x) => x.pnl));
    console.log(
      `  ${KIND_LABEL[kind].padEnd(26)} ${pad(sum(rows.map((x) => x.markets)), 8)} ${pad(sum(rows.map((x) => x.bets)), 7)} ${pad(st, 8)} ${pad(p, 7)} ${pad(pct(p, st), 6)} ${pad(Math.min(...rows.map((x) => x.worst)), 10)} ${pad(`(-${rows[0].bound})`, 9)} ${pad(sum(rows.map((x) => x.pushes)), 5)} ${pad(sum(rows.map((x) => x.deadHeats)), 10)}`,
    );
  }

  console.log(`\n  BY BETTOR      accounts  requests  accepted   staked      net     roi   bust`);
  const styles = [...new Set(rs.flatMap((r) => Object.keys(r.byStyle)))] as Style[];
  for (const s of styles) {
    const rows = rs.map((r) => r.byStyle[s]).filter((x): x is StyleRow => !!x);
    const st = sum(rows.map((x) => x.staked));
    const net = sum(rows.map((x) => x.net));
    console.log(`  ${s.padEnd(12)} ${pad(sum(rows.map((x) => x.accounts)), 9)} ${pad(sum(rows.map((x) => x.requests)), 9)} ${pad(sum(rows.map((x) => x.accepted)), 9)} ${pad(st, 8)} ${pad(net, 8)} ${pad(pct(net, st), 7)} ${pad(sum(rows.map((x) => x.bust)), 6)}`);
  }

  const rej: Record<string, number> = {};
  for (const r of rs) for (const [c, k] of Object.entries(r.rejects)) rej[c] = (rej[c] ?? 0) + k!;
  console.log(`\n  REJECTIONS  ${Object.entries(rej).sort((a, b) => b[1] - a[1]).map(([c, k]) => `${c} ${k}`).join(" · ")}`);

  const calib = rs.flatMap((r) => r.calib);
  const edges = [0, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 1.0001];
  console.log(`\n  CALIBRATION (opening model probability vs what happened, ${calib.length} priced selections)`);
  console.log(`    predicted      n    mean predicted   realised`);
  for (let i = 0; i < edges.length - 1; i++) {
    const bin = calib.filter(([p]) => p >= edges[i] && p < edges[i + 1]);
    if (bin.length) console.log(`    ${`${(edges[i] * 100).toFixed(0)}-${Math.min(100, edges[i + 1] * 100).toFixed(0)}%`.padEnd(9)} ${pad(bin.length, 6)} ${pad((100 * mean(bin.map((x) => x[0]))).toFixed(1) + "%", 14)} ${pad((100 * mean(bin.map((x) => x[1]))).toFixed(1) + "%", 10)}`);
  }
  const brier = mean(calib.map(([p, y]) => (p - y) ** 2));
  const base = mean(calib.map((x) => x[1]));
  console.log(`    Brier score ${brier.toFixed(4)} (always predicting the base rate ${(100 * base).toFixed(1)}% would score ${mean(calib.map(([, y]) => (base - y) ** 2)).toFixed(4)})`);

  const violations = rs.flatMap((r) => r.violations.map((v) => `season ${r.seed}: ${v}`));
  const breaches = sum(rs.map((r) => r.breaches));
  const overBound = rs.flatMap((r) => Object.entries(r.byKind).filter(([, k]) => -k.worst > k.bound).map(([kind]) => `season ${r.seed}: a ${kind} market lost more than its bound`));
  console.log(`\n  INTEGRITY`);
  console.log(`    audit and fairness violations: ${violations.length}`);
  console.log(`    invalid requests accepted:     ${breaches}`);
  console.log(`    markets over their loss bound: ${overBound.length}`);
  for (const v of [...violations, ...overBound].slice(0, 12)) console.log(`      ${v}`);
  console.log(`\n  PRICING COST per season: house ${mean(rs.map((r) => r.sims.house)).toFixed(0)} simulated matches, sharp ${mean(rs.map((r) => r.sims.sharp)).toFixed(0)}; ${mean(rs.map((r) => r.ms / 1000)).toFixed(0)} s of CPU`);
  console.log(`  champions: ${JSON.stringify(rs.reduce<Record<string, number>>((m, r) => ((m[r.champion] = (m[r.champion] ?? 0) + 1), m), {}))}`);
  if (opts.check) {
    const failed = violations.length + breaches + overBound.length;
    console.log(failed ? `\ncheck FAILED (${failed})` : `\ncheck passed`);
    if (failed) process.exitCode = 1;
  }
}

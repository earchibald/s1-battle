/**
 * Self-checks for scripts/league/stats.ts, by simulation: the SPRT's real error rates under the batched
 * schedule the league uses, Elo-interval coverage, and Bradley–Terry recovery of known strengths.
 *   npx tsx scripts/league/check-stats.ts
 */
import { bradleyTerry, emptyPenta, eloFromScore, ladder, pentaIndex, scoreFromElo, sprt, summarize, type Penta, type Result } from "./stats";

let st = 12345;
const rnd = () => {
  st ^= st << 13;
  st ^= st >>> 17;
  st ^= st << 5;
  return (st >>> 0) / 4294967296;
};
let failures = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${msg}`);
  if (!ok) failures++;
};

/** Pairs shaped like real ones: a per-roster lean shared by both halves (so halves correlate), no draws. */
function pair(trueElo: number): number {
  const s = scoreFromElo(trueElo);
  const lean = (rnd() - 0.5) * 0.7;
  const p1 = Math.min(1, Math.max(0, s + lean));
  const p2 = Math.min(1, Math.max(0, s - lean));
  // Half 1 and half 2 put the brains on opposite bots, so the roster lean favours A in one and B in the other.
  return pentaIndex(rnd() < p1 ? 1 : 0, rnd() < p2 ? 1 : 0);
}

check(Math.abs(eloFromScore(scoreFromElo(37)) - 37) < 1e-6, "elo ↔ score round trip");
{
  const s = summarize([10, 0, 30, 0, 60]);
  check(Math.abs(s.score - 0.75) < 1e-12, `summary score 0.75 (got ${s.score})`);
}

// Interval coverage: the 95% Elo interval should contain the true Elo ~95% of the time.
{
  let cover = 0;
  const R = 400;
  for (let r = 0; r < R; r++) {
    const p = emptyPenta();
    for (let i = 0; i < 1500; i++) p[pair(60)]++;
    const s = summarize(p);
    if (s.eloLo <= 60 && 60 <= s.eloHi) cover++;
  }
  check(cover / R > 0.92 && cover / R < 0.98, `95% Elo interval coverage ${((cover / R) * 100).toFixed(1)}%`);
}

// SPRT error rates with the league's schedule (batches of 280 pairs, cap 30000).
const cfg = { elo0: 0, elo1: 8, alpha: 0.05, beta: 0.05 };
function runSprt(trueElo: number): { decision: string; pairs: number } {
  const p: Penta = emptyPenta();
  while (true) {
    for (let i = 0; i < 280; i++) p[pair(trueElo)]++;
    const n = p.reduce((a, b) => a + b, 0);
    const s = sprt(p, cfg, 280);
    if (s.decision !== "continue" || n >= 30000) return { decision: s.decision, pairs: n };
  }
}
for (const [elo, want, limit] of [
  [0, "H1", cfg.alpha],
  [-8, "H1", cfg.alpha / 4],
  [8, "H0", cfg.beta],
] as const) {
  const R = 300;
  let wrong = 0;
  let pairs = 0;
  for (let r = 0; r < R; r++) {
    const o = runSprt(elo);
    if (o.decision === want) wrong++;
    pairs += o.pairs;
  }
  const rate = wrong / R;
  // Allow 2.5 binomial standard errors of slack over the nominal rate.
  const slack = 2.5 * Math.sqrt((limit * (1 - limit)) / R);
  check(rate <= limit + slack, `SPRT true Elo ${elo}: wrongly decided ${want} in ${(rate * 100).toFixed(1)}% (nominal ≤ ${(limit * 100).toFixed(1)}%), avg ${Math.round(pairs / R)} pairs`);
}
{
  let acc = 0;
  for (let r = 0; r < 100; r++) if (runSprt(25).decision === "H1") acc++;
  check(acc >= 98, `SPRT true Elo +25: promoted in ${acc}/100`);
}

// Bradley–Terry: recover known strengths from a round robin plus a chain.
{
  const truth: Record<string, number> = { baseline: 0, m0: 90, m1: 120, m2: 140, m3: 150 };
  const names = Object.keys(truth);
  const results: Result[] = [];
  for (let i = 0; i < names.length; i++)
    for (let j = i + 1; j < names.length; j++) {
      const p = emptyPenta();
      for (let k = 0; k < 1500; k++) p[pair(truth[names[j]] - truth[names[i]])]++;
      results.push({ a: names[j], b: names[i], penta: p });
    }
  const bt = bradleyTerry(results, "baseline");
  const worst = Math.max(...names.map((n) => Math.abs(bt[n] - truth[n])));
  check(worst < 15, `Bradley–Terry recovers strengths (worst error ${worst.toFixed(1)} Elo)`);
  const lad = ladder(results, "baseline", 100);
  const covered = lad.filter((r) => r.lo <= truth[r.player] && truth[r.player] <= r.hi).length;
  check(covered >= names.length - 1, `ladder bootstrap intervals cover ${covered}/${names.length} true strengths`);
}

process.exit(failures ? 1 : 0);

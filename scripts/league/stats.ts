/**
 * Match statistics for the improvement league. Pure functions, no I/O.
 *
 * Every comparison is played in **pairs**: the same roster and seed twice, with the two brains swapping bots.
 * A pair's score for side A is the mean of its two match scores (win 1, draw ½, loss 0), so it is one of
 * 0, ¼, ½, ¾, 1: the "pentanomial" model chess-engine testing uses (Stockfish's fishtest). Pairing cancels
 * most of the roster/seed luck, and treating the pair (not the match) as the unit keeps the variance honest
 * because the two halves of a pair are correlated.
 */

/** Pair-score categories, index i ↔ score i/4. */
export const PENTA_SCORES = [0, 0.25, 0.5, 0.75, 1] as const;
export type Penta = [number, number, number, number, number];

export const emptyPenta = (): Penta => [0, 0, 0, 0, 0];

export function addPenta(a: Penta, b: Penta): Penta {
  return a.map((x, i) => x + b[i]) as Penta;
}

/** Category for a pair from its two match scores (each 0, 0.5 or 1). */
export function pentaIndex(s1: number, s2: number): number {
  return Math.round((s1 + s2) * 2);
}

export const eloFromScore = (s: number): number => {
  const c = Math.min(1 - 1e-9, Math.max(1e-9, s));
  return -400 * Math.log10(1 / c - 1);
};
export const scoreFromElo = (e: number): number => 1 / (1 + 10 ** (-e / 400));

/** Standard normal CDF (Abramowitz–Stegun 7.1.26; |error| < 1.5e-7). */
export function phi(z: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

export interface PentaSummary {
  pairs: number;
  matches: number;
  /** Mean score per match for side A (0.5 = even). */
  score: number;
  /** Variance of the pair score (per pair). */
  pairVar: number;
  /** Standard error of `score`. */
  se: number;
  /** 95% interval for the score. */
  scoreLo: number;
  scoreHi: number;
  /** Logistic Elo of A over B, with its 95% interval. */
  elo: number;
  eloLo: number;
  eloHi: number;
  /** Likelihood of superiority: P(A is truly stronger), normal approximation. */
  los: number;
  /** Draw-free win/loss/draw count over individual matches is not recoverable from pairs; pairs are the unit. */
  penta: Penta;
}

export function summarize(p: Penta): PentaSummary {
  const n = p.reduce((a, b) => a + b, 0);
  const mean = n ? p.reduce((a, c, i) => a + c * PENTA_SCORES[i], 0) / n : 0.5;
  const v = n > 1 ? p.reduce((a, c, i) => a + c * (PENTA_SCORES[i] - mean) ** 2, 0) / (n - 1) : 0.25;
  const se = Math.sqrt(Math.max(v, 1e-12) / Math.max(n, 1));
  const lo = mean - 1.959964 * se;
  const hi = mean + 1.959964 * se;
  return {
    pairs: n,
    matches: 2 * n,
    score: mean,
    pairVar: v,
    se,
    scoreLo: lo,
    scoreHi: hi,
    elo: eloFromScore(mean),
    eloLo: eloFromScore(lo),
    eloHi: eloFromScore(hi),
    los: n ? phi((mean - 0.5) / se) : 0.5,
    penta: p,
  };
}

export interface SprtConfig {
  /** H0: A is no better than elo0 (usually 0). */
  elo0: number;
  /** H1: A is at least elo1 better. */
  elo1: number;
  /** False-promotion rate (accept H1 when H0 is true). */
  alpha: number;
  /** False-rejection rate (accept H0 when H1 is true). */
  beta: number;
}

export interface SprtState {
  llr: number;
  lower: number;
  upper: number;
  decision: "H1" | "H0" | "continue";
}

/**
 * Generalized SPRT on pair scores (normal approximation, as in fishtest's pentanomial GSPRT):
 * LLR ≈ N·(s1 − s0)·(2·x̄ − s0 − s1) / (2·σ²), with σ² the empirical pair-score variance.
 * Stop when the LLR leaves (ln(β/(1−α)), ln((1−β)/α)).
 */
export function sprt(p: Penta, c: SprtConfig, minPairs = 100): SprtState {
  const lower = Math.log(c.beta / (1 - c.alpha));
  const upper = Math.log((1 - c.beta) / c.alpha);
  const s = summarize(p);
  const s0 = scoreFromElo(c.elo0);
  const s1 = scoreFromElo(c.elo1);
  const llr = s.pairs > 1 ? (s.pairs * (s1 - s0) * (2 * s.score - s0 - s1)) / (2 * Math.max(s.pairVar, 1e-6)) : 0;
  const decision = s.pairs < minPairs ? "continue" : llr >= upper ? "H1" : llr <= lower ? "H0" : "continue";
  return { llr, lower, upper, decision };
}

/** Wilson 95% interval for a proportion (fractional successes allowed). */
export function wilson(k: number, n: number, z = 1.959964): { p: number; lo: number; hi: number } {
  if (n <= 0) return { p: NaN, lo: 0, hi: 1 };
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return { p, lo: Math.max(0, c - h), hi: Math.min(1, c + h) };
}

/** Mean and 95% interval of paired differences (e.g. candidate − champion, pair by pair on the same seeds). */
export function pairedDiff(d: number[]): { n: number; mean: number; lo: number; hi: number; se: number } {
  const n = d.length;
  const mean = n ? d.reduce((a, b) => a + b, 0) / n : 0;
  const v = n > 1 ? d.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1) : 0.25;
  const se = Math.sqrt(v / Math.max(n, 1));
  return { n, mean, se, lo: mean - 1.959964 * se, hi: mean + 1.959964 * se };
}

/* ------------------------------------------------------------------------------------------------------- */
/* Bradley–Terry ladder over every recorded comparison                                                      */
/* ------------------------------------------------------------------------------------------------------- */

export interface Result {
  a: string;
  b: string;
  penta: Penta;
}

/**
 * Maximum-likelihood Bradley–Terry strengths from match scores (each pair counts as two matches), fitted
 * with the MM algorithm, reported as Elo with `anchor` fixed at 0. A tiny prior (one drawn match against a
 * virtual anchor-strength player) keeps players with all wins or all losses finite.
 */
export function bradleyTerry(results: Result[], anchor: string, iters = 2000): Record<string, number> {
  const players = [...new Set(results.flatMap((r) => [r.a, r.b]).concat(anchor))];
  const idx = new Map(players.map((p, i) => [p, i]));
  const P = players.length;
  const W = new Float64Array(P);
  const N = new Float64Array(P * P);
  for (const r of results) {
    const i = idx.get(r.a)!;
    const j = idx.get(r.b)!;
    const pairs = r.penta.reduce((a, b) => a + b, 0);
    const scoreA = 2 * r.penta.reduce((a, c, k) => a + c * PENTA_SCORES[k], 0);
    W[i] += scoreA;
    W[j] += 2 * pairs - scoreA;
    N[i * P + j] += 2 * pairs;
    N[j * P + i] += 2 * pairs;
  }
  let g = new Float64Array(P).fill(1);
  for (let it = 0; it < iters; it++) {
    const next = new Float64Array(P);
    let delta = 0;
    for (let i = 0; i < P; i++) {
      // Prior: one virtual drawn match against a strength-1 player (½ win, 1 game).
      let den = 1 / (g[i] + 1);
      for (let j = 0; j < P; j++) if (j !== i && N[i * P + j] > 0) den += N[i * P + j] / (g[i] + g[j]);
      next[i] = (W[i] + 0.5) / den;
    }
    const a = next[idx.get(anchor)!];
    for (let i = 0; i < P; i++) {
      next[i] /= a;
      delta = Math.max(delta, Math.abs(Math.log(next[i] / g[i])));
    }
    g = next;
    if (delta < 1e-10) break;
  }
  const out: Record<string, number> = {};
  players.forEach((p, i) => (out[p] = 400 * Math.log10(g[i])));
  return out;
}

/** Multinomial resample of a pentanomial count vector. */
function resample(p: Penta, rnd: () => number): Penta {
  const n = p.reduce((a, b) => a + b, 0);
  if (!n) return p;
  const cum: number[] = [];
  p.reduce((a, c, i) => (cum[i] = a + c / n), 0);
  const out = emptyPenta();
  for (let k = 0; k < n; k++) {
    const r = rnd();
    let i = 0;
    while (i < 4 && r > cum[i]) i++;
    out[i]++;
  }
  return out;
}

/** Bradley–Terry Elo with 95% bootstrap intervals (resampling the pairs of every comparison). */
export function ladder(
  results: Result[],
  anchor: string,
  reps = 200,
  seed = 1,
): { player: string; elo: number; lo: number; hi: number; pairs: number }[] {
  let st = seed >>> 0 || 1;
  const rnd = () => {
    st ^= st << 13;
    st ^= st >>> 17;
    st ^= st << 5;
    return (st >>> 0) / 4294967296;
  };
  const point = bradleyTerry(results, anchor);
  const boots: Record<string, number[]> = {};
  for (let r = 0; r < reps; r++) {
    const bt = bradleyTerry(
      results.map((x) => ({ ...x, penta: resample(x.penta, rnd) })),
      anchor,
      400,
    );
    for (const [p, e] of Object.entries(bt)) (boots[p] ??= []).push(e);
  }
  const pairs: Record<string, number> = {};
  for (const r of results) {
    const n = r.penta.reduce((a, b) => a + b, 0);
    pairs[r.a] = (pairs[r.a] ?? 0) + n;
    pairs[r.b] = (pairs[r.b] ?? 0) + n;
  }
  return Object.entries(point)
    .map(([player, elo]) => {
      const b = (boots[player] ?? [elo]).slice().sort((x, y) => x - y);
      return { player, elo, lo: b[Math.floor(0.025 * (b.length - 1))], hi: b[Math.ceil(0.975 * (b.length - 1))], pairs: pairs[player] ?? 0 };
    })
    .sort((x, y) => y.elo - x.elo);
}

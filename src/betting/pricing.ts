import { applyResult, isComplete, nextFixture, recordFor, standings, type Fixture, type MatchOutcome, type SeasonState } from "../season/season";
import { simulateOutcome } from "../season/runner";
import { MIN_PRICE, tickFloor, type MarketKind, type MarketSpec, type Scope } from "./book";
import { MAX_MATCH_POINTS, gradeMarket } from "./markets";
import { sha256 } from "./sha256";

/**
 * Prices come from the game itself. The pricer plays the rest of the season forward many times on the real
 * match engine, grades every market on every simulated season with the same function that will settle it,
 * and turns the win frequencies into odds.
 *
 * COST      A match takes about 10 ms, so the pricer never simulates the same lineup twice more than it has to:
 *           each lineup gets a pool of simulated outcomes, and season rollouts draw from the pools. Matches are
 *           independent of each other (every match starts from fresh builds), so drawing is exact apart from
 *           the pool being finite. Fixtures that really exist get a full pool in their true start-corner
 *           order; playoff lineups that might happen get a smaller pool that grows with how often they come up.
 *
 * SAFETY    A frequency from a few hundred simulations is an estimate, and a bettor with more compute than
 *           the house could out-estimate it. So the offered price is not the fair price: the implied
 *           probability is the estimate plus `z` standard errors, times a margin, and the odds are then
 *           rounded down to the ladder and capped. Selections the model saw win almost never or almost always
 *           are not offered at all.
 *
 * The pricer never sees a real match seed: its simulations use its own seed stream, so pricing cannot leak
 * a result (see fair.ts).
 */

export interface PricingConfig {
  /** Simulated outcomes kept per real fixture. */
  poolSize: number;
  /** The most outcomes kept for a lineup that has only come up inside rollouts. */
  hypoMax: number;
  /** Seasons rolled forward per pricing. */
  rollouts: number;
  seed: number;
  /** Standard errors of the estimate added to the implied probability. */
  z: number;
  margin: Record<MarketKind, number>;
  /** Longest price offered per scope, in centi-odds. */
  maxPrice: Record<Scope, number>;
  /** Selections whose implied probability comes out above this are not offered. */
  maxImplied: number;
}

export const DEFAULT_PRICING: PricingConfig = {
  poolSize: 160,
  hypoMax: 48,
  rollouts: 1200,
  seed: 20261111,
  z: 0.5,
  margin: { match_win: 0.05, match_top2: 0.05, match_hcap: 0.04, match_kos: 0.04, round_top: 0.08, season_champion: 0.08, season_finalist: 0.06, season_league: 0.08, season_hcap: 0.08 },
  maxPrice: { match: 3400, round: 5100, season: 10100 },
  maxImplied: 0.97,
};

export type Prices = Record<string, { prob: number; price: number }>;
export type Simulate = (s: SeasonState, fx: Fixture) => MatchOutcome;

function mulberry(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Turn a fair probability estimate from `n` effective samples into an offered price (0 = not offered). */
export function offeredPrice(prob: number, n: number, margin: number, z: number, maxPrice: number, maxImplied: number): number {
  if (!(prob > 0) || n < 1) return 0;
  const se = Math.sqrt((prob * (1 - prob)) / n);
  const implied = (prob + z * se) * (1 + margin);
  if (implied > maxImplied) return 0;
  const price = Math.min(maxPrice, tickFloor(Math.floor(100 / implied)));
  return price >= MIN_PRICE ? price : 0;
}

export class Pricer {
  readonly config: PricingConfig;
  private simulate: Simulate;
  private rand: () => number;
  private pools = new Map<string, { outs: MatchOutcome[]; hits: number }>();
  private tags = new WeakMap<object, string>();
  /** Matches simulated so far (for reporting the cost of pricing). */
  sims = 0;

  constructor(config: PricingConfig = DEFAULT_PRICING, simulate: Simulate = simulateOutcome) {
    this.config = config;
    this.simulate = simulate;
    this.rand = mulberry(config.seed);
  }

  /** Pools are keyed by the builds as well as the names, so one pricer can serve many seasons safely. */
  private tag(s: SeasonState): string {
    let t = this.tags.get(s.entrants);
    if (!t) this.tags.set(s.entrants, (t = sha256(JSON.stringify(s.entrants.map((e) => [e.id, e.build]))).slice(0, 16)));
    return t;
  }

  private draw(s: SeasonState, fx: Fixture, real: boolean): MatchOutcome {
    const lineup = real ? fx.bots : fx.bots.slice().sort();
    const key = `${this.tag(s)}|${real ? "o" : "c"}|${lineup.join(",")}`;
    let pool = this.pools.get(key);
    if (!pool) this.pools.set(key, (pool = { outs: [], hits: 0 }));
    pool.hits++;
    const want = real ? this.config.poolSize : Math.min(this.config.hypoMax, 4 + (pool.hits >> 2));
    while (pool.outs.length < want) {
      pool.outs.push(this.simulate(s, { ...fx, bots: lineup, seed: Math.floor(this.rand() * 4294967296) >>> 0 }));
      this.sims++;
    }
    return pool.outs[Math.floor(this.rand() * pool.outs.length)];
  }

  /** Play the season out from where it stands, `rollouts` times. Each result is a complete SeasonState. */
  rollouts(s: SeasonState): SeasonState[] {
    const real = new Set(s.fixtures.map((f) => f.id));
    const out: SeasonState[] = [];
    for (let i = 0; i < this.config.rollouts; i++) {
      let st = s;
      while (!isComplete(st)) {
        const fx = nextFixture(st);
        if (!fx) break;
        st = applyResult(st, fx.id, this.draw(s, fx, real.has(fx.id)), true);
      }
      out.push(st);
    }
    return out;
  }

  /**
   * Set a market's line from the rollouts: the handicap or total closest to an even contest, on half points
   * so it cannot push, and the season head starts that level the league. Returns a new spec.
   */
  fit(spec: MarketSpec, finals: SeasonState[]): MarketSpec {
    const evenLine = (diffs: number[], lines: number[]) => {
      let best = lines[0];
      let gap = Infinity;
      for (const l of lines) {
        const g = Math.abs(diffs.filter((d) => d + l > 0).length / Math.max(1, diffs.length) - 0.5);
        if (g < gap - 1e-12 || (Math.abs(g - gap) <= 1e-12 && Math.abs(l) < Math.abs(best))) (best = l), (gap = g);
      }
      return best;
    };
    if (spec.kind === "match_hcap") {
      const { a, b } = spec.params;
      const diffs: number[] = [];
      for (const st of finals) {
        const rec = recordFor(st, spec.fixtureId!);
        if (rec) diffs.push(2 * ((rec.rows.find((r) => r.id === a)?.points ?? 0) - (rec.rows.find((r) => r.id === b)?.points ?? 0)));
      }
      const lines: number[] = [];
      for (let l = -(2 * MAX_MATCH_POINTS - 1); l <= 2 * MAX_MATCH_POINTS - 1; l += 2) lines.push(l);
      return { ...spec, params: { ...spec.params, line2: evenLine(diffs, lines) } };
    }
    if (spec.kind === "match_kos") {
      const diffs: number[] = [];
      for (const st of finals) {
        const rec = recordFor(st, spec.fixtureId!);
        if (rec) diffs.push(2 * rec.rows.filter((r) => r.eliminated).length);
      }
      return { ...spec, params: { ...spec.params, line2: -evenLine(diffs, [-1, -3, -5, -7]) } };
    }
    if (spec.kind === "season_hcap") {
      const mean = new Map<string, number>();
      for (const st of finals) for (const r of standings(st)) mean.set(r.id, (mean.get(r.id) ?? 0) + r.points / finals.length);
      const top = Math.max(...spec.selections.map((x) => mean.get(x.id) ?? 0));
      return { ...spec, params: { ...spec.params, handicaps: Object.fromEntries(spec.selections.map((x) => [x.id, Math.round(top - (mean.get(x.id) ?? 0))])) } };
    }
    return spec;
  }

  /** Price every selection of a market from the rollouts. */
  price(spec: MarketSpec, finals: SeasonState[]): Prices {
    const won = new Map<string, number>(spec.selections.map((x) => [x.id, 0]));
    const counted = new Map<string, number>(spec.selections.map((x) => [x.id, 0]));
    for (const st of finals) {
      const grades = gradeMarket(spec, st);
      if (!grades) continue;
      for (const x of spec.selections) {
        const g = grades[x.id];
        if (g === "void") continue;
        counted.set(x.id, counted.get(x.id)! + 1);
        won.set(x.id, won.get(x.id)! + g.num / g.den);
      }
    }
    const c = this.config;
    // Match and round markets hang on one or two fixtures, so their evidence is the pool, not the rollout count.
    const cap = spec.scope === "season" ? c.rollouts : Math.min(c.rollouts, c.poolSize);
    const out: Prices = {};
    for (const x of spec.selections) {
      const n = counted.get(x.id)!;
      const w = won.get(x.id)!;
      if (n === 0) {
        out[x.id] = { prob: 0, price: 0 };
        continue;
      }
      const prob = w / n;
      // A selection that never won in the rollouts has no price: the model cannot tell 1 in 500 from never.
      const smoothed = (w + 0.5) / (n + 1);
      out[x.id] = { prob, price: w > 0 ? offeredPrice(smoothed, Math.min(n, cap), c.margin[spec.kind], c.z, c.maxPrice[spec.scope], c.maxImplied) : 0 };
    }
    return out;
  }
}

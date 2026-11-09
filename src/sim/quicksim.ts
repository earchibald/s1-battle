import type { BotDef } from "@shared/bots/common";
import { World } from "./world";
import { sense } from "./perception";

/**
 * Runs matches with baseline brains only, no renderer, no Jev. Deterministic for a seed. Shared by the
 * headless tuning script and by the designer's "simulate" button, so it is DOM-free and chunkable.
 */

export interface QuickSimResult {
  matches: number;
  wins: Record<string, number>;
  reasons: Record<string, number>;
  eliminations: Record<string, number>;
  lengths: number[];
  /** Per bot: average hp left when alive at the end, average damage dealt. */
  perBot: Record<string, { damage: number; survived: number; pitted: number; destroyed: number; decisions: number }>;
  /** Per bot: how many baseline decisions each rule id produced ("default" when nothing matched). */
  rules: Record<string, Record<string, number>>;
}

export interface QuickSimOptions {
  matches: number;
  seed?: number;
  /** Seconds between baseline decisions. */
  cadence?: number;
  /** Called after each match so a UI can show progress and yield to the event loop. */
  onMatch?(index: number, result: QuickSimResult, world: World): void | Promise<void>;
}

export function runMatch(lineup: BotDef[], seed: number, cadence?: number, onDecision?: (bot: string, ruleId: string) => void): World {
  const DT = 1 / 60;
  const w = new World(lineup, seed);
  // Each bot thinks at its own cadence (sensors); `cadence` overrides for tuning scripts.
  const cadenceOf = (b: { def: BotDef }) => cadence ?? b.def.stats.cadence;
  // Stagger the first decisions deterministically from the seed.
  const timers = new Map(w.bots.map((b, i) => [b.id, (((seed * 7 + i * 13) % 10) / 10) * cadenceOf(b)]));
  let steps = 0;
  while (w.phase !== "ended" && steps < 60 * 400) {
    w.step(DT);
    steps++;
    if (w.phase !== "fighting") continue;
    for (const b of w.bots) {
      if (!b.alive) continue;
      const t = timers.get(b.id)! - DT;
      if (t <= 0) {
        timers.set(b.id, cadenceOf(b));
        b.intent = b.def.baseline(sense(b, w.bots, w.fightTime, w.timeLeft));
        b.stats.decisions++;
        onDecision?.(b.id, b.intent.ruleId ?? "default");
      } else timers.set(b.id, t);
    }
    w.drainEvents();
  }
  return w;
}

export async function quickSim(defs: BotDef[], opts: QuickSimOptions): Promise<QuickSimResult> {
  const seed0 = opts.seed ?? 1;
  const res: QuickSimResult = { matches: 0, wins: {}, reasons: {}, eliminations: {}, lengths: [], perBot: {}, rules: {} };
  for (const d of defs) {
    res.perBot[d.name] = { damage: 0, survived: 0, pitted: 0, destroyed: 0, decisions: 0 };
    res.rules[d.name] = {};
  }
  for (let m = 0; m < opts.matches; m++) {
    // Rotate start slots so no bot always gets the same corner.
    const lineup = defs.map((_, i) => defs[(i + m) % defs.length]);
    const w = runMatch(lineup, seed0 + m, opts.cadence, (bot, rule) => {
      const r = res.rules[bot];
      if (r) r[rule] = (r[rule] ?? 0) + 1;
    });
    const r = w.result!;
    res.matches++;
    res.wins[r.winner ?? "draw"] = (res.wins[r.winner ?? "draw"] ?? 0) + 1;
    res.reasons[r.reason] = (res.reasons[r.reason] ?? 0) + 1;
    res.lengths.push(w.fightTime);
    for (const b of w.bots) {
      const pb = res.perBot[b.id];
      if (!pb) continue;
      pb.damage += b.stats.damageDealt;
      pb.decisions += b.stats.decisions;
      if (b.alive) pb.survived++;
      if (b.eliminated === "pitted") pb.pitted++;
      if (b.eliminated === "destroyed") pb.destroyed++;
      res.eliminations[b.eliminated ?? "survived"] = (res.eliminations[b.eliminated ?? "survived"] ?? 0) + 1;
    }
    if (opts.onMatch) await opts.onMatch(m, res, w);
  }
  return res;
}

export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

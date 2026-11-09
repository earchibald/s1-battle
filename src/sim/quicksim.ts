import type { BotDef } from "@shared/bots/common";
import type { Bot } from "./bot";
import { Driver, baselinePolicy, type Policy } from "./driver";
import type { World } from "./world";

/**
 * Runs matches with synchronous brains (baseline by default), no renderer, no Jev. Deterministic for a seed. Shared by the
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
  /** Brain per bot; default: every bot on its baseline rule tree. */
  policyFor?: (bot: Bot) => Policy;
  /** Called after each match so a UI can show progress and yield to the event loop. */
  onMatch?(index: number, result: QuickSimResult, world: World): void | Promise<void>;
}

export function runMatch(
  lineup: BotDef[],
  seed: number,
  cadence?: number,
  onDecision?: (bot: string, ruleId: string) => void,
  policyFor: (bot: Bot) => Policy = () => baselinePolicy,
): World {
  const d = Driver.start(lineup, seed, policyFor, { cadence, onDecision: (b, intent) => onDecision?.(b.id, intent.ruleId ?? "default") });
  return d.run();
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
    const w = runMatch(
      lineup,
      seed0 + m,
      opts.cadence,
      (bot, rule) => {
        const r = res.rules[bot];
        if (r) r[rule] = (r[rule] ?? 0) + 1;
      },
      opts.policyFor,
    );
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

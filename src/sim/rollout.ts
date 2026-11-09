import type { Intent } from "@shared/types";
import type { Bot } from "./bot";
import type { Driver, Policy } from "./driver";

/**
 * Counterfactual rollouts: fork the match, force one bot onto a given intent for `commit` seconds, let
 * everyone (including that bot, afterwards) play on with their usual brains until `horizon`, and score what
 * happened to the forced bot. The score is a vector, not a number, so a style can weigh the parts later
 * without retraining:
 *
 *   dealt   damage I dealt (incl. the health of anyone I put in the pit), per 100 hp
 *   taken   damage I took, per 100 hp
 *   kills   opponents I eliminated
 *   died    1 if I was eliminated
 *   crit    damage I dealt with critical hits, per 100 hp (also counted in dealt)
 *   hazard  damage I dealt through walls, kill saws and the pit, per 100 hp (also counted in dealt)
 */

export const COMPONENTS = ["dealt", "taken", "kills", "died", "crit", "hazard"] as const;
export type Component = (typeof COMPONENTS)[number];
export const N_COMPONENTS = COMPONENTS.length;

export interface RolloutOptions {
  /** Seconds the forced intent is held before the bot's own brain takes over again. */
  commit: number;
  /** Seconds simulated in total. */
  horizon: number;
}

export function rollout(d: Driver, botId: string, intent: Intent, opts: RolloutOptions, continuation: (bot: Bot) => Policy): Float32Array {
  const f = d.fork(continuation);
  const w = f.world;
  const me = w.bot(botId)!;
  me.intent = intent;
  f.pins.set(botId, { intent, until: w.fightTime + opts.commit });
  const dealt0 = me.stats.damageDealt;
  const taken0 = me.stats.damageTaken;
  const wasAlive = me.alive;
  let hitDealt = 0;
  let crit = 0;
  let hazard = 0;
  let kills = 0;
  const end = w.fightTime + opts.horizon;
  while (!f.over && w.fightTime < end) {
    for (const e of f.step()) {
      if (e.type === "hit" && e.attacker === botId && e.victim !== botId) {
        hitDealt += e.amount;
        if (e.crit) crit += e.amount;
        if (e.weapon === "saws" || e.weapon === "wall") hazard += e.amount;
      } else if ((e.type === "destroyed" || e.type === "pitted") && e.by === botId && e.bot !== botId) kills++;
    }
  }
  const dealt = me.stats.damageDealt - dealt0;
  // Pit eliminations credit the victim's remaining health without a hit event.
  hazard += Math.max(0, dealt - hitDealt);
  const out = new Float32Array(N_COMPONENTS);
  out[0] = dealt / 100;
  out[1] = (me.stats.damageTaken - taken0) / 100;
  out[2] = kills;
  out[3] = wasAlive && !me.alive ? 1 : 0;
  out[4] = crit / 100;
  out[5] = hazard / 100;
  return out;
}

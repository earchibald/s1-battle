/**
 * Row layout of the training datasets (data/<name>/shard-*.f32). Each row is one decision moment of one bot,
 * float32, fields back to back in this order. `train.py` reads the same layout from meta.json.
 */
import { FEATURE_VERSION, MAX_OPPS, MANEUVERS, N_MANEUVERS, OPP_DIM, SELF_DIM } from "../../src/sim/features";
import { COMPONENTS, N_COMPONENTS } from "../../src/sim/rollout";

export const FIELDS: [string, number][] = [
  ["self", SELF_DIM],
  ["opps", MAX_OPPS * OPP_DIM],
  ["opp_mask", MAX_OPPS],
  /** 1 where the maneuver is installed and its gate holds right now. */
  ["avail", N_MANEUVERS],
  /** Rollout outcome per [opponent slot][maneuver][component]. */
  ["q", MAX_OPPS * N_MANEUVERS * N_COMPONENTS],
  /** 1 where that (slot, maneuver) pair was rolled out. */
  ["q_mask", MAX_OPPS * N_MANEUVERS],
  /** Did this bot take damage within HIT_HORIZON seconds on the real (behavior) trajectory. */
  ["hit_soon", 1],
  /** 1 when the bot's behavior brain was the trained model, 0 for baseline. */
  ["behavior_model", 1],
];
export const ROW = FIELDS.reduce((a, [, n]) => a + n, 0);
export const OFFSET: Record<string, number> = {};
{
  let o = 0;
  for (const [k, n] of FIELDS) {
    OFFSET[k] = o;
    o += n;
  }
}
export const HIT_HORIZON = 1.5;

export function meta(extra: Record<string, unknown>) {
  return {
    feature_version: FEATURE_VERSION,
    self_dim: SELF_DIM,
    opp_dim: OPP_DIM,
    max_opps: MAX_OPPS,
    maneuvers: MANEUVERS,
    n_maneuvers: N_MANEUVERS,
    components: COMPONENTS,
    n_components: N_COMPONENTS,
    row: ROW,
    fields: FIELDS,
    ...extra,
  };
}

import type { BotKind, Maneuver } from "../types";
import type { BotBuild, TechniqueLogic } from "../build";
import { TECHNIQUE_BY_M, cloneBuild } from "../build";
import type { BotDef } from "./common";
import { defFromBuild } from "../logic";
import { SAW_BUILD } from "./saw";
import { HAMMER_BUILD } from "./hammer";
import { GRABBER_BUILD } from "./grabber";
import { FLIPPER_BUILD } from "./flipper";
import { SPINNER_BUILD } from "./spinner";
import { TORCH_BUILD } from "./torch";
import { RAM_BUILD } from "./ram";

export * from "./common";
export { SAW_BUILD, HAMMER_BUILD, GRABBER_BUILD, FLIPPER_BUILD, SPINNER_BUILD, TORCH_BUILD, RAM_BUILD };

/** The stock bots, one per weapon system, as builds. Everything else derives from these. */
export const STOCK_BUILDS: Record<BotKind, BotBuild> = {
  saw: SAW_BUILD,
  hammer: HAMMER_BUILD,
  grabber: GRABBER_BUILD,
  flipper: FLIPPER_BUILD,
  spinner: SPINNER_BUILD,
  torch: TORCH_BUILD,
  ram: RAM_BUILD,
};
/** The default roster is the first four. */
export const STOCK_ORDER: BotKind[] = ["saw", "hammer", "grabber", "flipper", "spinner", "torch", "ram"];
export const DEFAULT_ROSTER: BotKind[] = ["saw", "hammer", "grabber", "flipper"];

export function stockBuild(kind: BotKind): BotBuild {
  return cloneBuild(STOCK_BUILDS[kind]);
}

/** Stock defs, for the headless runner and for anything that just wants "a saw bot". */
export const BOT_DEFS: Record<BotKind, BotDef> = Object.fromEntries(STOCK_ORDER.map((k) => [k, defFromBuild(STOCK_BUILDS[k])])) as Record<BotKind, BotDef>;

export function botDef(kind: BotKind): BotDef {
  return BOT_DEFS[kind];
}

/** Jev text + gate for a technique a designer just installed: the stock wording for that weapon, or the catalogue blurb. */
export function defaultTechniqueLogic(m: Maneuver, kind: BotKind): TechniqueLogic {
  const stock = STOCK_BUILDS[kind].logic.jev.techniques[m];
  if (stock) return { description: stock.description, when: stock.when.map((c) => ({ ...c })) };
  for (const k of STOCK_ORDER) {
    const t = STOCK_BUILDS[k].logic.jev.techniques[m];
    if (t) return { description: t.description, when: [] };
  }
  return { description: TECHNIQUE_BY_M[m]?.blurb ?? m, when: [] };
}

export { defFromBuild };

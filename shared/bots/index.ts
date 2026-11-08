import type { BotKind, Maneuver } from "../types";
import type { BotBuild, TechniqueLogic } from "../build";
import { TECHNIQUE_BY_M, cloneBuild } from "../build";
import type { BotDef } from "./common";
import { defFromBuild } from "../logic";
import { SAW_BUILD } from "./saw";
import { HAMMER_BUILD } from "./hammer";
import { GRABBER_BUILD } from "./grabber";
import { FLIPPER_BUILD } from "./flipper";

export * from "./common";
export { SAW_BUILD, HAMMER_BUILD, GRABBER_BUILD, FLIPPER_BUILD };

/** The four stock bots, as builds. Everything else derives from these. */
export const STOCK_BUILDS: Record<BotKind, BotBuild> = {
  saw: SAW_BUILD,
  hammer: HAMMER_BUILD,
  grabber: GRABBER_BUILD,
  flipper: FLIPPER_BUILD,
};
export const STOCK_ORDER: BotKind[] = ["saw", "hammer", "grabber", "flipper"];

export function stockBuild(kind: BotKind): BotBuild {
  return cloneBuild(STOCK_BUILDS[kind]);
}

/** Stock defs, for the headless runner and for anything that just wants "a saw bot". */
export const BOT_DEFS: Record<BotKind, BotDef> = {
  saw: defFromBuild(SAW_BUILD),
  hammer: defFromBuild(HAMMER_BUILD),
  grabber: defFromBuild(GRABBER_BUILD),
  flipper: defFromBuild(FLIPPER_BUILD),
};

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

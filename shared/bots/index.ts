import type { BotKind } from "../types";
import type { BotDef } from "./common";
import { SAW } from "./saw";
import { HAMMER } from "./hammer";
import { GRABBER } from "./grabber";
import { FLIPPER } from "./flipper";

export * from "./common";
export { SAW, HAMMER, GRABBER, FLIPPER };

export const BOT_DEFS: Record<BotKind, BotDef> = {
  saw: SAW,
  hammer: HAMMER,
  grabber: GRABBER,
  flipper: FLIPPER,
};

export function botDef(kind: BotKind): BotDef {
  return BOT_DEFS[kind];
}

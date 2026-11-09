import type { HitWeapon, SimEvent } from "../sim/events";

/**
 * Which sim events earn a comic callout. Pure and DOM-free so scripts/callout-survey.ts can measure it.
 *
 * Callouts are reserved for moments a viewer should look up for: eliminations, big critical hits and
 * hits that take a big bite. Everything else (and anything inside the cooldown after a callout) stays
 * in the ticker and the event log. Eliminations always show and are never blocked by the cooldown.
 */

export type CalloutKind = HitWeapon | "pitted" | "destroyed";

export interface CalloutPick {
  kind: CalloutKind;
  /** 1 normal, up to 2 huge. */
  size: number;
  crit: boolean;
  /** Plain-language caption shown under the word: who did what to whom. */
  caption: string;
  /** 3 elimination, 2 big crit / huge hit. Higher clears lower ones off the screen. */
  priority: number;
}

/** A critical needs at least this much damage to be shouted about (torch and crush crits tick small). */
export const CRIT_MIN = 20;
/** A non-critical hit needs this much. */
export const BIG_HIT = 30;
/** Game seconds after any callout before another non-elimination callout may show. */
export const COOLDOWN = 4;

const VERB: Record<HitWeapon, string> = {
  saw: "shreds",
  hammer: "hammers",
  crush: "crushes",
  flip: "flips",
  landing: "lands hard",
  wall: "hits the wall",
  saws: "chewed by floor saws",
  spinner: "smacks",
  torch: "torches",
  ram: "rams",
  vent: "roasted by a vent",
  shock: "zapped by a shock plate",
};

export class CalloutDirector {
  private lastAt = -Infinity;

  /** Call for every sim event in order; returns the callout to show, if any. */
  pick(e: SimEvent, now: number): CalloutPick | null {
    if (e.type === "destroyed") {
      this.lastAt = now;
      return { kind: "destroyed", size: 2, crit: false, caption: e.by ? `${e.by} wrecks ${e.bot}` : `${e.bot} is wrecked`, priority: 3 };
    }
    if (e.type === "pitted") {
      this.lastAt = now;
      return { kind: "pitted", size: 1.7, crit: false, caption: e.by ? `${e.by} pits ${e.bot}` : `${e.bot} falls in the pit`, priority: 3 };
    }
    if (e.type !== "hit" || now - this.lastAt < COOLDOWN) return null;
    const bigCrit = e.crit && e.amount >= CRIT_MIN;
    const huge = e.amount >= BIG_HIT;
    if (!bigCrit && !huge) return null;
    this.lastAt = now;
    const n = Math.round(e.amount);
    const solo = e.weapon === "landing" || e.weapon === "wall" || e.weapon === "saws" || e.weapon === "vent" || e.weapon === "shock";
    const caption = solo ? `${e.victim} ${VERB[e.weapon]} · ${n}` : `${e.attacker} ${VERB[e.weapon]} ${e.victim} · ${n}`;
    return { kind: e.weapon, size: e.amount >= 35 ? 1.5 : 1.2, crit: e.crit, caption, priority: 2 };
  }
}

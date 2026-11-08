import type { BotDef, BotSense, Question } from "./common";
import { anyThreat, baselineIntent, nearest, weakest } from "./common";
import type { Maneuver } from "../types";

/**
 * LAUNCHER: low wedge with a pneumatic flipper plate. Gets under an opponent and throws it into
 * the air; the landing hurts, and a wall or the pit hurts more. Quick, moderate armor, long
 * recharge between flips. Wants side and rear approaches where its wedge slides underneath.
 */
export const FLIPPER: BotDef = {
  kind: "flipper",
  name: "LAUNCHER",
  weapon: "pneumatic flipper wedge",
  tagline: "Everything is airborne eventually.",
  color: 0xff7a1a,
  accent: 0x2a1c12,
  stats: { hp: 350, mass: 1.15, maxSpeed: 6.6, accel: 13, turnRate: 4.3, armor: 0.12, radius: 0.9 },
  maneuvers: {
    engage: "Drive wedge-first under the target's front so the flipper can get beneath it.",
    flip_now:
      "Fire the flipper this instant. Only sensible when an opponent is touching or close and roughly dead ahead, and the flipper is charged.",
    flank: "Get around to the target's side or rear, where the wedge slides under without taking a hit.",
    circle: "Keep medium distance and circle while the flipper recharges or the target is dangerous.",
    retreat: "Back away from the nearest threat. Only worth it when a ready weapon is pointed at me from close range and my flipper is recharging.",
  },
  available(sense) {
    const list: Maneuver[] = ["engage", "flank", "circle", "retreat"];
    if (sense.facts.weaponReady && sense.facts.opponents.some((o) => o.inReach)) list.unshift("flip_now");
    return list;
  },
  extraQuestions(sense: BotSense): Record<string, Question> {
    if (!sense.facts.weaponReady) return {};
    return {
      flip_toward_hazard: {
        type: "noul",
        instructions:
          "If `me` flips the nearest opponent right now, would it be thrown toward the open pit or toward the kill saws? Yes only when a hazard is close and in roughly the same direction as that opponent.",
      },
    };
  },
  baseline(sense) {
    const f = sense.facts;
    const ops = f.opponents;
    if (ops.length === 0) return baselineIntent(null, "hold", 0, "nobody left");
    const threat = anyThreat(ops);
    const near = nearest(ops)!;
    const weak = weakest(ops)!;
    const target = weak.hpFrac < 0.4 && weak.dist < near.dist + 3 ? weak : near;
    const inReach = ops.find((o) => o.inReach && !o.airborne);
    if (f.weaponReady && inReach) return baselineIntent(inReach.name, "flip_now", 0.3, `${inReach.name} is on the plate`);
    if (!f.weaponReady) {
      if (threat && threat.dist < 2.5) return baselineIntent(target.name, "retreat", 0.8, "flipper recharging, back off");
      return baselineIntent(target.name, "circle", 0.3, "flipper recharging, circle");
    }
    if (target.stunned || target.airborne) return baselineIntent(target.name, "engage", 0.1, `${target.name} is helpless, close in`);
    if (target.facingMe > 0.5 && target.weaponReady && target.kind !== "flipper") {
      return baselineIntent(target.name, "flank", threat ? 0.5 : 0.2, `${target.name} faces me, go around`);
    }
    return baselineIntent(target.name, "engage", 0.1, `wedge under ${target.name}`);
  },
};

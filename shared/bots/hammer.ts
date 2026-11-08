import type { BotDef, BotSense, Question } from "./common";
import { anyThreat, baselineIntent, nearest, weakest } from "./common";
import type { Maneuver } from "../types";

/**
 * PILEDRIVER: the heavyweight. Slow and armored with an overhead pneumatic hammer. Each strike has a
 * short windup, a long cooldown, and hits like a truck. Wants opponents to come to it, and wants
 * to commit the hammer only when a hit is certain.
 */
export const HAMMER: BotDef = {
  kind: "hammer",
  name: "PILEDRIVER",
  weapon: "overhead pneumatic hammer",
  tagline: "Slow. Armored. Terminal.",
  color: 0xd13b3b,
  accent: 0x2b2b30,
  stats: { hp: 350, mass: 1.7, maxSpeed: 4.6, accel: 9, turnRate: 3.1, armor: 0.35, radius: 1.0 },
  maneuvers: {
    engage: "Drive at the target to get it within hammer reach, keeping my front toward it.",
    strike_now:
      "Bring the hammer down this instant. Only sensible when an opponent is touching or close and roughly dead ahead, and the hammer is ready.",
    hold:
      "Stop, keep turning to face the target, and wait with the hammer raised so anything that rushes me gets hit first.",
    circle: "Keep medium distance and circle while the hammer recharges.",
    retreat: "Back away to avoid a hit. Only worth it when a flipper or grabber is close, facing me, with its weapon ready, and my hammer is not ready.",
  },
  available(sense) {
    const list: Maneuver[] = ["engage", "hold", "circle", "retreat"];
    if (sense.facts.weaponReady && sense.facts.opponents.some((o) => o.inReach)) list.unshift("strike_now");
    return list;
  },
  extraQuestions(sense: BotSense): Record<string, Question> {
    if (!sense.facts.weaponReady) return {};
    return {
      strike_will_land: {
        type: "noul",
        instructions:
          "If `me` fires the hammer right now, will it come down on an opponent? Yes when an opponent is touching or close and dead ahead or slightly to one side.",
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
    const target = weak.hpFrac < 0.3 && weak.dist < 6 ? weak : near;

    const inReach = ops.find((o) => o.inReach);
    if (f.weaponReady && inReach) {
      return baselineIntent(inReach.name, "strike_now", threat ? 0.6 : 0.2, `${inReach.name} is under the hammer`);
    }
    if (!f.weaponReady) {
      // Recharging: don't chase, hold ground facing the nearest bot unless something scary is incoming.
      if (threat && threat.dist < 2.5 && (threat.kind === "flipper" || threat.kind === "grabber")) {
        return baselineIntent(target.name, "retreat", 0.8, `hammer cooling, ${threat.name} too close`);
      }
      return baselineIntent(target.name, "hold", threat ? 0.5 : 0.1, "hammer recharging, hold the line");
    }
    if (target.dist < 3.5) {
      return baselineIntent(target.name, "hold", threat ? 0.4 : 0.1, `let ${target.name} come to me`);
    }
    return baselineIntent(target.name, "engage", 0.1, `close in on ${target.name}`);
  },
};

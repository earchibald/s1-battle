import type { BotDef, BotSense, Question } from "./common";
import { anyThreat, baselineIntent, nearest, weakest } from "./common";
import type { Maneuver } from "../types";

/**
 * CLAMP: the control bot. A hydraulic grabbing arm seizes an opponent, squeezes, and drags it
 * wherever CLAMP likes: into the pit, onto the kill saws, or just away from its friends.
 * Mid-weight, decent armor, no burst damage of its own.
 */
export const GRABBER: BotDef = {
  kind: "grabber",
  name: "CLAMP",
  weapon: "hydraulic grabbing arm",
  tagline: "Where you go is up to me now.",
  color: 0x2dd4bf,
  accent: 0x14323a,
  stats: { hp: 350, mass: 1.35, maxSpeed: 5.6, accel: 11, turnRate: 3.9, armor: 0.2, radius: 0.95 },
  maneuvers: {
    engage: "Drive at the target with the jaws open to get it between them.",
    grab_now:
      "Close the jaws this instant. Only sensible when an opponent is touching or close and roughly dead ahead, and the arm is ready.",
    flank: "Approach the target from its side or rear so I can grab it where it cannot hit back.",
    circle: "Keep medium distance and circle the target, waiting for it to turn away.",
    retreat: "Back away from the nearest threat. Only worth it when a ready weapon is pointed at me from close range and my jaws are recharging.",
    drag_to_pit:
      "While holding an opponent, drag it toward the open pit and drop it in. Only possible when the pit is open.",
    drag_to_saws:
      "While holding an opponent, drag it onto the arena's kill saws so the floor blades chew it up. Best when the saws are up or about to rise.",
    crush: "While holding an opponent, stay put and squeeze it in the jaws for steady damage.",
    release: "Let go of the held opponent, for example to escape a third bot that is about to hit me.",
  },
  available(sense) {
    const f = sense.facts;
    if (f.holding) {
      const list: Maneuver[] = ["crush", "drag_to_saws", "release"];
      if (f.pitOpen) list.unshift("drag_to_pit");
      return list;
    }
    const list: Maneuver[] = ["engage", "flank", "circle", "retreat"];
    if (f.weaponReady && f.opponents.some((o) => o.inReach)) list.unshift("grab_now");
    return list;
  },
  extraQuestions(sense: BotSense): Record<string, Question> {
    if (sense.facts.holding) {
      return {
        third_party_threat: {
          type: "noul",
          instructions:
            "Is a *different* opponent (not the one `me` is holding) close and about to hit `me` while my jaws are busy?",
        },
      };
    }
    return {};
  },
  baseline(sense) {
    const f = sense.facts;
    const ops = f.opponents;
    if (ops.length === 0) return baselineIntent(null, "hold", 0, "nobody left");
    const threat = anyThreat(ops);

    if (f.holding) {
      const other = ops.find((o) => o.name !== f.holding && o.threatening && o.dist < 3);
      if (other) return baselineIntent(f.holding, "release", 0.9, `${other.name} is on me, let go`);
      if (f.pitOpen) return baselineIntent(f.holding, "drag_to_pit", 0.3, `pit is open, drag ${f.holding} in`);
      if (f.sawsUp || f.sawsSoon) return baselineIntent(f.holding, "drag_to_saws", 0.3, `feed ${f.holding} to the saws`);
      return baselineIntent(f.holding, "crush", 0.2, `squeeze ${f.holding}`);
    }

    const near = nearest(ops)!;
    const weak = weakest(ops)!;
    const target = weak.hpFrac < 0.4 && weak.dist < near.dist + 3 ? weak : near;
    const inReach = ops.find((o) => o.inReach);
    if (f.weaponReady && inReach) return baselineIntent(inReach.name, "grab_now", 0.3, `${inReach.name} is in the jaws`);
    if (!f.weaponReady) return baselineIntent(target.name, "circle", threat ? 0.6 : 0.2, "arm recharging, keep distance");
    if (threat && threat.dist < 2.5 && f.hpFrac < 0.4) {
      return baselineIntent(target.name, "retreat", 0.8, `${threat.name} is lining me up`);
    }
    if (target.facingMe > 0.5 && target.weaponReady && target.kind !== "grabber") {
      return baselineIntent(target.name, "flank", 0.3, `${target.name} faces me, go around`);
    }
    return baselineIntent(target.name, "engage", 0.1, `jaws open for ${target.name}`);
  },
};

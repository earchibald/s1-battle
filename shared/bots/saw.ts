import type { BotDef, BotSense } from "./common";
import { anyThreat, baselineIntent, nearest, weakest } from "./common";
import type { Maneuver } from "../types";

/**
 * RIPSAW: light, quick, glass cannon. A vertical spinning saw blade at the front does continuous
 * damage on contact and throws both bots around, but the blade needs time to spin up and the
 * chassis is thin. Wants to attack from the side or rear and never trade head-on with a ready hammer.
 */
export const SAW: BotDef = {
  kind: "saw",
  name: "RIPSAW",
  weapon: "vertical spinning saw blade",
  tagline: "Fast, fragile, and all teeth.",
  color: 0xe6a92b,
  accent: 0x1a1a1a,
  stats: { hp: 300, mass: 1.0, maxSpeed: 7.2, accel: 15, turnRate: 4.8, armor: 0.0, radius: 0.85 },
  maneuvers: {
    engage:
      "Charge straight at the target with the spinning blade leading. Good when the blade is at full speed and the target is not pointing a ready weapon at me.",
    flank:
      "Swing wide and attack the target from its side or rear, where its weapon cannot reach me. Good against a target that is facing me with a ready weapon.",
    circle:
      "Keep a medium distance and orbit the target, waiting for it to turn away or fire and miss.",
    retreat:
      "Back away from the nearest threat. Only worth it when a ready weapon is pointed at me from close range, or I am critical and need space.",
    spin_up:
      "Keep clear of every opponent until the blade reaches full speed. Only useful while the blade is still spinning up.",
  },
  available(sense) {
    const list: Maneuver[] = ["engage", "flank", "circle", "retreat"];
    if (sense.facts.weaponCharge < 0.95) list.push("spin_up");
    return list;
  },
  baseline(sense) {
    const f = sense.facts;
    const ops = f.opponents;
    if (ops.length === 0) return baselineIntent(null, "hold", 0, "nobody left");
    const threat = anyThreat(ops);
    const near = nearest(ops)!;
    const weak = weakest(ops)!;
    // Prefer finishing a weak bot that is not too far away, otherwise the nearest one.
    const target = weak.hpFrac < 0.35 && weak.dist < near.dist + 4 ? weak : near;

    if (f.weaponCharge < 0.6 && near.dist < 4) {
      return baselineIntent(target.name, "spin_up", threat ? 0.8 : 0.3, "blade not up to speed, keep clear");
    }
    if (threat && threat.dist < 3 && f.hpFrac < 0.5) {
      return baselineIntent(target.name, "retreat", 0.9, `${threat.name} is lining me up, back off`);
    }
    if (target.facingMe > 0.6 && target.weaponReady && !target.stunned && !target.airborne) {
      return baselineIntent(target.name, "flank", threat ? 0.6 : 0.2, `${target.name} is facing me, go around`);
    }
    return baselineIntent(target.name, "engage", threat ? 0.5 : 0.1, `blade is hot, charge ${target.name}`);
  },
};

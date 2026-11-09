import type { BotBuild } from "../build";
import { STOCK_PROMPTS } from "./prompts";

/**
 * RIPSAW: light, quick, glass cannon. A vertical spinning saw blade at the front does continuous
 * damage on contact and throws both bots around, but the blade needs time to spin up and the
 * chassis is thin. Wants to attack from the side or rear and never trade head-on with a ready hammer.
 */
export const SAW_BUILD: BotBuild = {
  id: "stock-saw",
  name: "RIPSAW",
  tagline: "Fast, fragile, and all teeth.",
  kind: "saw",
  color: 0xe6a92b,
  accent: 0x1a1a1a,
  levels: { armor: 0, motor: 5, frame: 3, steering: 4, power: 3, cycle: 3, wedge: 1, traction: 2, gyro: 2, sensors: 2 },
  techniques: ["engage", "flank", "circle", "retreat", "spin_up"],
  logic: {
    targeting: { prefer: "nearest", finishBelow: 0.35, finishWithin: 4 },
    rules: [
      {
        id: "spin",
        when: [
          { s: "me.charge", op: "<", v: 0.6 },
          { s: "nearest.dist", op: "<", v: 4 },
        ],
        maneuver: "spin_up",
        target: "policy",
        danger: 0.3,
        dangerIfThreat: 0.8,
        note: "blade not up to speed, keep clear",
      },
      {
        id: "bail",
        when: [
          { s: "threat.dist", op: "<", v: 3 },
          { s: "me.hp", op: "<", v: 0.5 },
        ],
        maneuver: "retreat",
        target: "policy",
        danger: 0.9,
        dangerIfThreat: 0.9,
        note: "{threat} is lining me up, back off",
      },
      {
        id: "flank",
        when: [
          { s: "target.facing", op: ">", v: 0.6 },
          { s: "target.ready", op: "is", v: true },
          { s: "target.helpless", op: "is", v: false },
        ],
        maneuver: "flank",
        target: "policy",
        danger: 0.2,
        dangerIfThreat: 0.6,
        note: "{target} is facing me, go around",
      },
      { id: "charge", when: [], maneuver: "engage", target: "policy", danger: 0.1, dangerIfThreat: 0.5, note: "blade is hot, charge {target}" },
    ],
    jev: {
      ...STOCK_PROMPTS,
      techniques: {
        engage: {
          description:
            "Charge straight at the target with the spinning blade leading. Good when the blade is at full speed and the target is not pointing a ready weapon at me.",
          when: [],
        },
        flank: {
          description:
            "Swing wide and attack the target from its side or rear, where its weapon cannot reach me. Good against a target that is facing me with a ready weapon.",
          when: [],
        },
        circle: { description: "Keep a medium distance and orbit the target, waiting for it to turn away or fire and miss.", when: [] },
        retreat: {
          description:
            "Back away from the nearest threat. Only worth it when a ready weapon is pointed at me from close range, or I am critical and need space.",
          when: [],
        },
        spin_up: {
          description: "Keep clear of every opponent until the blade reaches full speed. Only useful while the blade is still spinning up.",
          when: [{ s: "me.charge", op: "<", v: 0.95 }],
        },
      },
      speculative: [],
    },
  },
};

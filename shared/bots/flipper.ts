import type { BotBuild } from "../build";
import { STOCK_PROMPTS } from "./prompts";

/**
 * LAUNCHER: low wedge with a pneumatic flipper plate. Gets under an opponent and throws it into
 * the air; the landing hurts, and a wall or the pit hurts more. Quick, moderate armor, long
 * recharge between flips. Wants side and rear approaches where its wedge slides underneath.
 */
export const FLIPPER_BUILD: BotBuild = {
  id: "stock-flipper",
  name: "LAUNCHER",
  tagline: "Everything is airborne eventually.",
  kind: "flipper",
  color: 0xff7a1a,
  accent: 0x2a1c12,
  levels: { armor: 1, motor: 5, frame: 3, steering: 4, power: 3, cycle: 3, wedge: 2, traction: 2, gyro: 1, sensors: 2 },
  techniques: ["flip_now", "engage", "flank", "circle", "retreat"],
  logic: {
    targeting: { prefer: "nearest", finishBelow: 0.4, finishWithin: 3 },
    rules: [
      {
        id: "flip",
        when: [
          { s: "me.ready", op: "is", v: true },
          { s: "anyone.inReach", op: "is", v: true },
        ],
        maneuver: "flip_now",
        target: "in_reach",
        danger: 0.3,
        dangerIfThreat: 0.3,
        note: "{target} is on the plate",
      },
      {
        id: "bail",
        when: [
          { s: "me.ready", op: "is", v: false },
          { s: "threat.dist", op: "<", v: 2.5 },
        ],
        maneuver: "retreat",
        target: "policy",
        danger: 0.8,
        dangerIfThreat: 0.8,
        note: "flipper recharging, back off",
      },
      {
        id: "recharge",
        when: [{ s: "me.ready", op: "is", v: false }],
        maneuver: "circle",
        target: "policy",
        danger: 0.3,
        dangerIfThreat: 0.3,
        note: "flipper recharging, circle",
      },
      {
        id: "pounce",
        when: [{ s: "target.helpless", op: "is", v: true }],
        maneuver: "engage",
        target: "policy",
        danger: 0.1,
        dangerIfThreat: 0.1,
        note: "{target} is helpless, close in",
      },
      {
        id: "flank",
        when: [
          { s: "target.facing", op: ">", v: 0.5 },
          { s: "target.ready", op: "is", v: true },
          { s: "target.kind", op: "not", v: "flipper" },
        ],
        maneuver: "flank",
        target: "policy",
        danger: 0.2,
        dangerIfThreat: 0.5,
        note: "{target} faces me, go around",
      },
      { id: "engage", when: [], maneuver: "engage", target: "policy", danger: 0.1, dangerIfThreat: 0.1, note: "wedge under {target}" },
    ],
    jev: {
      ...STOCK_PROMPTS,
      techniques: {
        engage: { description: "Drive wedge-first under the target's front so the flipper can get beneath it.", when: [] },
        flip_now: {
          description:
            "Fire the flipper this instant. Only sensible when an opponent is touching or close and roughly dead ahead, and the flipper is charged.",
          when: [
            { s: "me.ready", op: "is", v: true },
            { s: "anyone.inReach", op: "is", v: true },
          ],
        },
        flank: { description: "Get around to the target's side or rear, where the wedge slides under without taking a hit.", when: [] },
        circle: { description: "Keep medium distance and circle while the flipper recharges or the target is dangerous.", when: [] },
        retreat: {
          description: "Back away from the nearest threat. Only worth it when a ready weapon is pointed at me from close range and my flipper is recharging.",
          when: [],
        },
      },
      speculative: [
        {
          key: "flip_toward_hazard",
          prompt:
            "If `me` flips the nearest opponent right now, would it be thrown toward the open pit or toward the kill saws? Yes only when a hazard is close and in roughly the same direction as that opponent.",
          when: [{ s: "me.ready", op: "is", v: true }],
        },
      ],
    },
  },
};

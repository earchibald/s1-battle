import type { BotBuild } from "../build";
import { STOCK_PROMPTS } from "./prompts";

/**
 * SCORCH: a flamethrower. A cone of fire a couple of meters long that half-ignores armor and keeps
 * burning after SCORCH moves on. Fuel is the whole game: a few seconds of flame, then a refill while
 * it keeps its distance. Burns from behind are critical.
 */
export const TORCH_BUILD: BotBuild = {
  id: "stock-torch",
  name: "SCORCH",
  tagline: "Armor is just a slower way to cook.",
  kind: "torch",
  color: 0xff5fa2,
  accent: 0x2a1018,
  levels: { armor: 2, motor: 3, frame: 3, steering: 4, power: 3, cycle: 3, wedge: 1, traction: 1, gyro: 0, sensors: 2 },
  techniques: ["engage", "burn", "flank", "circle", "retreat", "hold"],
  logic: {
    targeting: { prefer: "nearest", finishBelow: 0.4, finishWithin: 4 },
    rules: [
      {
        id: "cook",
        when: [
          { s: "me.charge", op: ">", v: 0.15 },
          { s: "target.helpless", op: "is", v: true },
          { s: "target.dist", op: "<", v: 4 },
        ],
        maneuver: "burn",
        target: "policy",
        danger: 0.1,
        dangerIfThreat: 0.4,
        note: "{target} cannot move, cook it",
      },
      {
        id: "burn",
        when: [
          { s: "me.charge", op: ">", v: 0.2 },
          { s: "target.dist", op: "<", v: 3.5 },
        ],
        maneuver: "burn",
        target: "policy",
        danger: 0.2,
        dangerIfThreat: 0.5,
        note: "flame on {target}",
      },
      {
        id: "refuel-bail",
        when: [
          { s: "me.charge", op: "<", v: 0.2 },
          { s: "threat.dist", op: "<", v: 3 },
        ],
        maneuver: "retreat",
        target: "policy",
        danger: 0.8,
        dangerIfThreat: 0.8,
        note: "out of fuel, back off from {threat}",
      },
      {
        id: "refuel",
        when: [{ s: "me.charge", op: "<", v: 0.35 }],
        maneuver: "circle",
        target: "policy",
        danger: 0.3,
        dangerIfThreat: 0.6,
        note: "refuelling, keep distance",
      },
      {
        id: "flank",
        when: [
          { s: "target.facing", op: ">", v: 0.6 },
          { s: "target.ready", op: "is", v: true },
        ],
        maneuver: "flank",
        target: "policy",
        danger: 0.2,
        dangerIfThreat: 0.6,
        note: "{target} faces me, get behind it",
      },
      { id: "close", when: [], maneuver: "engage", target: "policy", danger: 0.1, dangerIfThreat: 0.4, note: "close on {target}" },
    ],
    jev: {
      ...STOCK_PROMPTS,
      techniques: {
        engage: { description: "Drive at the target to get it inside the flame's reach, a couple of meters dead ahead.", when: [] },
        burn: {
          description:
            "Close in and hold the flame on the target for as long as the fuel lasts. Best when the target is close and ahead, cannot move, or has its back to me. Wasteful when the fuel is nearly out.",
          when: [{ s: "me.charge", op: ">", v: 0.1 }],
        },
        flank: { description: "Get around to the target's side or rear: flames on its back find the fuel cells and do critical damage.", when: [] },
        circle: { description: "Keep medium distance and circle while the fuel refills.", when: [] },
        retreat: { description: "Back away from the nearest threat. Only worth it when the fuel is out and a ready weapon is pointed at me from close range.", when: [] },
        hold: { description: "Stop and keep the nozzle pointed at the target.", when: [] },
      },
      speculative: [
        {
          key: "target_in_flame",
          prompt: "If `me` fires the flamethrower right now, will the flame reach an opponent? Yes when an opponent is touching or close and roughly dead ahead.",
          when: [{ s: "me.charge", op: ">", v: 0.1 }],
        },
      ],
    },
  },
};

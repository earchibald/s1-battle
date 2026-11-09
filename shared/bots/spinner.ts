import type { BotBuild } from "../build";
import { STOCK_PROMPTS } from "./prompts";

/**
 * CYCLONE: a horizontal bar spinner. Slow to get the bar up, then anything that touches the front half of
 * the bot gets launched sideways. Every hit stops the bar dead and kicks CYCLONE back, so it is a bot of
 * big moments and long pauses. The gyro keeps the bar from eating its own turn rate.
 */
export const SPINNER_BUILD: BotBuild = {
  id: "stock-spinner",
  name: "CYCLONE",
  tagline: "Come closer. I insist.",
  kind: "spinner",
  color: 0xb57bff,
  accent: 0x1c1430,
  levels: { armor: 1, motor: 4, frame: 3, steering: 3, power: 4, cycle: 2, wedge: 0, traction: 1, gyro: 3, sensors: 1 },
  techniques: ["engage", "spin_up", "hold", "circle", "flank", "retreat"],
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
        danger: 0.4,
        dangerIfThreat: 0.8,
        note: "bar is down, get clear",
      },
      {
        id: "bail",
        when: [
          { s: "threat.dist", op: "<", v: 2.5 },
          { s: "me.hp", op: "<", v: 0.4 },
          { s: "me.charge", op: "<", v: 0.6 },
        ],
        maneuver: "retreat",
        target: "policy",
        danger: 0.9,
        dangerIfThreat: 0.9,
        note: "{threat} is on me with the bar down",
      },
      {
        id: "ambush",
        when: [
          { s: "target.dist", op: "<", v: 3 },
          { s: "target.facing", op: ">", v: 0.5 },
        ],
        maneuver: "hold",
        target: "policy",
        danger: 0.2,
        dangerIfThreat: 0.4,
        note: "let {target} run into the bar",
      },
      {
        id: "flank",
        when: [
          { s: "target.kind", op: "is", v: "hammer" },
          { s: "target.ready", op: "is", v: true },
        ],
        maneuver: "flank",
        target: "policy",
        danger: 0.3,
        dangerIfThreat: 0.6,
        note: "around the hammer",
      },
      { id: "charge", when: [], maneuver: "engage", target: "policy", danger: 0.1, dangerIfThreat: 0.5, note: "bar is up, into {target}" },
    ],
    jev: {
      ...STOCK_PROMPTS,
      techniques: {
        engage: { description: "Drive at the target with the spinning bar leading. Good when the bar is at speed.", when: [] },
        spin_up: {
          description: "Keep clear of every opponent until the bar reaches full speed. Only useful while the bar is still spinning up.",
          when: [{ s: "me.charge", op: "<", v: 0.95 }],
        },
        hold: {
          description: "Stop, keep the spinning bar pointed at the target and let it come to me. Best when the target is close, facing me and about to charge: a bot that runs into the bar gets launched.",
          when: [],
        },
        circle: { description: "Keep a medium distance and orbit the target while the bar comes back up to speed.", when: [] },
        flank: { description: "Swing around to the target's side or rear and bring the bar in where its weapon cannot reach me.", when: [] },
        retreat: {
          description: "Back away from the nearest threat. Only worth it when the bar is down and a ready weapon is pointed at me from close range.",
          when: [],
        },
      },
      speculative: [
        {
          key: "target_will_charge",
          prompt: "Is the nearest opponent about to drive straight into `me`? Yes when it is close, pointed straight at me, and driving normally.",
          when: [{ s: "me.ready", op: "is", v: true }],
        },
      ],
    },
  },
};

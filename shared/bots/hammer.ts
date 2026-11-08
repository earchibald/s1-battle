import type { BotBuild } from "../build";
import { STOCK_PROMPTS } from "./prompts";

/**
 * PILEDRIVER: the heavyweight. Slow and armored with an overhead pneumatic hammer. Each strike has a
 * short windup, a long cooldown, and hits like a truck. Wants opponents to come to it, and wants
 * to commit the hammer only when a hit is certain.
 */
export const HAMMER_BUILD: BotBuild = {
  id: "stock-hammer",
  name: "PILEDRIVER",
  tagline: "Slow. Armored. Terminal.",
  kind: "hammer",
  color: 0xd13b3b,
  accent: 0x2b2b30,
  levels: { armor: 4, motor: 3, frame: 3, steering: 3, power: 4, cycle: 3 },
  techniques: ["strike_now", "engage", "hold", "circle", "retreat"],
  logic: {
    targeting: { prefer: "nearest", finishBelow: 0.3, finishWithin: 6 },
    rules: [
      {
        id: "strike",
        when: [
          { s: "me.ready", op: "is", v: true },
          { s: "anyone.inReach", op: "is", v: true },
        ],
        maneuver: "strike_now",
        target: "in_reach",
        danger: 0.2,
        dangerIfThreat: 0.6,
        note: "{target} is under the hammer",
      },
      {
        id: "bail",
        when: [
          { s: "me.ready", op: "is", v: false },
          { s: "threat.dist", op: "<", v: 2.5 },
          { s: "threat.kind", op: "not", v: "saw" },
          { s: "threat.kind", op: "not", v: "hammer" },
        ],
        maneuver: "retreat",
        target: "policy",
        danger: 0.8,
        dangerIfThreat: 0.8,
        note: "hammer cooling, {threat} too close",
      },
      {
        id: "cooling",
        when: [{ s: "me.ready", op: "is", v: false }],
        maneuver: "hold",
        target: "policy",
        danger: 0.1,
        dangerIfThreat: 0.5,
        note: "hammer recharging, hold the line",
      },
      {
        id: "ambush",
        when: [{ s: "target.dist", op: "<", v: 3.5 }],
        maneuver: "hold",
        target: "policy",
        danger: 0.1,
        dangerIfThreat: 0.4,
        note: "let {target} come to me",
      },
      { id: "advance", when: [], maneuver: "engage", target: "policy", danger: 0.1, dangerIfThreat: 0.1, note: "close in on {target}" },
    ],
    jev: {
      ...STOCK_PROMPTS,
      techniques: {
        engage: { description: "Drive at the target to get it within hammer reach, keeping my front toward it.", when: [] },
        strike_now: {
          description:
            "Bring the hammer down this instant. Only sensible when an opponent is touching or close and roughly dead ahead, and the hammer is ready.",
          when: [
            { s: "me.ready", op: "is", v: true },
            { s: "anyone.inReach", op: "is", v: true },
          ],
        },
        hold: {
          description: "Stop, keep turning to face the target, and wait with the hammer raised so anything that rushes me gets hit first.",
          when: [],
        },
        circle: { description: "Keep medium distance and circle while the hammer recharges.", when: [] },
        retreat: {
          description:
            "Back away to avoid a hit. Only worth it when a flipper or grabber is close, facing me, with its weapon ready, and my hammer is not ready.",
          when: [],
        },
      },
      speculative: [
        {
          key: "strike_will_land",
          prompt:
            "If `me` fires the hammer right now, will it come down on an opponent? Yes when an opponent is touching or close and dead ahead or slightly to one side.",
          when: [{ s: "me.ready", op: "is", v: true }],
        },
      ],
    },
  },
};

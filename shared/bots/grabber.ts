import type { BotBuild } from "../build";
import { STOCK_PROMPTS } from "./prompts";

/**
 * CLAMP: the control bot. A hydraulic grabbing arm seizes an opponent, squeezes, and drags it
 * wherever CLAMP likes: into the pit, onto the kill saws, or just away from its friends.
 * Mid-weight, decent armor, no burst damage of its own.
 */
const NOT_HOLDING = { s: "me.holding", op: "is", v: false } as const;
const HOLDING = { s: "me.holding", op: "is", v: true } as const;

export const GRABBER_BUILD: BotBuild = {
  id: "stock-grabber",
  name: "CLAMP",
  tagline: "Where you go is up to me now.",
  kind: "grabber",
  color: 0x2dd4bf,
  accent: 0x14323a,
  levels: { armor: 2, motor: 4, frame: 3, steering: 3, power: 3, cycle: 3, wedge: 2, traction: 2, gyro: 0, sensors: 2 },
  techniques: ["grab_now", "engage", "flank", "circle", "retreat", "drag_to_pit", "drag_to_saws", "crush", "release"],
  logic: {
    targeting: { prefer: "nearest", finishBelow: 0.4, finishWithin: 3 },
    rules: [
      {
        id: "let-go",
        when: [HOLDING, { s: "others.threatDist", op: "<", v: 3 }],
        maneuver: "release",
        target: "held",
        danger: 0.9,
        dangerIfThreat: 0.9,
        note: "someone is on me, let go",
      },
      {
        id: "pit",
        when: [HOLDING, { s: "arena.pitOpen", op: "is", v: true }],
        maneuver: "drag_to_pit",
        target: "held",
        danger: 0.3,
        dangerIfThreat: 0.3,
        note: "pit is open, drag {held} in",
      },
      {
        id: "saws",
        when: [HOLDING, { s: "arena.sawsActive", op: "is", v: true }],
        maneuver: "drag_to_saws",
        target: "held",
        danger: 0.3,
        dangerIfThreat: 0.3,
        note: "feed {held} to the saws",
      },
      { id: "squeeze", when: [HOLDING], maneuver: "crush", target: "held", danger: 0.2, dangerIfThreat: 0.2, note: "squeeze {held}" },
      {
        id: "grab",
        when: [
          { s: "me.ready", op: "is", v: true },
          { s: "anyone.inReach", op: "is", v: true },
        ],
        maneuver: "grab_now",
        target: "in_reach",
        danger: 0.3,
        dangerIfThreat: 0.3,
        note: "{target} is in the jaws",
      },
      {
        id: "recharge",
        when: [{ s: "me.ready", op: "is", v: false }],
        maneuver: "circle",
        target: "policy",
        danger: 0.2,
        dangerIfThreat: 0.6,
        note: "arm recharging, keep distance",
      },
      {
        id: "bail",
        when: [
          { s: "threat.dist", op: "<", v: 2.5 },
          { s: "me.hp", op: "<", v: 0.4 },
        ],
        maneuver: "retreat",
        target: "policy",
        danger: 0.8,
        dangerIfThreat: 0.8,
        note: "{threat} is lining me up",
      },
      {
        id: "flank",
        when: [
          { s: "target.facing", op: ">", v: 0.5 },
          { s: "target.ready", op: "is", v: true },
          { s: "target.kind", op: "not", v: "grabber" },
        ],
        maneuver: "flank",
        target: "policy",
        danger: 0.3,
        dangerIfThreat: 0.3,
        note: "{target} faces me, go around",
      },
      { id: "engage", when: [], maneuver: "engage", target: "policy", danger: 0.1, dangerIfThreat: 0.1, note: "jaws open for {target}" },
    ],
    jev: {
      ...STOCK_PROMPTS,
      techniques: {
        engage: { description: "Drive at the target with the jaws open to get it between them.", when: [NOT_HOLDING] },
        grab_now: {
          description: "Close the jaws this instant. Only sensible when an opponent is touching or close and roughly dead ahead, and the arm is ready.",
          when: [NOT_HOLDING, { s: "me.ready", op: "is", v: true }, { s: "anyone.inReach", op: "is", v: true }],
        },
        flank: { description: "Approach the target from its side or rear so I can grab it where it cannot hit back.", when: [NOT_HOLDING] },
        circle: { description: "Keep medium distance and circle the target, waiting for it to turn away.", when: [NOT_HOLDING] },
        retreat: {
          description: "Back away from the nearest threat. Only worth it when a ready weapon is pointed at me from close range and my jaws are recharging.",
          when: [NOT_HOLDING],
        },
        drag_to_pit: {
          description: "While holding an opponent, drag it toward the open pit and drop it in. Only possible when the pit is open.",
          when: [HOLDING, { s: "arena.pitOpen", op: "is", v: true }],
        },
        drag_to_saws: {
          description:
            "While holding an opponent, drag it onto the arena's kill saws so the floor blades chew it up. Best when the saws are up or about to rise.",
          when: [HOLDING],
        },
        crush: { description: "While holding an opponent, stay put and squeeze it in the jaws for steady damage.", when: [HOLDING] },
        release: { description: "Let go of the held opponent, for example to escape a third bot that is about to hit me.", when: [HOLDING] },
      },
      speculative: [
        {
          key: "third_party_threat",
          prompt: "Is a *different* opponent (not the one `me` is holding) close and about to hit `me` while my jaws are busy?",
          when: [HOLDING],
        },
      ],
    },
  },
};

import type { BotBuild } from "../build";
import { STOCK_PROMPTS } from "./prompts";

/**
 * DOZER: a pusher. No weapon beyond a thick ram plate, a heavy chassis and a boost reserve that turns
 * into short, violent charges. It does damage by slamming, and wins by shoving bots into the pit, onto
 * the kill saws, or against the wall, where a slam is critical.
 */
export const RAM_BUILD: BotBuild = {
  id: "stock-ram",
  name: "DOZER",
  tagline: "You are standing in my way.",
  kind: "ram",
  color: 0x7cff6e,
  accent: 0x14261a,
  levels: { armor: 3, motor: 4, frame: 4, steering: 2, power: 3, cycle: 2, wedge: 3, traction: 2, gyro: 0, sensors: 0 },
  techniques: ["engage", "ram_now", "shove_to_pit", "shove_to_saws", "flank", "retreat", "hold"],
  logic: {
    targeting: { prefer: "nearest", finishBelow: 0.35, finishWithin: 5 },
    rules: [
      {
        id: "pit",
        when: [
          { s: "arena.pitOpen", op: "is", v: true },
          { s: "target.dist", op: "<", v: 5 },
          { s: "arena.pitDist", op: "<", v: 7 },
        ],
        maneuver: "shove_to_pit",
        target: "policy",
        danger: 0.2,
        dangerIfThreat: 0.4,
        note: "pit is open, bulldoze {target} in",
      },
      {
        id: "saws",
        when: [
          { s: "arena.sawsActive", op: "is", v: true },
          { s: "target.dist", op: "<", v: 4 },
          { s: "arena.sawsDist", op: "<", v: 6 },
        ],
        maneuver: "shove_to_saws",
        target: "policy",
        danger: 0.2,
        dangerIfThreat: 0.4,
        note: "push {target} onto the saws",
      },
      {
        id: "trap",
        when: [
          { s: "arena.trapLive", op: "is", v: true },
          { s: "target.dist", op: "<", v: 4 },
          { s: "target.trapDist", op: "<", v: 3 },
        ],
        maneuver: "shove_to_saws",
        target: "policy",
        danger: 0.2,
        dangerIfThreat: 0.4,
        note: "{target} is beside a live trap, shove it on",
      },
      {
        id: "ram",
        when: [
          { s: "me.ready", op: "is", v: true },
          { s: "target.dist", op: "<", v: 4.5 },
          { s: "target.facing", op: "<", v: 0.5 },
        ],
        maneuver: "ram_now",
        target: "policy",
        danger: 0.1,
        dangerIfThreat: 0.3,
        note: "boost into {target}",
      },
      {
        id: "pounce",
        when: [
          { s: "me.ready", op: "is", v: true },
          { s: "target.helpless", op: "is", v: true },
        ],
        maneuver: "ram_now",
        target: "policy",
        danger: 0.1,
        dangerIfThreat: 0.1,
        note: "{target} is helpless, hit it",
      },
      {
        id: "bail",
        when: [
          { s: "threat.dist", op: "<", v: 2.5 },
          { s: "me.hp", op: "<", v: 0.3 },
        ],
        maneuver: "retreat",
        target: "policy",
        danger: 0.8,
        dangerIfThreat: 0.8,
        note: "too beaten up to trade with {threat}",
      },
      {
        id: "flank",
        when: [
          { s: "target.facing", op: ">", v: 0.6 },
          { s: "target.ready", op: "is", v: true },
          { s: "target.kind", op: "not", v: "ram" },
        ],
        maneuver: "flank",
        target: "policy",
        danger: 0.2,
        dangerIfThreat: 0.5,
        note: "{target} faces me, come in from the side",
      },
      { id: "push", when: [], maneuver: "engage", target: "policy", danger: 0.1, dangerIfThreat: 0.3, note: "plate first into {target}" },
    ],
    jev: {
      ...STOCK_PROMPTS,
      techniques: {
        engage: { description: "Drive plate-first at the target and lean on it. Slow pressure, no boost.", when: [] },
        ram_now: {
          description:
            "Dump the boost reserve into a charge at the target. Best when the target is a few meters away, turned away or unable to move, or has its back to a wall. Only possible with boost in reserve.",
          when: [{ s: "me.ready", op: "is", v: true }],
        },
        shove_to_pit: {
          description: "Get on the far side of the target from the pit and bulldoze it in. Only sensible while the pit is open and the target is close to it.",
          when: [{ s: "arena.pitOpen", op: "is", v: true }],
        },
        shove_to_saws: {
          description:
            "Get on the far side of the target from the kill saws and push it onto them; if a flame vent, shock plate or the launch pad is live and closer to the target, push it onto that instead. Best when the saws are up or about to rise, or the target is right beside a trap that is about to fire.",
          when: [],
        },
        flank: { description: "Come in from the target's side or rear so its weapon cannot meet my charge head-on.", when: [] },
        retreat: { description: "Back away from the nearest threat. Rarely worth it: the plate is armor. Only when I am nearly destroyed.", when: [] },
        hold: { description: "Stop, face the target and let the boost refill.", when: [] },
      },
      speculative: [
        {
          key: "target_against_wall",
          prompt: "Is the nearest opponent close to an arena wall, with `me` between it and open floor, so that a shove would pin it against the wall?",
          when: [{ s: "me.ready", op: "is", v: true }],
        },
      ],
    },
  },
};

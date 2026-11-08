import type { Vec } from "./math";

/** Everything that happened during a step that the renderer, audio, or commentary might care about. */
export type HitWeapon = "saw" | "hammer" | "crush" | "flip" | "landing" | "wall" | "saws";

export type SimEvent =
  | { type: "hit"; attacker: string; victim: string; amount: number; weapon: HitWeapon; at: Vec; power: number }
  | { type: "strike"; bot: string; landed: boolean; at: Vec }
  | { type: "grab"; bot: string; victim: string }
  | { type: "release"; bot: string; victim: string; reason: "timeout" | "chosen" | "stunned" | "destroyed" }
  | { type: "flip"; bot: string; victim: string | null; at: Vec }
  | { type: "wall"; bot: string; speed: number; at: Vec }
  | { type: "destroyed"; bot: string; by: string | null; at: Vec }
  | { type: "pitted"; bot: string; by: string | null; at: Vec }
  | { type: "pit_open" }
  | { type: "pit_warning" }
  | { type: "saws_rising" }
  | { type: "saws_up" }
  | { type: "match_start" }
  | { type: "match_end"; winner: string | null; reason: "last_standing" | "judges" | "draw" }
  | { type: "decision"; bot: string; note: string; source: "jev" | "baseline" | "fallback" };

/**
 * Types shared by the browser simulation and the Node server that talks to Jev.
 * Everything here is plain data: no DOM, no Node APIs.
 */

export type BotKind = "saw" | "hammer" | "grabber" | "flipper" | "spinner" | "torch" | "ram";

export const BOT_KINDS: BotKind[] = ["saw", "hammer", "grabber", "flipper", "spinner", "torch", "ram"];

/** Semantic buckets. Jev reads words far better than raw numbers, so the sim converts everything to these. */
export type HealthBucket = "healthy" | "scratched" | "damaged" | "critical";
export type DistanceBucket = "touching" | "close" | "medium" | "far";
export type Bearing =
  | "dead ahead"
  | "ahead-left"
  | "ahead-right"
  | "left"
  | "right"
  | "behind-left"
  | "behind-right"
  | "directly behind";
export type FacingMe = "yes, pointed straight at me" | "partly" | "no, turned away";
export type ArenaZone =
  | "center of the arena"
  | "near the north wall"
  | "near the south wall"
  | "near the east wall"
  | "near the west wall"
  | "in a corner";
export type TimeLeft = "plenty of time" | "about half the match left" | "final 30 seconds";
export type PitState = "closed" | "open";
export type SawState = "retracted" | "about to rise" | "up and spinning";

export interface OpponentView {
  name: string;
  weapon: string;
  health: HealthBucket;
  distance: DistanceBucket;
  bearing: Bearing;
  facing_me: FacingMe;
  /** Human-readable status: "driving normally", "airborne", "stunned", "held in CLAMP's jaws", etc. */
  status: string;
  /** Human-readable weapon state from the viewer's point of view. */
  weapon_state: string;
}

export interface Perception {
  me: {
    name: string;
    weapon: string;
    health: HealthBucket;
    /** Kind-specific weapon readiness, in words. */
    weapon_state: string;
    position: ArenaZone;
    status: string;
    /** Direction + distance to the nearest arena hazard, in words. */
    nearest_hazard: string;
    /** Extra kind-specific facts (e.g. grabber: who is held). */
    [extra: string]: string;
  };
  opponents: OpponentView[];
  arena: {
    pit: string;
    kill_saws: string;
    time_left: TimeLeft;
  };
}

/** The common vocabulary of what a bot can be told to do. Kind-specific maneuvers live in each bot def. */
export type Maneuver =
  | "engage"
  | "flank"
  | "circle"
  | "retreat"
  | "hold"
  // saw, spinner
  | "spin_up"
  // hammer
  | "strike_now"
  // grabber
  | "grab_now"
  | "drag_to_pit"
  | "drag_to_saws"
  | "crush"
  | "release"
  // flipper
  | "flip_now"
  // torch
  | "burn"
  // ram
  | "ram_now"
  | "shove_to_pit"
  | "shove_to_saws";

export interface JevAnswerChoice {
  type: "choice";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}
export interface JevAnswerNoul {
  type: "noul";
  noul: number;
}
export type JevAnswer = JevAnswerChoice | JevAnswerNoul;

/** Body of POST /api/decide. `logic` is the bot's editable brain; the server falls back to stock logic without it. */
export interface DecideRequest {
  kind: BotKind;
  name?: string;
  sense: unknown;
  build?: unknown;
}

export interface DecideResponse {
  ok: true;
  model: string;
  latencyMs: number;
  answers: Record<string, JevAnswer>;
  usage?: { input_tokens: number; output_tokens: number };
}
export interface DecideError {
  ok: false;
  error: string;
  status?: number;
}

/** What a brain hands to the bot controller. */
export interface Intent {
  /** Opponent name to focus on, or null for "nobody in particular". */
  target: string | null;
  maneuver: Maneuver;
  /** Probability (0..1) the bot believes it is about to be hit. Controllers use it to drive more evasively. */
  danger: number;
  source: "jev" | "baseline" | "fallback";
  /** For the HUD: how sure the brain was about the maneuver, and the full distribution. */
  confidence: number;
  probabilities: Record<string, number>;
  targetProbabilities: Record<string, number>;
  latencyMs: number;
  /** One-line rationale for the ticker. */
  note: string;
  /** Baseline brains: id of the rule that fired, so the designer can light it up. */
  ruleId?: string;
}

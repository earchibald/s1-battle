import type { BotKind, Intent, Maneuver, Perception } from "../types";
import type { BotBuild, Footprint, WeaponTuning } from "../build";

/** Plain-JSON question shapes accepted by POST /v1/systemone (and by the SDK). */
export type ChoiceQuestion = { type: "choice"; instructions: string; criteria: Record<string, string | null> };
export type NoulQuestion = { type: "noul"; instructions: string };
export type Question = ChoiceQuestion | NoulQuestion;

/**
 * Machine-readable facts that accompany the semantic Perception. The baseline (scripted) brains read these;
 * the Jev brain only ever sees the Perception. Both encodings describe the same moment.
 */
export interface OpponentFacts {
  name: string;
  kind: BotKind;
  hpFrac: number;
  dist: number;
  /** Bearing from my heading to them, radians, -PI..PI (0 = dead ahead, +left). */
  relBearing: number;
  /** cos of angle between their heading and the vector to me: 1 = pointed at me. */
  facingMe: number;
  weaponReady: boolean;
  airborne: boolean;
  stunned: boolean;
  heldBy: string | null;
  burning: boolean;
  /** Inside my weapon's reach cone right now. */
  inReach: boolean;
  /** Their weapon is ready, pointed at me, and they are close. */
  threatening: boolean;
  /** Their distance to the edge of the nearest trap that is charging or firing (99 when none is). */
  trapDist: number;
}
export interface Facts {
  hpFrac: number;
  weaponReady: boolean;
  /** 0..1: saw spin fraction, or cooldown progress for one-shot weapons. */
  weaponCharge: number;
  holding: string | null;
  heldBy: string | null;
  airborne: boolean;
  stunned: boolean;
  burning: boolean;
  pitOpen: boolean;
  pitDist: number;
  sawsUp: boolean;
  sawsSoon: boolean;
  sawsDist: number;
  /** A flame vent, the launch pad or a shock plate is telegraphing or firing right now. */
  trapLive: boolean;
  /** My distance to the edge of the nearest such trap (99 when none is live). */
  trapDist: number;
  timeLeft: number;
  opponents: OpponentFacts[];
}
export interface BotSense {
  perception: Perception;
  facts: Facts;
}

export interface BotStats {
  hp: number;
  mass: number;
  maxSpeed: number;
  accel: number;
  turnRate: number;
  /** Fraction of incoming damage shrugged off. */
  armor: number;
  radius: number;
  /** Oriented-box collision footprint (metres from the axle centre). */
  footprint: Footprint;
  knockResist: number;
  stunResist: number;
  impactResist: number;
  /** Seconds between brain decisions. */
  cadence: number;
  awareness: number;
}

/** The sim's view of a bot. Always produced from a BotBuild by `defFromBuild`. */
export interface BotDef {
  kind: BotKind;
  name: string;
  weapon: string;
  tagline: string;
  color: number;
  accent: number;
  stats: BotStats;
  tuning: WeaponTuning;
  build: BotBuild;
  /** Installed techniques with the description Jev sees. */
  maneuvers: Partial<Record<Maneuver, string>>;
  /** Which maneuvers make sense given the current moment. Jev only ever chooses among these. */
  available(sense: BotSense): Maneuver[];
  /** Kind-specific speculative questions, asked alongside target/maneuver/in_danger. */
  extraQuestions?(sense: BotSense): Record<string, Question>;
  /** Scripted decision tree over the same information Jev gets. */
  baseline(sense: BotSense): Intent;
}

export function nearest(ops: OpponentFacts[]): OpponentFacts | undefined {
  return ops.reduce<OpponentFacts | undefined>((a, b) => (!a || b.dist < a.dist ? b : a), undefined);
}
export function weakest(ops: OpponentFacts[]): OpponentFacts | undefined {
  return ops.reduce<OpponentFacts | undefined>((a, b) => (!a || b.hpFrac < a.hpFrac ? b : a), undefined);
}
export function anyThreat(ops: OpponentFacts[]): OpponentFacts | undefined {
  return ops.find((o) => o.threatening);
}

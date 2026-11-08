import type { BotKind, Intent, JevAnswer, JevAnswerChoice, Maneuver, Perception } from "../types";

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
  /** Inside my weapon's reach cone right now. */
  inReach: boolean;
  /** Their weapon is ready, pointed at me, and they are close. */
  threatening: boolean;
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
  pitOpen: boolean;
  pitDist: number;
  sawsUp: boolean;
  sawsSoon: boolean;
  sawsDist: number;
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
}

export interface BotDef {
  kind: BotKind;
  name: string;
  weapon: string;
  tagline: string;
  color: number;
  accent: number;
  stats: BotStats;
  /** Full catalogue of maneuvers this bot knows, with the description Jev sees. */
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

export function baselineIntent(
  target: string | null,
  maneuver: Maneuver,
  danger: number,
  note: string,
): Intent {
  return {
    target,
    maneuver,
    danger,
    source: "baseline",
    confidence: 1,
    probabilities: { [maneuver]: 1 },
    targetProbabilities: target ? { [target]: 1 } : {},
    latencyMs: 0,
    note,
  };
}

/** Build the standard question set for a bot: who to target, what to do, and am I in danger. */
export function buildQuestions(def: BotDef, sense: BotSense): Record<string, Question> {
  const { perception } = sense;
  const questions: Record<string, Question> = {};

  if (perception.opponents.length > 1) {
    const criteria: Record<string, string> = {};
    for (const o of perception.opponents) {
      criteria[o.name] = `${o.weapon}; ${o.health}; ${o.distance}, ${o.bearing}; ${o.status}`;
    }
    questions.target = {
      type: "choice",
      instructions: `Which opponent should \`me\` (${def.name}, armed with a ${def.weapon}) focus on attacking next? Prefer opponents that are vulnerable right now and avoid ones about to hit me.`,
      criteria,
    };
  }

  const allowed = def.available(sense);
  const criteria: Record<string, string> = {};
  for (const m of allowed) criteria[m] = def.maneuvers[m] ?? m;
  questions.maneuver = {
    type: "choice",
    instructions: `\`me\` is ${def.name}, a combat robot armed with a ${def.weapon}. Given \`me\`, \`opponents\` and \`arena\`, which single maneuver should \`me\` perform for the next second? The goal is to destroy the opponents or put them in the pit; a bot that stays passive loses on the judges' decision. Taking a hit is acceptable when it lets my own weapon land. Retreat only when an opponent's ready weapon is pointed at me from close range or a live hazard is right next to me.`,
    criteria,
  };

  questions.in_danger = {
    type: "noul",
    instructions:
      "Is `me` about to be hit by an opponent's weapon or an arena hazard within the next second or two? Consider opponents that are close, facing me, with a ready weapon, and hazards that are open or rising next to me.",
  };

  Object.assign(questions, def.extraQuestions?.(sense) ?? {});
  return questions;
}

/** Turn Jev's answers into an Intent, validating every answer against what is actually possible. */
export function interpretAnswers(
  def: BotDef,
  sense: BotSense,
  answers: Record<string, JevAnswer>,
  latencyMs: number,
): Intent {
  const allowed = def.available(sense);
  const alive = sense.perception.opponents.map((o) => o.name);

  const man = answers.maneuver as JevAnswerChoice | undefined;
  let maneuver: Maneuver = allowed[0] ?? "engage";
  let confidence = 0;
  let probabilities: Record<string, number> = {};
  if (man && man.type === "choice") {
    probabilities = man.probabilities;
    confidence = man.confidence;
    if (allowed.includes(man.choice as Maneuver)) maneuver = man.choice as Maneuver;
    else {
      // Pick the most probable allowed option instead of silently defaulting.
      const best = allowed.slice().sort((a, b) => (probabilities[b] ?? 0) - (probabilities[a] ?? 0))[0];
      if (best) maneuver = best;
    }
  }

  let target: string | null = null;
  let targetProbabilities: Record<string, number> = {};
  const tgt = answers.target as JevAnswerChoice | undefined;
  if (tgt && tgt.type === "choice") {
    targetProbabilities = tgt.probabilities;
    target = alive.includes(tgt.choice) ? tgt.choice : null;
  }
  const holdingManeuvers: Maneuver[] = ["crush", "drag_to_pit", "drag_to_saws", "release"];
  if (sense.facts.holding && holdingManeuvers.includes(maneuver)) target = sense.facts.holding;
  if (!target && alive.length === 1) target = alive[0];
  if (!target && alive.length > 1) {
    const n = nearest(sense.facts.opponents);
    target = n ? n.name : alive[0];
  }

  const dangerAns = answers.in_danger;
  const danger = dangerAns && dangerAns.type === "noul" ? dangerAns.noul : 0;

  const pct = Math.round((probabilities[maneuver] ?? 0) * 100);
  const extra = Object.entries(answers)
    .filter(([k, a]) => a.type === "noul" && k !== "in_danger")
    .map(([k, a]) => `${k}=${(a as { noul: number }).noul.toFixed(2)}`)
    .join(" ");
  const note = `Jev: ${maneuver}${target ? " → " + target : ""} (${pct}%) danger=${danger.toFixed(2)}${extra ? " " + extra : ""}`;

  return { target, maneuver, danger, source: "jev", confidence, probabilities, targetProbabilities, latencyMs, note };
}

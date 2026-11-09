import type { BotKind, Intent, JevAnswer, JevAnswerChoice, Maneuver } from "./types";
import type { BotBuild, BotLogic, CondValue, Condition, Rule, SubjectKey, TargetSel, Targeting } from "./build";
import { SUBJECT_BY_KEY, TECHNIQUE_BY_M, WEAPONS, derive } from "./build";
import type { BotDef, BotSense, Facts, OpponentFacts, Question } from "./bots/common";
import { anyThreat, nearest, weakest } from "./bots/common";

/**
 * The interpreter for BotLogic. Baseline brains run the rule tree; Jev brains use the technique gates,
 * descriptions and prompts. Both read the same Facts, so the editor can show which conditions hold
 * right now for a live bot.
 */

export interface EvalContext {
  f: Facts;
  target: OpponentFacts | undefined;
  nearest: OpponentFacts | undefined;
  weakest: OpponentFacts | undefined;
  threat: OpponentFacts | undefined;
  inReach: OpponentFacts | undefined;
  held: OpponentFacts | undefined;
  /** Nearest threatening opponent that is not the bot I hold. */
  otherThreat: OpponentFacts | undefined;
}

export function pickPolicyTarget(t: Targeting, ops: OpponentFacts[]): OpponentFacts | undefined {
  const near = nearest(ops);
  const weak = weakest(ops);
  if (!near || !weak) return undefined;
  if (t.prefer === "weakest") return weak.dist <= near.dist + t.finishWithin ? weak : near;
  return weak.hpFrac < t.finishBelow && weak.dist < near.dist + t.finishWithin ? weak : near;
}

export function makeContext(logic: BotLogic, f: Facts): EvalContext {
  const ops = f.opponents;
  const held = f.holding ? ops.find((o) => o.name === f.holding) : undefined;
  const threats = ops.filter((o) => o.threatening).sort((a, b) => a.dist - b.dist);
  return {
    f,
    target: pickPolicyTarget(logic.targeting, ops),
    nearest: nearest(ops),
    weakest: weakest(ops),
    threat: threats[0] ?? anyThreat(ops),
    inReach: ops.filter((o) => o.inReach).sort((a, b) => a.dist - b.dist)[0],
    held,
    otherThreat: threats.find((o) => o.name !== f.holding),
  };
}

/** Numeric subjects answer Infinity / "none" when there is nobody to measure, so `<` fails and `>` holds. */
export function subjectValue(key: SubjectKey, c: EvalContext): CondValue | "none" {
  const f = c.f;
  const t = c.target;
  switch (key) {
    case "me.hp":
      return f.hpFrac;
    case "me.charge":
      return f.weaponCharge;
    case "me.ready":
      return f.weaponReady;
    case "me.holding":
      return f.holding !== null;
    case "me.burning":
      return f.burning;
    case "target.burning":
      return !!t?.burning;
    case "target.dist":
      return t ? t.dist : Infinity;
    case "target.hp":
      return t ? t.hpFrac : 1;
    case "target.facing":
      return t ? t.facingMe : -1;
    case "target.ready":
      return !!t?.weaponReady;
    case "target.stunned":
      return !!t?.stunned;
    case "target.airborne":
      return !!t?.airborne;
    case "target.helpless":
      return !!t && (t.stunned || t.airborne || t.heldBy !== null);
    case "target.inReach":
      return !!t?.inReach;
    case "target.kind":
      return t ? t.kind : "none";
    case "anyone.inReach":
      return c.inReach !== undefined;
    case "nearest.dist":
      return c.nearest ? c.nearest.dist : Infinity;
    case "threat.exists":
      return c.threat !== undefined;
    case "threat.dist":
      return c.threat ? c.threat.dist : Infinity;
    case "threat.kind":
      return c.threat ? c.threat.kind : "none";
    case "others.threatDist":
      return c.otherThreat ? c.otherThreat.dist : Infinity;
    case "opponents.count":
      return f.opponents.length;
    case "arena.pitOpen":
      return f.pitOpen;
    case "arena.pitDist":
      return f.pitDist;
    case "arena.sawsUp":
      return f.sawsUp;
    case "arena.sawsActive":
      return f.sawsUp || f.sawsSoon;
    case "arena.sawsDist":
      return f.sawsDist;
    case "arena.timeLeft":
      return f.timeLeft;
  }
}

export function evalCondition(cond: Condition, c: EvalContext): boolean {
  const v = subjectValue(cond.s, c);
  switch (cond.op) {
    case "<":
      return typeof v === "number" && v < Number(cond.v);
    case ">":
      return typeof v === "number" && v > Number(cond.v);
    case "is":
      return v === cond.v;
    case "not":
      return v !== cond.v;
  }
}

export function pickTarget(sel: TargetSel, c: EvalContext): OpponentFacts | undefined {
  switch (sel) {
    case "policy":
      return c.target;
    case "nearest":
      return c.nearest;
    case "weakest":
      return c.weakest;
    case "in_reach":
      return c.inReach ?? c.target;
    case "threat":
      return c.threat ?? c.target;
    case "held":
      return c.held ?? c.target;
  }
}

function fillNote(note: string, c: EvalContext, target: OpponentFacts | undefined): string {
  return note
    .replace(/\{target\}/g, target?.name ?? "nobody")
    .replace(/\{threat\}/g, c.threat?.name ?? "someone")
    .replace(/\{held\}/g, c.held?.name ?? "the victim");
}

/** Run the rule tree: first rule whose conditions all hold wins. Rules for uninstalled techniques are skipped. */
export function runRules(build: BotBuild, sense: BotSense): Intent {
  const f = sense.facts;
  const c = makeContext(build.logic, f);
  if (f.opponents.length === 0) return intentOf(null, "hold", 0, "nobody left", "none");
  const installed = new Set(build.techniques);
  for (const r of build.logic.rules) {
    if (!installed.has(r.maneuver)) continue;
    if (!r.when.every((cond) => evalCondition(cond, c))) continue;
    const target = pickTarget(r.target, c);
    const danger = c.threat ? r.dangerIfThreat : r.danger;
    return intentOf(target?.name ?? c.target?.name ?? null, r.maneuver, danger, fillNote(r.note, c, target), r.id);
  }
  return intentOf(c.target?.name ?? null, "engage", c.threat ? 0.5 : 0.1, "no rule matched, engage", "default");
}

export function intentOf(target: string | null, maneuver: Maneuver, danger: number, note: string, ruleId: string): Intent {
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
    ruleId,
  };
}

/** Which installed techniques Jev may choose from right now, in install order. */
export function availableManeuvers(build: BotBuild, sense: BotSense): Maneuver[] {
  const c = makeContext(build.logic, sense.facts);
  const out: Maneuver[] = [];
  for (const m of build.techniques) {
    const gate = build.logic.jev.techniques[m]?.when ?? [];
    if (gate.every((cond) => evalCondition(cond, c))) out.push(m);
  }
  return out.length ? out : ["engage"];
}

export function speculativeQuestions(build: BotBuild, sense: BotSense): Record<string, Question> {
  const c = makeContext(build.logic, sense.facts);
  const out: Record<string, Question> = {};
  for (const q of build.logic.jev.speculative) {
    if (!q.prompt.trim()) continue;
    if (q.when.every((cond) => evalCondition(cond, c))) out[q.key] = { type: "noul", instructions: q.prompt };
  }
  return out;
}

function fill(text: string, build: BotBuild): string {
  return text.replace(/\{name\}/g, build.name).replace(/\{weapon\}/g, WEAPONS[build.kind].weapon);
}

/** The full question set for one decision: target, maneuver, in_danger and the speculative extras. */
export function buildQuestions(build: BotBuild, sense: BotSense): Record<string, Question> {
  const { perception } = sense;
  const questions: Record<string, Question> = {};
  if (perception.opponents.length > 1) {
    const criteria: Record<string, string> = {};
    for (const o of perception.opponents) criteria[o.name] = `${o.weapon}; ${o.health}; ${o.distance}, ${o.bearing}; ${o.status}`;
    questions.target = { type: "choice", instructions: fill(build.logic.jev.targetPrompt, build), criteria };
  }
  const allowed = availableManeuvers(build, sense);
  const criteria: Record<string, string> = {};
  for (const m of allowed) criteria[m] = build.logic.jev.techniques[m]?.description?.trim() || TECHNIQUE_BY_M[m]?.blurb || m;
  questions.maneuver = { type: "choice", instructions: fill(build.logic.jev.maneuverPrompt, build), criteria };
  questions.in_danger = { type: "noul", instructions: fill(build.logic.jev.dangerPrompt, build) };
  Object.assign(questions, speculativeQuestions(build, sense));
  return questions;
}

/** Turn Jev's answers into an Intent, validating every answer against what is actually possible. */
export function interpretAnswers(build: BotBuild, sense: BotSense, answers: Record<string, JevAnswer>, latencyMs: number): Intent {
  const allowed = availableManeuvers(build, sense);
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
  // Shoving targets whoever the shove is aimed at; the holding rule below handles grabbers.
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

/** A BotDef is the sim's view of a build: derived stats and tuning, plus the brain callbacks. */
export function defFromBuild(build: BotBuild): BotDef {
  const d = derive(build);
  const maneuvers: Partial<Record<Maneuver, string>> = {};
  for (const m of build.techniques) maneuvers[m] = build.logic.jev.techniques[m]?.description ?? TECHNIQUE_BY_M[m]?.blurb ?? m;
  return {
    kind: build.kind,
    name: build.name,
    weapon: WEAPONS[build.kind].weapon,
    tagline: build.tagline,
    color: build.color,
    accent: build.accent,
    stats: {
      hp: d.hp,
      mass: d.mass,
      maxSpeed: d.maxSpeed,
      accel: d.accel,
      turnRate: d.turnRate,
      armor: d.armor,
      radius: d.radius,
      footprint: d.footprint,
      knockResist: d.knockResist,
      stunResist: d.stunResist,
      impactResist: d.impactResist,
      cadence: d.cadence,
      awareness: d.awareness,
    },
    tuning: d.tuning,
    build,
    maneuvers,
    available: (sense) => availableManeuvers(build, sense),
    extraQuestions: (sense) => speculativeQuestions(build, sense),
    baseline: (sense) => runRules(build, sense),
  };
}

export type { BotKind };

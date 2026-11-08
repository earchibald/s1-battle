import type { BotKind, Maneuver } from "./types";
import { BOT_KINDS } from "./types";

/**
 * Bot builds: everything a designer can change about a bot, as plain data.
 *
 *   BotBuild  = weapon system + six leveled parts + installed techniques + BotLogic
 *   BotLogic  = baseline rule tree + Jev gates/prompts, both written in one small condition language
 *
 * Parts cost build points on a steep curve and add mass; mass costs speed, acceleration and turn rate,
 * so a bot that lards on armor and weapon power ends up slow. Techniques cost points too.
 */

export const BUDGET = 50;
export const MAX_LEVEL = 5;
export const LEVEL_COST = [0, 1, 3, 6, 10, 15] as const;

export type PartKey = "armor" | "motor" | "frame" | "steering" | "power" | "cycle";
export const PART_KEYS: PartKey[] = ["armor", "motor", "frame", "steering", "power", "cycle"];
export const PART_INFO: Record<PartKey, { label: string; group: "chassis" | "weapon"; blurb: string }> = {
  armor: { label: "Armor plating", group: "chassis", blurb: "Each level shrugs off 9% of incoming damage. Heavy." },
  motor: { label: "Drive motors", group: "chassis", blurb: "Top speed and acceleration. A heavy build needs more of it." },
  frame: { label: "Frame", group: "chassis", blurb: "Structural hit points: 200 plus 50 per level." },
  steering: { label: "Steering", group: "chassis", blurb: "Turn rate. Flanking and tracking a circling target need it." },
  power: { label: "Weapon power", group: "weapon", blurb: "Damage, throw, grip or stun of the main weapon. Adds weight." },
  cycle: { label: "Weapon cycle", group: "weapon", blurb: "Spin-up or recharge speed of the main weapon." },
};

export interface WeaponSystem {
  kind: BotKind;
  label: string;
  /** Plain-English weapon name; this is what Jev reads. */
  weapon: string;
  blurb: string;
  mass: number;
  radius: number;
}
export const WEAPONS: Record<BotKind, WeaponSystem> = {
  saw: {
    kind: "saw",
    label: "Vertical saw",
    weapon: "vertical spinning saw blade",
    blurb: "Continuous contact damage. Needs spin-up and bleeds speed on every bite. Rear bites are critical.",
    mass: 0.55,
    radius: 0.85,
  },
  hammer: {
    kind: "hammer",
    label: "Pneumatic hammer",
    weapon: "overhead pneumatic hammer",
    blurb: "Windup, strike, long recharge. Huge hit plus a stun. Critical on anything that cannot move.",
    mass: 0.85,
    radius: 1.0,
  },
  grabber: {
    kind: "grabber",
    label: "Hydraulic jaws",
    weapon: "hydraulic grabbing arm",
    blurb: "Grab, crush, and drag victims into the pit or onto the kill saws. Rear grabs crush critically.",
    mass: 0.75,
    radius: 0.95,
  },
  flipper: {
    kind: "flipper",
    label: "Flipper wedge",
    weapon: "pneumatic flipper wedge",
    blurb: "Throws opponents into the air. Landings and walls do the damage. Flips toward a wall are critical.",
    mass: 0.65,
    radius: 0.9,
  },
};

export interface Technique {
  m: Maneuver;
  label: string;
  cost: number;
  /** Only installable with this weapon system. */
  kind?: BotKind;
  required?: boolean;
  blurb: string;
}
export const TECHNIQUES: Technique[] = [
  { m: "engage", label: "Engage", cost: 0, required: true, blurb: "Drive at the target, weapon first." },
  { m: "retreat", label: "Retreat", cost: 0, blurb: "Back away from the nearest threat toward open floor." },
  { m: "hold", label: "Hold", cost: 0, blurb: "Stop and keep turning to face the target." },
  { m: "circle", label: "Circle", cost: 1, blurb: "Orbit the target at medium range." },
  { m: "flank", label: "Flank", cost: 3, blurb: "Swing around to the target's side or rear, where the critical hits live." },
  { m: "spin_up", label: "Spin up", cost: 1, kind: "saw", blurb: "Keep clear until the blade is at speed." },
  { m: "strike_now", label: "Strike", cost: 2, kind: "hammer", blurb: "Commit the hammer this instant." },
  { m: "grab_now", label: "Grab", cost: 2, kind: "grabber", blurb: "Close the jaws this instant." },
  { m: "crush", label: "Crush", cost: 1, kind: "grabber", blurb: "Hold still and squeeze." },
  { m: "drag_to_pit", label: "Drag to pit", cost: 3, kind: "grabber", blurb: "Haul a held victim into the open pit." },
  { m: "drag_to_saws", label: "Drag to saws", cost: 3, kind: "grabber", blurb: "Haul a held victim onto the kill saws." },
  { m: "release", label: "Release", cost: 0, kind: "grabber", blurb: "Let go, usually to escape a third bot." },
  { m: "flip_now", label: "Flip", cost: 2, kind: "flipper", blurb: "Fire the flipper this instant." },
];
export const TECHNIQUE_BY_M: Record<string, Technique> = Object.fromEntries(TECHNIQUES.map((t) => [t.m, t]));
export function techniqueAllowed(m: Maneuver, kind: BotKind): boolean {
  const t = TECHNIQUE_BY_M[m];
  return !!t && (!t.kind || t.kind === kind);
}

/* ------------------------------------------------------------------------------------------------ */
/* Condition language                                                                                */
/* ------------------------------------------------------------------------------------------------ */

export type SubjectType = "frac" | "meters" | "facing" | "bool" | "kind" | "count" | "seconds";
export type SubjectKey =
  | "me.hp"
  | "me.charge"
  | "me.ready"
  | "me.holding"
  | "target.dist"
  | "target.hp"
  | "target.facing"
  | "target.ready"
  | "target.stunned"
  | "target.airborne"
  | "target.helpless"
  | "target.inReach"
  | "target.kind"
  | "anyone.inReach"
  | "nearest.dist"
  | "threat.exists"
  | "threat.dist"
  | "threat.kind"
  | "others.threatDist"
  | "opponents.count"
  | "arena.pitOpen"
  | "arena.pitDist"
  | "arena.sawsUp"
  | "arena.sawsActive"
  | "arena.sawsDist"
  | "arena.timeLeft";

export interface Subject {
  key: SubjectKey;
  label: string;
  type: SubjectType;
  group: "me" | "target" | "threat" | "field" | "arena";
}
export const SUBJECTS: Subject[] = [
  { key: "me.hp", label: "my health", type: "frac", group: "me" },
  { key: "me.charge", label: "my weapon charge", type: "frac", group: "me" },
  { key: "me.ready", label: "my weapon is ready", type: "bool", group: "me" },
  { key: "me.holding", label: "I am holding a bot", type: "bool", group: "me" },
  { key: "target.dist", label: "target distance", type: "meters", group: "target" },
  { key: "target.hp", label: "target health", type: "frac", group: "target" },
  { key: "target.facing", label: "target facing me", type: "facing", group: "target" },
  { key: "target.ready", label: "target weapon ready", type: "bool", group: "target" },
  { key: "target.stunned", label: "target is stunned", type: "bool", group: "target" },
  { key: "target.airborne", label: "target is airborne", type: "bool", group: "target" },
  { key: "target.helpless", label: "target is helpless (stunned, airborne or held)", type: "bool", group: "target" },
  { key: "target.inReach", label: "target in my weapon's reach", type: "bool", group: "target" },
  { key: "target.kind", label: "target weapon type", type: "kind", group: "target" },
  { key: "threat.exists", label: "someone is lining me up", type: "bool", group: "threat" },
  { key: "threat.dist", label: "nearest threat distance", type: "meters", group: "threat" },
  { key: "threat.kind", label: "nearest threat weapon type", type: "kind", group: "threat" },
  { key: "others.threatDist", label: "nearest threat that is not my victim", type: "meters", group: "threat" },
  { key: "anyone.inReach", label: "someone is in my weapon's reach", type: "bool", group: "field" },
  { key: "nearest.dist", label: "nearest opponent distance", type: "meters", group: "field" },
  { key: "opponents.count", label: "opponents left", type: "count", group: "field" },
  { key: "arena.pitOpen", label: "pit is open", type: "bool", group: "arena" },
  { key: "arena.pitDist", label: "distance to the pit", type: "meters", group: "arena" },
  { key: "arena.sawsUp", label: "kill saws are up", type: "bool", group: "arena" },
  { key: "arena.sawsActive", label: "kill saws are up or rising", type: "bool", group: "arena" },
  { key: "arena.sawsDist", label: "distance to the nearest saw slot", type: "meters", group: "arena" },
  { key: "arena.timeLeft", label: "match time left", type: "seconds", group: "arena" },
];
export const SUBJECT_BY_KEY: Record<string, Subject> = Object.fromEntries(SUBJECTS.map((s) => [s.key, s]));

export type Op = "<" | ">" | "is" | "not";
export type CondValue = number | boolean | BotKind;
export interface Condition {
  s: SubjectKey;
  op: Op;
  v: CondValue;
}

/** Which opponent a rule points the bot at. "policy" defers to the tree's targeting policy. */
export type TargetSel = "policy" | "nearest" | "weakest" | "in_reach" | "threat" | "held";
export const TARGET_SELS: { key: TargetSel; label: string }[] = [
  { key: "policy", label: "per targeting policy" },
  { key: "nearest", label: "nearest opponent" },
  { key: "weakest", label: "weakest opponent" },
  { key: "in_reach", label: "whoever is in reach" },
  { key: "threat", label: "the threat" },
  { key: "held", label: "the bot I hold" },
];

export interface Rule {
  id: string;
  /** All conditions must hold. An empty list always fires (the tree's default). */
  when: Condition[];
  maneuver: Maneuver;
  target: TargetSel;
  /** Danger estimate handed to the controller; the second applies when someone is lining me up. */
  danger: number;
  dangerIfThreat: number;
  /** Ticker note. {target}, {threat} and {held} are substituted. */
  note: string;
}
export interface Targeting {
  prefer: "nearest" | "weakest";
  /** Switch to the weakest opponent when its health is below this fraction... */
  finishBelow: number;
  /** ...and it is at most this many meters farther away than the nearest. */
  finishWithin: number;
}
export interface TechniqueLogic {
  /** What Jev reads as the option's description. */
  description: string;
  /** Jev may only pick this technique while every condition holds. Empty: always offered. */
  when: Condition[];
}
export interface Speculative {
  key: string;
  prompt: string;
  when: Condition[];
}
export interface BotLogic {
  targeting: Targeting;
  rules: Rule[];
  jev: {
    maneuverPrompt: string;
    targetPrompt: string;
    dangerPrompt: string;
    techniques: Partial<Record<Maneuver, TechniqueLogic>>;
    speculative: Speculative[];
  };
}

export interface BotBuild {
  /** Stable slot id, e.g. "slot-0". */
  id: string;
  name: string;
  tagline: string;
  kind: BotKind;
  color: number;
  accent: number;
  levels: Record<PartKey, number>;
  techniques: Maneuver[];
  logic: BotLogic;
}

/* ------------------------------------------------------------------------------------------------ */
/* Derived numbers                                                                                   */
/* ------------------------------------------------------------------------------------------------ */

export interface WeaponTuning {
  saw: { spinUpSeconds: number; baseDamage: number; spinDamage: number; biteCost: number; hitCooldown: number; hopSpin: number };
  hammer: { windup: number; strike: number; recover: number; cooldown: number; damage: number; stun: number };
  grabber: { crushDps: number; maxHold: number; cooldown: number };
  flipper: { cooldown: number; launchVz: number; launchForward: number; damage: number; anim: number };
}
export type WeightClass = "lightweight" | "middleweight" | "heavyweight" | "superheavy";
export interface Derived {
  hp: number;
  mass: number;
  maxSpeed: number;
  accel: number;
  turnRate: number;
  armor: number;
  radius: number;
  weightClass: WeightClass;
  /** How much a flip throws this bot, 0..1. */
  flipResist: number;
  tuning: WeaponTuning;
}

const r2 = (x: number) => Math.round(x * 100) / 100;

export function derive(b: BotBuild): Derived {
  const L = b.levels;
  const w = WEAPONS[b.kind];
  const mass = r2(0.2 + w.mass + L.armor * 0.11 + L.frame * 0.03 + L.power * 0.04);
  const P = L.power;
  const C = L.cycle;
  return {
    hp: 200 + L.frame * 50,
    mass,
    maxSpeed: r2((3.0 + L.motor * 0.85) / Math.sqrt(mass)),
    accel: r2((7 + L.motor * 1.8) / mass),
    turnRate: r2((1.6 + L.steering * 0.75) / Math.pow(mass, 0.3)),
    armor: r2(L.armor * 0.09),
    radius: w.radius,
    weightClass: mass < 1.1 ? "lightweight" : mass < 1.5 ? "middleweight" : mass < 1.9 ? "heavyweight" : "superheavy",
    flipResist: r2(1 - Math.min(1, 1.15 / mass)),
    tuning: {
      saw: { spinUpSeconds: r2(3.5 - C * 0.5), baseDamage: 2 + P, spinDamage: 6 + P * 2, biteCost: r2(0.48 - C * 0.04), hitCooldown: 0.55, hopSpin: 0.9 },
      hammer: { windup: 0.28, strike: 0.1, recover: 0.4, cooldown: r2(3.5 - C * 0.5), damage: 7 + P * 5, stun: r2(0.4 + P * 0.05) },
      grabber: { crushDps: 2 + P, maxHold: r2(2.4 + P * 0.4), cooldown: r2(4.9 - C * 0.5) },
      flipper: { cooldown: r2(3.6 - C * 0.5), launchVz: r2(6.5 + P * 0.9), launchForward: r2(4.4 + P * 0.7), damage: 4 + P * 2, anim: 0.45 },
    },
  };
}

export interface Cost {
  parts: number;
  techniques: number;
  total: number;
  /** Points over budget (0 when legal). */
  over: number;
}
export function costOf(b: BotBuild): Cost {
  let parts = 0;
  for (const k of PART_KEYS) parts += LEVEL_COST[clampLevel(b.levels[k])];
  let techniques = 0;
  for (const m of b.techniques) techniques += TECHNIQUE_BY_M[m]?.cost ?? 0;
  const total = parts + techniques;
  return { parts, techniques, total, over: Math.max(0, total - BUDGET) };
}

export function clampLevel(x: unknown): number {
  const n = typeof x === "number" && Number.isFinite(x) ? Math.round(x) : 0;
  return Math.max(0, Math.min(MAX_LEVEL, n));
}

/** Human-readable problems with a build. Errors block deployment; warnings do not. */
export interface Problem {
  level: "error" | "warn";
  text: string;
}
export function validateBuild(b: BotBuild): Problem[] {
  const out: Problem[] = [];
  const cost = costOf(b);
  if (cost.over > 0) out.push({ level: "error", text: `${cost.over} point${cost.over === 1 ? "" : "s"} over the ${BUDGET}-point budget` });
  if (!b.name.trim()) out.push({ level: "error", text: "the bot needs a name" });
  if (!b.techniques.includes("engage")) out.push({ level: "error", text: "Engage is required" });
  for (const m of b.techniques) {
    if (!techniqueAllowed(m, b.kind)) out.push({ level: "error", text: `${TECHNIQUE_BY_M[m]?.label ?? m} needs a ${WEAPONS[TECHNIQUE_BY_M[m]?.kind ?? b.kind].label.toLowerCase()}` });
  }
  const seen = new Set<string>();
  for (const r of b.logic.rules) {
    if (!b.techniques.includes(r.maneuver)) out.push({ level: "warn", text: `rule "${r.id}" uses ${TECHNIQUE_BY_M[r.maneuver]?.label ?? r.maneuver}, which is not installed; it will be skipped` });
    if (seen.has(r.id)) out.push({ level: "warn", text: `two rules share the id "${r.id}"` });
    seen.add(r.id);
  }
  const last = b.logic.rules[b.logic.rules.length - 1];
  if (!last || last.when.length > 0) out.push({ level: "warn", text: "no unconditional last rule: the bot will Engage when nothing matches" });
  for (const m of b.techniques) {
    if (!b.logic.jev.techniques[m]?.description?.trim()) out.push({ level: "warn", text: `${TECHNIQUE_BY_M[m]?.label ?? m} has no description for Jev` });
  }
  return out;
}

/* ------------------------------------------------------------------------------------------------ */
/* Normalization: accept anything JSON-shaped, hand back a well-formed build                          */
/* ------------------------------------------------------------------------------------------------ */

const MAX_TEXT = 700;
const str = (x: unknown, fallback: string, max = MAX_TEXT): string => (typeof x === "string" ? x.slice(0, max) : fallback);
const num = (x: unknown, fallback: number, lo = -Infinity, hi = Infinity): number =>
  typeof x === "number" && Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : fallback;
const isKind = (x: unknown): x is BotKind => typeof x === "string" && (BOT_KINDS as string[]).includes(x);
const isManeuver = (x: unknown): x is Maneuver => typeof x === "string" && x in TECHNIQUE_BY_M;

export function normalizeCondition(raw: unknown): Condition | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as { s?: unknown; op?: unknown; v?: unknown };
  const subj = SUBJECT_BY_KEY[c.s as string];
  if (!subj) return null;
  switch (subj.type) {
    case "bool": {
      const v = typeof c.v === "boolean" ? c.v : c.v === "true" ? true : c.v === "false" ? false : true;
      return { s: subj.key, op: "is", v };
    }
    case "kind": {
      if (!isKind(c.v)) return null;
      return { s: subj.key, op: c.op === "not" ? "not" : "is", v: c.v };
    }
    default: {
      const op = c.op === ">" ? ">" : "<";
      return { s: subj.key, op, v: num(c.v, 0) };
    }
  }
}
export function normalizeConditions(raw: unknown, max = 8): Condition[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeCondition).filter((c): c is Condition => !!c).slice(0, max);
}

export function normalizeLogic(raw: unknown, fallback: BotLogic): BotLogic {
  const r = (raw && typeof raw === "object" ? raw : {}) as { targeting?: unknown; rules?: unknown; jev?: unknown };
  const t = (r.targeting && typeof r.targeting === "object" ? r.targeting : {}) as Partial<Targeting>;
  const rules: Rule[] = Array.isArray(r.rules)
    ? r.rules
        .filter((x): x is Rule => !!x && typeof x === "object" && isManeuver((x as Rule).maneuver))
        .slice(0, 24)
        .map((x, i) => ({
          id: str(x.id, `rule-${i + 1}`, 24) || `rule-${i + 1}`,
          when: normalizeConditions(x.when),
          maneuver: x.maneuver,
          target: TARGET_SELS.some((s) => s.key === x.target) ? x.target : "policy",
          danger: num(x.danger, 0.1, 0, 1),
          dangerIfThreat: num(x.dangerIfThreat, num(x.danger, 0.1, 0, 1), 0, 1),
          note: str(x.note, "", 120),
        }))
    : fallback.rules;
  const jr = (r.jev && typeof r.jev === "object" ? r.jev : {}) as Partial<BotLogic["jev"]>;
  const techniques: Partial<Record<Maneuver, TechniqueLogic>> = {};
  const rawTech = (jr.techniques ?? {}) as Record<string, Partial<TechniqueLogic>>;
  for (const m of Object.keys(rawTech)) {
    if (!isManeuver(m)) continue;
    const tl = rawTech[m] ?? {};
    techniques[m] = { description: str(tl.description, fallback.jev.techniques[m]?.description ?? ""), when: normalizeConditions(tl.when) };
  }
  for (const m of Object.keys(fallback.jev.techniques) as Maneuver[]) {
    if (!techniques[m]) techniques[m] = { ...fallback.jev.techniques[m]!, when: [...fallback.jev.techniques[m]!.when] };
  }
  const speculative: Speculative[] = Array.isArray(jr.speculative)
    ? (jr.speculative as unknown[])
        .filter((x): x is Partial<Speculative> => !!x && typeof x === "object")
        .slice(0, 6)
        .map((x, i) => ({
          key: (str(x.key, `question_${i + 1}`, 32).replace(/[^a-zA-Z0-9_]/g, "_") || `question_${i + 1}`),
          prompt: str(x.prompt, ""),
          when: normalizeConditions(x.when),
        }))
        .filter((x) => x.prompt.trim().length > 0)
    : fallback.jev.speculative;
  return {
    targeting: {
      prefer: t.prefer === "weakest" ? "weakest" : "nearest",
      finishBelow: num(t.finishBelow, fallback.targeting.finishBelow, 0, 1),
      finishWithin: num(t.finishWithin, fallback.targeting.finishWithin, 0, 30),
    },
    rules,
    jev: {
      maneuverPrompt: str(jr.maneuverPrompt, fallback.jev.maneuverPrompt),
      targetPrompt: str(jr.targetPrompt, fallback.jev.targetPrompt),
      dangerPrompt: str(jr.dangerPrompt, fallback.jev.dangerPrompt),
      techniques,
      speculative,
    },
  };
}

/** `stockFor(kind)` supplies the fallback for anything missing or malformed. */
export function normalizeBuild(raw: unknown, stockFor: (kind: BotKind) => BotBuild, id: string): BotBuild {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<BotBuild>;
  const kind: BotKind = isKind(r.kind) ? r.kind : "saw";
  const stock = stockFor(kind);
  const levels = {} as Record<PartKey, number>;
  const rawLevels = (r.levels ?? {}) as Partial<Record<PartKey, unknown>>;
  for (const k of PART_KEYS) levels[k] = clampLevel(k in rawLevels ? rawLevels[k] : stock.levels[k]);
  const techniques = Array.isArray(r.techniques) ? r.techniques.filter(isManeuver).filter((m) => techniqueAllowed(m, kind)) : [...stock.techniques];
  if (!techniques.includes("engage")) techniques.unshift("engage");
  return {
    id,
    name: str(r.name, stock.name, 16).trim() || stock.name,
    tagline: str(r.tagline, stock.tagline, 80),
    kind,
    color: num(r.color, stock.color, 0, 0xffffff),
    accent: num(r.accent, stock.accent, 0, 0xffffff),
    levels,
    techniques: Array.from(new Set(techniques)),
    logic: normalizeLogic(r.logic, stock.logic),
  };
}

export function cloneBuild(b: BotBuild): BotBuild {
  return JSON.parse(JSON.stringify(b)) as BotBuild;
}

/** Formatting helpers shared by the HUD, the designer and the headless printer. */
export function fmtLevelValue(b: BotBuild, k: PartKey): string {
  const d = derive(b);
  switch (k) {
    case "armor":
      return `${Math.round(d.armor * 100)}% damage shrugged off`;
    case "motor":
      return `${d.maxSpeed.toFixed(1)} m/s · ${d.accel.toFixed(1)} m/s²`;
    case "frame":
      return `${d.hp} hp`;
    case "steering":
      return `${d.turnRate.toFixed(1)} rad/s`;
    case "power":
      switch (b.kind) {
        case "saw":
          return `${d.tuning.saw.baseDamage}–${d.tuning.saw.baseDamage + d.tuning.saw.spinDamage} per bite`;
        case "hammer":
          return `${d.tuning.hammer.damage} dmg · ${d.tuning.hammer.stun.toFixed(2)}s stun`;
        case "grabber":
          return `${d.tuning.grabber.crushDps}/s crush · ${d.tuning.grabber.maxHold.toFixed(1)}s grip`;
        case "flipper":
          return `${d.tuning.flipper.damage} dmg · ${d.tuning.flipper.launchVz.toFixed(1)} m/s throw`;
      }
      break;
    case "cycle":
      switch (b.kind) {
        case "saw":
          return `${d.tuning.saw.spinUpSeconds.toFixed(1)}s spin-up · −${Math.round(d.tuning.saw.biteCost * 100)}% per bite`;
        case "hammer":
          return `${d.tuning.hammer.cooldown.toFixed(1)}s recharge`;
        case "grabber":
          return `${d.tuning.grabber.cooldown.toFixed(1)}s recharge`;
        case "flipper":
          return `${d.tuning.flipper.cooldown.toFixed(1)}s recharge`;
      }
  }
  return "";
}

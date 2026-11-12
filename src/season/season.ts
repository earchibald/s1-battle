import type { BotBuild } from "@shared/build";
import { cloneBuild, costOf } from "@shared/build";
import { STOCK_ORDER, stockBuild } from "@shared/bots/index";

/**
 * Season arc: pure state, scheduling, scoring and storylines. No DOM, no simulation, no clock, no Math.random:
 * everything is a function of the season state (which carries its own seed), so the same season replays the
 * same schedule and the same headlines, in the browser or in scripts/season-sim.ts.
 *
 * FORMAT (10 matches, one sitting):
 *   League     8 bots, 4 weeks, 2 four-bot matches a week. Every bot fights every week, and the schedule is
 *              built so every pair of bots meets at least once (1 to 3 times).
 *   Last Chance  The top 2 of the table go straight to the Grand Final. 3rd to 6th fight one match for the
 *              other two places. 7th and 8th are out.
 *   Grand Final  Four bots, one match, the winner is champion. League points do not carry over.
 *
 * POINTS (league table): 5 / 3 / 1 / 0 by finishing place, +1 per elimination credited to the bot, +1 to the
 * match's top damage dealer. Ties: wins, eliminations, damage dealt, then entry order.
 */

export const SEASON_VERSION = 1;
export const LEAGUE_SIZE = 8;
export const LEAGUE_WEEKS = 4;
export const DIRECT_FINALISTS = 2;
export const LAST_CHANCE_CUT = 6;
export const POINTS = { place: [5, 3, 1, 0], elimination: 1, topDamage: 1 } as const;
/** Total matches in a full season: league + Last Chance + Grand Final. */
export const SEASON_MATCHES = LEAGUE_WEEKS * 2 + 2;

export type Origin = "garage" | "library" | "stock" | "wildcard";
export type Stage = "league" | "lastchance" | "final";

/** The user who designed a bot: a profile in src/account/accounts.ts. The name is frozen at season start. */
export interface Owner {
  id: string;
  name: string;
}

export interface Entrant {
  /** The bot's arena id: its callsign. Unique in the league. */
  id: string;
  build: BotBuild;
  origin: Origin;
  /** Designed by the user who started the season (Garage roster or Library). */
  mine: boolean;
  /** The designer, when the bot belongs to a user. Stock bots, wildcards and pre-accounts saves have none. */
  owner?: Owner;
}

export interface Fixture {
  id: string;
  stage: Stage;
  /** 1..LEAGUE_WEEKS for the league, then LEAGUE_WEEKS+1 (Last Chance) and +2 (Grand Final). */
  week: number;
  label: string;
  /** Entrant ids in start-corner order. */
  bots: string[];
  /** Simulation seed for this match. */
  seed: number;
}

export interface Kill {
  killer: string | null;
  victim: string;
  how: "destroyed" | "pitted";
  /** Fight time in seconds. */
  t: number;
}

/** What a finished match hands the season: plain numbers, no sim objects. */
export interface MatchOutcome {
  duration: number;
  reason: "last_standing" | "judges" | "draw";
  winner: string | null;
  bots: { id: string; alive: boolean; hp: number; hpFrac: number; damage: number }[];
  kills: Kill[];
}

export interface PlaceRow {
  id: string;
  place: number;
  hp: number;
  hpFrac: number;
  damage: number;
  eliminated: "destroyed" | "pitted" | null;
  by: string | null;
  elims: number;
  topDamage: boolean;
  points: number;
}

export interface MatchRecord {
  fixtureId: string;
  stage: Stage;
  week: number;
  label: string;
  rows: PlaceRow[];
  kills: Kill[];
  duration: number;
  reason: MatchOutcome["reason"];
  /** Run headlessly on baseline brains instead of being played in the arena. */
  simulated: boolean;
  /** League rank of each participant going in (1 = top). */
  rankBefore: Record<string, number>;
  upset: boolean;
  headlines: string[];
}

export interface SeasonState {
  version: number;
  seed: number;
  startedAt: number;
  entrants: Entrant[];
  fixtures: Fixture[];
  records: MatchRecord[];
  champion: string | null;
}

/* ------------------------------------------------------------------------------------------------ */
/* Deterministic helpers                                                                             */
/* ------------------------------------------------------------------------------------------------ */

function rng(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffled<T>(xs: T[], rand: () => number): T[] {
  const out = xs.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
const ORD = ["", "1st", "2nd", "3rd", "4th", "5th", "6th", "7th", "8th"];
export const ordinal = (n: number) => ORD[n] ?? `${n}th`;
const COUNT = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight"];
const count = (n: number) => COUNT[n] ?? String(n);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : w.endsWith("ch") ? "es" : "s"}`;
const times = (n: number) => (n === 1 ? "once" : n === 2 ? "twice" : `${count(n)} times`);
const how = (h: Kill["how"]) => (h === "pitted" ? "pitted" : "destroyed");

/* ------------------------------------------------------------------------------------------------ */
/* Entrants                                                                                          */
/* ------------------------------------------------------------------------------------------------ */

/** House rivals that fill the league when the player brings fewer than eight distinct bots. Stock bodies, retuned. */
export function wildcardBuilds(): BotBuild[] {
  const make = (kind: BotBuild["kind"], name: string, tagline: string, color: number, levels: Partial<BotBuild["levels"]>): BotBuild => {
    const base = stockBuild(kind);
    const b: BotBuild = { ...base, id: `wild-${kind}`, name, tagline, color, levels: { ...base.levels, ...levels } };
    // A wildcard must be a legal build; if the budget ever moves under it, fall back to the stock parts.
    return costOf(b).over > 0 ? { ...b, levels: base.levels } : b;
  };
  return [
    make("saw", "HACKSAW", "Same teeth, thicker skin.", 0x4a9dff, { armor: 1, motor: 4, gyro: 3 }),
    make("spinner", "MAELSTROM", "The bar never stops. Neither do I.", 0xe8e8f0, { armor: 2, cycle: 3, wedge: 1, sensors: 2 }),
    make("hammer", "BULWARK", "Hit me first. See what happens.", 0xb08d57, { armor: 4, gyro: 2 }),
  ];
}

/** A build with the user who designed it, as the Library and other users' Garages hand them over. */
export interface OwnedBuild {
  build: BotBuild;
  owner?: Owner;
}

export interface Candidate {
  build: BotBuild;
  origin: Origin;
  mine: boolean;
  owner?: Owner;
  /** In the default league. */
  selected: boolean;
}

/** Same machine and same baseline brain as the stock bot of its kind (the player has not really touched it). */
function isStock(b: BotBuild): boolean {
  const s = stockBuild(b.kind);
  const sig = (x: BotBuild) => JSON.stringify([x.name, x.levels, x.techniques, x.logic.rules, x.logic.targeting]);
  return sig(b) === sig(s);
}

/**
 * Everyone who could enter: the Garage roster, saved Library builds, other users' Garage rosters, the stock bots
 * and the house wildcards, one per callsign (earlier sources win a name clash, so a modified RIPSAW in the Garage
 * replaces the stock one). The default league is the user's own builds first, then other designers', then stock,
 * then wildcards, up to eight.
 *
 * `me` is the user setting the season up: the roster is theirs, and `mine` marks their builds. Without `me`
 * (scripts, pre-accounts callers) every Garage and Library build counts as the player's own and has no owner.
 */
export function candidatePool(roster: BotBuild[], library: (BotBuild | OwnedBuild)[], me?: Owner, rivalGarages: OwnedBuild[] = []): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const add = (b: BotBuild, origin: Origin, owner?: Owner) => {
    const key = b.name.trim().toUpperCase();
    if (!key || seen.has(key)) return;
    if ((origin === "garage" || origin === "library") && isStock(b)) return; // it will enter as the stock bot
    if (costOf(b).over > 0) return; // illegal builds cannot deploy, so they cannot enter either
    seen.add(key);
    const designed = origin === "garage" || origin === "library";
    const c: Candidate = { build: cloneBuild(b), origin, mine: designed && (me ? owner?.id === me.id : true), selected: false };
    if (designed && owner) c.owner = { id: owner.id, name: owner.name };
    out.push(c);
  };
  const saved: OwnedBuild[] = library.map((x) => ("build" in x ? x : { build: x, owner: me }));
  for (const b of roster) add(b, "garage", me);
  for (const x of saved) if (!me || x.owner?.id === me.id) add(x.build, "library", x.owner);
  for (const x of rivalGarages) add(x.build, "garage", x.owner);
  for (const x of saved) if (me && x.owner?.id !== me.id) add(x.build, "library", x.owner);
  for (const k of STOCK_ORDER) add(stockBuild(k), "stock");
  for (const b of wildcardBuilds()) add(b, "wildcard");
  let n = 0;
  for (const c of out) if (n < LEAGUE_SIZE) (c.selected = true), n++;
  return out;
}

/* ------------------------------------------------------------------------------------------------ */
/* Schedule                                                                                          */
/* ------------------------------------------------------------------------------------------------ */

/**
 * Number the eight bots 0..7 and read each number as three bits. A bit mask f splits them into the four whose
 * masked bits have even parity and the four with odd parity. These four masks are chosen so that any two
 * bots land in the same half for at least one of them: every pair meets 1 to 3 times in 4 weeks.
 */
const WEEK_MASKS = [3, 5, 6, 7];
const parity = (x: number) => (x ^ (x >> 1) ^ (x >> 2)) & 1;

export function leagueSchedule(ids: string[], seed: number): Fixture[] {
  if (ids.length !== LEAGUE_SIZE) throw new Error(`a season needs exactly ${LEAGUE_SIZE} bots`);
  const rand = rng(seed);
  const seats = shuffled(ids, rand);
  const masks = shuffled(WEEK_MASKS, rand);
  const out: Fixture[] = [];
  masks.forEach((mask, w) => {
    const halves = [0, 1].map((p) => seats.filter((_, i) => parity(i & mask) === p));
    (rand() < 0.5 ? halves : halves.reverse()).forEach((bots, m) => {
      out.push({
        id: `w${w + 1}${"ab"[m]}`,
        stage: "league",
        week: w + 1,
        label: `Week ${w + 1} · Match ${"AB"[m]}`,
        bots: shuffled(bots, rand),
        seed: fixtureSeed(seed, out.length),
      });
    });
  });
  return out;
}
const fixtureSeed = (seed: number, index: number) => ((seed * 31 + (index + 1) * 977) >>> 0) % 100000;

export function createSeason(entrants: { build: BotBuild; origin: Origin; mine: boolean; owner?: Owner }[], seed: number, startedAt = 0): SeasonState {
  if (entrants.length !== LEAGUE_SIZE) throw new Error(`a season needs exactly ${LEAGUE_SIZE} bots`);
  const names = new Set(entrants.map((e) => e.build.name));
  if (names.size !== entrants.length) throw new Error("every bot in a season needs its own callsign");
  const list: Entrant[] = entrants.map((e, i) => ({
    id: e.build.name,
    build: { ...cloneBuild(e.build), id: `season-${i}` },
    origin: e.origin,
    mine: e.mine,
    ...(e.owner ? { owner: { id: e.owner.id, name: e.owner.name } } : {}),
  }));
  return { version: SEASON_VERSION, seed, startedAt, entrants: list, fixtures: leagueSchedule(list.map((e) => e.id), seed), records: [], champion: null };
}

/* ------------------------------------------------------------------------------------------------ */
/* Queries                                                                                           */
/* ------------------------------------------------------------------------------------------------ */

export const entrant = (s: SeasonState, id: string) => s.entrants.find((e) => e.id === id);
export const recordFor = (s: SeasonState, fixtureId: string) => s.records.find((r) => r.fixtureId === fixtureId);
export const nextFixture = (s: SeasonState): Fixture | null => s.fixtures.find((f) => !recordFor(s, f.id)) ?? null;
export const isComplete = (s: SeasonState) => s.champion !== null;
export const lastRecord = (s: SeasonState): MatchRecord | null => s.records[s.records.length - 1] ?? null;

/** Every user with a bot in the season, in entry order. */
export function designers(s: SeasonState): Owner[] {
  const out: Owner[] = [];
  for (const e of s.entrants) if (e.owner && !out.some((o) => o.id === e.owner!.id)) out.push(e.owner);
  return out;
}

/**
 * How the storylines credit a designed bot: "your " while a single user has bots in the league, the designer's
 * name ("Ana's ") once two or more users do, and nothing for house bots.
 */
export function whose(s: SeasonState, id: string): string {
  const e = entrant(s, id);
  if (!e) return "";
  if (e.owner && designers(s).length > 1) return `${e.owner.name}'s `;
  return e.mine || e.owner ? "your " : "";
}

export interface Standing {
  id: string;
  rank: number;
  played: number;
  points: number;
  wins: number;
  elims: number;
  damage: number;
  /** Times this bot was eliminated. */
  outs: number;
  /** Finishing places, oldest first (league only). */
  form: number[];
}

/** The league table from the given records (default: all league matches so far). */
export function standings(s: SeasonState, records: MatchRecord[] = s.records): Standing[] {
  const rows = new Map<string, Standing>(s.entrants.map((e) => [e.id, { id: e.id, rank: 0, played: 0, points: 0, wins: 0, elims: 0, damage: 0, outs: 0, form: [] }]));
  for (const r of records) {
    if (r.stage !== "league") continue;
    for (const p of r.rows) {
      const st = rows.get(p.id);
      if (!st) continue;
      st.played++;
      st.points += p.points;
      st.wins += p.place === 1 ? 1 : 0;
      st.elims += p.elims;
      st.damage += p.damage;
      st.outs += p.eliminated ? 1 : 0;
      st.form.push(p.place);
    }
  }
  const order = new Map(s.entrants.map((e, i) => [e.id, i]));
  const out = [...rows.values()].sort((a, b) => b.points - a.points || b.wins - a.wins || b.elims - a.elims || b.damage - a.damage || order.get(a.id)! - order.get(b.id)!);
  out.forEach((r, i) => (r.rank = i + 1));
  return out;
}

/**
 * The table a fixture's bots are judged by going in. Within a league week both matches see the table as it
 * stood at the end of the previous week, so Match B's storylines and upsets are not skewed by four bots
 * having played one match more.
 */
export function tableGoingIn(s: SeasonState, fx: Fixture): Standing[] {
  return fx.stage === "league" ? standings(s, s.records.filter((r) => r.stage === "league" && r.week < fx.week)) : standings(s);
}

/** Rank movement since the end of the previous league week (positive = climbed). */
export function rankMoves(s: SeasonState): Record<string, number> {
  const league = s.records.filter((r) => r.stage === "league");
  const weekDone = Math.floor(league.length / 2);
  const out: Record<string, number> = {};
  if (weekDone < 2 && league.length < 3) return out;
  const prevCount = league.length % 2 === 0 ? league.length - 2 : league.length - 1;
  if (prevCount < 2) return out;
  const prev = new Map(standings(s, league.slice(0, prevCount)).map((r) => [r.id, r.rank]));
  for (const r of standings(s)) out[r.id] = prev.get(r.id)! - r.rank;
  return out;
}

/** Every finishing place for a bot across all stages, oldest first. */
function places(s: SeasonState, id: string, records = s.records): number[] {
  const out: number[] = [];
  for (const r of records) {
    const row = r.rows.find((p) => p.id === id);
    if (row) out.push(row.place);
  }
  return out;
}
const trailing = (xs: number[], ok: (x: number) => boolean) => {
  let n = 0;
  for (let i = xs.length - 1; i >= 0 && ok(xs[i]); i--) n++;
  return n;
};
export const winStreak = (s: SeasonState, id: string, records = s.records) => trailing(places(s, id, records), (p) => p === 1);
export const coldStreak = (s: SeasonState, id: string, records = s.records) => trailing(places(s, id, records), (p) => p >= 3);

export interface Rivalry {
  a: string;
  b: string;
  /** Eliminations of b by a, and of a by b. */
  aKills: number;
  bKills: number;
  meetings: number;
  /** The most recent elimination between them, and how many matches they have shared since. */
  last: { killer: string; victim: string; how: Kill["how"]; label: string; metSince: number } | null;
  heat: number;
}

/** Every pair with history, hottest first. Heat is eliminations between the two, with a bonus when both have drawn blood. */
export function rivalries(s: SeasonState, records: MatchRecord[] = s.records): Rivalry[] {
  const map = new Map<string, Rivalry>();
  const get = (x: string, y: string) => {
    const k = pairKey(x, y);
    let r = map.get(k);
    if (!r) map.set(k, (r = { a: x < y ? x : y, b: x < y ? y : x, aKills: 0, bKills: 0, meetings: 0, last: null, heat: 0 }));
    return r;
  };
  for (const rec of records) {
    const ids = rec.rows.map((p) => p.id);
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) {
        const r = get(ids[i], ids[j]);
        r.meetings++;
        if (r.last) r.last.metSince++;
      }
    for (const k of rec.kills) {
      if (!k.killer || k.killer === k.victim || !ids.includes(k.killer)) continue;
      const r = get(k.killer, k.victim);
      if (r.a === k.killer) r.aKills++;
      else r.bKills++;
      r.last = { killer: k.killer, victim: k.victim, how: k.how, label: rec.label, metSince: 0 };
    }
  }
  const out = [...map.values()].filter((r) => r.aKills + r.bKills > 0);
  for (const r of out) r.heat = r.aKills + r.bKills + (r.aKills > 0 && r.bKills > 0 ? 1 : 0);
  return out.sort((x, y) => y.heat - x.heat || y.meetings - x.meetings || (x.a + x.b < y.a + y.b ? -1 : 1));
}
const rivalryOf = (list: Rivalry[], x: string, y: string) => list.find((r) => pairKey(r.a, r.b) === pairKey(x, y));
const killsBy = (r: Rivalry, id: string) => (r.a === id ? r.aKills : r.bKills);

/* ------------------------------------------------------------------------------------------------ */
/* Scoring                                                                                           */
/* ------------------------------------------------------------------------------------------------ */

/**
 * Finishing order: survivors first (the declared winner, then by health fraction, then damage), then the
 * eliminated in reverse order of going out, so lasting longer always places higher.
 */
export function scoreOutcome(o: MatchOutcome): PlaceRow[] {
  const ids = new Set(o.bots.map((b) => b.id));
  const outAt = new Map<string, Kill>();
  for (const k of o.kills) if (!outAt.has(k.victim)) outAt.set(k.victim, k);
  const order = o.bots.slice().sort((a, b) => {
    if (a.alive !== b.alive) return a.alive ? -1 : 1;
    if (a.alive) return Number(b.id === o.winner) - Number(a.id === o.winner) || b.hpFrac - a.hpFrac || b.damage - a.damage;
    return (outAt.get(b.id)?.t ?? 0) - (outAt.get(a.id)?.t ?? 0) || b.damage - a.damage;
  });
  const top = o.bots.slice().sort((a, b) => b.damage - a.damage)[0];
  return order.map((b, i) => {
    const out = outAt.get(b.id);
    const elims = o.kills.filter((k) => k.killer === b.id && k.victim !== b.id && ids.has(k.victim)).length;
    const topDamage = !!top && top.id === b.id && top.damage > 0;
    return {
      id: b.id,
      place: i + 1,
      hp: Math.max(0, Math.round(b.hp)),
      hpFrac: b.hpFrac,
      damage: Math.round(b.damage),
      eliminated: b.alive ? null : (out?.how ?? "destroyed"),
      by: b.alive ? null : out?.killer && out.killer !== b.id ? out.killer : null,
      elims,
      topDamage,
      points: (POINTS.place[i] ?? 0) + elims * POINTS.elimination + (topDamage ? POINTS.topDamage : 0),
    };
  });
}

/**
 * Record a finished fixture and move the season on: when the league ends the Last Chance match is drawn up,
 * when that ends the Grand Final is, and the Grand Final crowns the champion. Returns a new state.
 */
export function applyResult(s: SeasonState, fixtureId: string, outcome: MatchOutcome, simulated = false): SeasonState {
  const fx = s.fixtures.find((f) => f.id === fixtureId);
  if (!fx || recordFor(s, fixtureId)) return s;
  const rows = scoreOutcome(outcome);
  const table = tableGoingIn(s, fx);
  const rankBefore = Object.fromEntries(fx.bots.map((id) => [id, table.find((r) => r.id === id)?.rank ?? 0]));
  const rec: MatchRecord = { fixtureId, stage: fx.stage, week: fx.week, label: fx.label, rows, kills: outcome.kills, duration: outcome.duration, reason: outcome.reason, simulated, rankBefore, upset: false, headlines: [] };
  rec.upset = isUpset(s, rec);
  const next: SeasonState = { ...s, fixtures: s.fixtures.slice(), records: [...s.records, rec] };
  const rand = rng(s.seed + next.records.length * 7919);
  const leagueDone = next.fixtures.filter((f) => f.stage === "league").every((f) => recordFor(next, f.id));
  if (fx.stage === "league" && leagueDone) {
    const t = standings(next);
    next.fixtures.push({
      id: "lastchance",
      stage: "lastchance",
      week: LEAGUE_WEEKS + 1,
      label: "Last Chance",
      bots: shuffled(t.slice(DIRECT_FINALISTS, LAST_CHANCE_CUT).map((r) => r.id), rand),
      seed: fixtureSeed(s.seed, next.fixtures.length),
    });
  } else if (fx.stage === "lastchance") {
    const t = standings(next);
    next.fixtures.push({
      id: "final",
      stage: "final",
      week: LEAGUE_WEEKS + 2,
      label: "Grand Final",
      bots: shuffled([...t.slice(0, DIRECT_FINALISTS).map((r) => r.id), rows[0].id, rows[1].id], rand),
      seed: fixtureSeed(s.seed, next.fixtures.length),
    });
  } else if (fx.stage === "final") {
    next.champion = rows[0].id;
  }
  rec.headlines = headlines(s, next, rec);
  return next;
}

/* ------------------------------------------------------------------------------------------------ */
/* Storylines                                                                                        */
/* ------------------------------------------------------------------------------------------------ */

function isUpset(before: SeasonState, rec: MatchRecord): boolean {
  const winner = rec.rows[0].id;
  if (rec.stage === "final") return !standings(before).slice(0, DIRECT_FINALISTS).some((r) => r.id === winner);
  // The table means nothing until everyone has fought once.
  if (before.records.length < 2) return false;
  const worst = Math.max(...Object.values(rec.rankBefore));
  return rec.rankBefore[winner] === worst && worst >= 5;
}

/** What just happened, as up to four lines, most newsworthy first. Deterministic for a given season. */
function headlines(before: SeasonState, after: SeasonState, rec: MatchRecord): string[] {
  const out: { w: number; text: string }[] = [];
  const add = (w: number, text: string) => out.push({ w, text });
  const [first, second, third, fourth] = rec.rows;
  const W = first.id;
  const you = (id: string) => whose(after, id);
  const prior = rivalries(before);

  if (rec.stage === "final") {
    add(100, rec.upset ? `${W} is champion, all the way from the Last Chance match.` : `${W} is champion. Top of the table, top of the podium.`);
  } else if (rec.stage === "lastchance") {
    add(100, `${W} and ${second.id} take the last two places in the Grand Final. ${third.id} and ${fourth.id} are out.`);
  } else if (rec.upset) {
    add(100, `UPSET: ${you(W)}${W} went in ${ordinal(rec.rankBefore[W])} in the table and won ${rec.label}.`);
  } else {
    const margin = first.eliminated ? "going out last" : first.hpFrac <= 0.15 ? `with ${first.hp} hp left` : rec.reason === "judges" ? "on the judges' cards" : "as the last bot standing";
    add(100, `${you(W)}${W} wins ${rec.label} ${margin}.`);
  }

  const streak = winStreak(after, W);
  if (streak >= 2) add(80 + streak, `${W} has now won ${count(streak)} in a row.`);
  else if (winStreak(before, W) === 0 && places(before, W).length >= 2 && !places(before, W).includes(1)) add(70, `${W} finally has a win, at the ${ordinal(places(after, W).length)} attempt.`);

  for (const p of rec.rows.slice(1)) {
    const had = winStreak(before, p.id);
    if (had >= 2) add(78 + had, `${p.id}'s run of ${count(had)} straight wins is over${p.by ? `, ended by ${p.by}` : ""}.`);
  }

  for (const k of rec.kills) {
    if (!k.killer || k.killer === k.victim) continue;
    const r = rivalryOf(prior, k.killer, k.victim);
    if (r?.last && r.last.killer === k.victim) {
      add(85, `REVENGE: ${k.killer} ${how(k.how) === "pitted" ? "pits" : "destroys"} ${k.victim}, payback for ${r.last.label}.`);
    } else if (r && killsBy(r, k.killer) >= 1 && killsBy(r, k.victim) === 0) {
      add(75 + killsBy(r, k.killer), `${k.killer} has ${k.victim}'s number: ${count(killsBy(r, k.killer) + 1)} eliminations, no reply.`);
    }
  }

  for (const p of rec.rows) {
    if (p.elims >= 2) add(72 + p.elims * 3, `${you(p.id)}${p.id} took out ${count(p.elims)} bots single-handed.`);
  }
  if (!first.eliminated && first.hpFrac <= 0.15 && (rec.upset || rec.stage !== "league")) add(50, `${W} finished on ${first.hp} hp. That close.`);

  if (rec.stage === "league") {
    const t = standings(after);
    const done = after.records.filter((r) => r.stage === "league").length;
    if (done === LEAGUE_WEEKS * 2) {
      add(90, `League over: ${t[0].id} and ${t[1].id} go straight to the Grand Final. ${t[6].id} and ${t[7].id} miss the cut.`);
    } else if (done % 2 === 0 && done >= 4) {
      const lead = t[0].points - t[1].points;
      add(40, lead > 0 ? `${t[0].id} leads the table by ${plural(lead, "point")} after Week ${done / 2}.` : `${t[0].id} and ${t[1].id} are level on points at the top after Week ${done / 2}.`);
    }
  }
  const seen = new Set<string>();
  return out
    .sort((a, b) => b.w - a.w)
    .filter((h) => !seen.has(h.text) && !!seen.add(h.text))
    .slice(0, 4)
    .map((h) => h.text);
}

export interface Hook {
  /** Higher is a better story. */
  weight: number;
  kind: "grudge" | "nemesis" | "streak" | "title" | "cutline" | "underdog" | "debut" | "stakes" | "plain";
  text: string;
}

/** Every storyline riding on a fixture, best first. The first one is the fixture's one-line hook. */
export function fixtureHooks(s: SeasonState, fx: Fixture): Hook[] {
  const out: Hook[] = [];
  const add = (weight: number, kind: Hook["kind"], text: string) => out.push({ weight, kind, text });
  const table = tableGoingIn(s, fx);
  const row = (id: string) => table.find((r) => r.id === id)!;
  const inFx = fx.bots.slice().sort((a, b) => row(a).rank - row(b).rank);
  const feuds = rivalries(s);
  const leaguePlayed = fx.stage === "league" ? (fx.week - 1) * 2 : LEAGUE_WEEKS * 2;

  // Rivalries: unanswered eliminations first, then the freshest grudge.
  for (let i = 0; i < inFx.length; i++) {
    for (let j = i + 1; j < inFx.length; j++) {
      const r = rivalryOf(feuds, inFx[i], inFx[j]);
      if (!r || !r.last) continue;
      const { killer, victim } = r.last;
      const kk = killsBy(r, killer);
      const vk = killsBy(r, victim);
      if (kk >= 2 && vk === 0) add(92 + kk, "nemesis", `${killer} has knocked ${victim} out ${times(kk)} and never been answered. ${victim} gets another go.`);
      else if (kk > 0 && vk > 0) add(88 + r.heat, "grudge", `${r.a} and ${r.b} have traded ${count(r.aKills + r.bKills)} eliminations. Neither has let it go.`);
      else if (r.last.metSince === 0) add(84, "grudge", `Grudge match: ${victim} gets its first shot at ${killer} since being ${how(r.last.how)} in ${r.last.label}.`);
      else add(76, "grudge", `${victim} still owes ${killer} for ${r.last.label}, and has not collected yet.`);
    }
  }

  if (fx.stage === "final") {
    const direct = table.slice(0, DIRECT_FINALISTS).map((r) => r.id);
    const viaLc = fx.bots.filter((id) => !direct.includes(id));
    add(110, "stakes", `${direct.join(" and ")} earned their places over four weeks; ${viaLc.join(" and ")} came through Last Chance. One match. The winner is champion.`);
    const streaker = inFx.map((id) => ({ id, n: winStreak(s, id) })).sort((a, b) => b.n - a.n)[0];
    if (streaker && streaker.n >= 2) add(86, "streak", `${streaker.id} arrives on ${count(streaker.n)} straight wins.`);
  } else if (fx.stage === "lastchance") {
    add(110, "stakes", `Four bots, two tickets to the Grand Final. ${inFx[0]} finished ${ordinal(row(inFx[0]).rank)}, ${inFx[3]} scraped in ${ordinal(row(inFx[3]).rank)}; none of that counts now.`);
  } else {
    for (const id of inFx) {
      const n = winStreak(s, id);
      if (n >= 2) add(74 + n * 4, "streak", `${id} has won ${count(n)} in a row. Three bots get a shot at ending it.`);
    }
    if (leaguePlayed >= 2) {
      if (row(inFx[0]).rank === 1 && row(inFx[1]).rank === 2) {
        const gap = row(inFx[0]).points - row(inFx[1]).points;
        add(70, "title", gap > 0 ? `First against second: ${inFx[0]} leads ${inFx[1]} by ${plural(gap, "point")}.` : `First against second, level on points: ${inFx[0]} and ${inFx[1]}.`);
      }
      if (fx.week === LEAGUE_WEEKS) {
        // The cut line: 6th place holds the last Last Chance seat, 2nd the last direct ticket.
        const sixth = table[LAST_CHANCE_CUT - 1].points;
        const secondPts = table[DIRECT_FINALISTS - 1].points;
        const chaser = inFx.filter((id) => row(id).rank > LAST_CHANCE_CUT)[0];
        const bubble = inFx.filter((id) => row(id).rank === LAST_CHANCE_CUT || row(id).rank === LAST_CHANCE_CUT - 1)[0];
        const climber = inFx.filter((id) => row(id).rank > DIRECT_FINALISTS && row(id).rank <= 4)[0];
        if (chaser) {
          const gap = sixth - row(chaser).points;
          add(87, "cutline", gap <= 0 ? `Last league week: ${chaser} is level with the last qualifying place and out only on tiebreak.` : `Last league week: ${chaser} is ${plural(gap, "point")} short of the Last Chance places. It needs a result here or the season is over.`);
        }
        if (bubble && chaser) add(80, "cutline", `${bubble} is ${ordinal(row(bubble).rank)} and looking over its shoulder at ${chaser}.`);
        if (climber) {
          const gap = secondPts - row(climber).points;
          add(78, "title", `${climber} is ${gap <= 0 ? "level with" : `${plural(gap, "point")} off`} second place and a straight ticket to the Grand Final.`);
        }
      }
      const last = inFx[inFx.length - 1];
      if (row(last).rank >= 7 && row(last).wins === 0 && row(last).played >= 2) add(58, "underdog", `${last} is ${ordinal(row(last).rank)} and still without a win. Underdogs have won from worse.`);
      for (const id of inFx) {
        const cold = coldStreak(s, id);
        if (cold >= 2 && row(id).rank <= 6) add(52, "underdog", `${id} has finished in the bottom two ${count(cold)} matches running and is sliding.`);
      }
    }
    const mine = inFx.filter((id) => whose(s, id));
    const built = (id: string) => {
      const w = whose(s, id);
      return w === "your " ? `Your build ${id}` : `${w}${id}`;
    };
    if (mine.length && row(mine[0]).played === 0) add(66, "debut", `${built(mine[0])} makes its league debut against ${inFx.filter((id) => id !== mine[0]).join(", ")}.`);
    else if (mine.length) add(45, "plain", `${built(mine[0])} is ${ordinal(row(mine[0]).rank)} on ${plural(row(mine[0]).points, "point")} going in.`);
    // Two users' bots in one match is its own story.
    const camps = new Map<string, string>();
    for (const id of inFx) {
      const o = entrant(s, id)?.owner;
      if (o && !camps.has(o.id)) camps.set(o.id, `${o.name}'s ${id}`);
    }
    if (camps.size >= 2) add(68, "stakes", `Designer against designer: ${[...camps.values()].join(" meets ")}.`);
    if (leaguePlayed < 2) add(30, "plain", `Opening week. Nobody has a point and everybody has a plan.`);
    else add(20, "plain", `${inFx[0]} (${ordinal(row(inFx[0]).rank)}) is the bot to beat here; ${inFx[inFx.length - 1]} (${ordinal(row(inFx[inFx.length - 1]).rank)}) has the most to gain.`);
  }
  const seen = new Set<string>();
  return out.sort((a, b) => b.weight - a.weight).filter((h) => !seen.has(h.text) && !!seen.add(h.text));
}
export const fixtureHook = (s: SeasonState, fx: Fixture): string => fixtureHooks(s, fx)[0]?.text ?? "";

/** Where a table position leaves a bot. */
export function zoneOf(rank: number): "final" | "lastchance" | "out" {
  return rank <= DIRECT_FINALISTS ? "final" : rank <= LAST_CHANCE_CUT ? "lastchance" : "out";
}

/** A one-line description of where the season stands, for the header and the resume prompt. */
export function seasonPhase(s: SeasonState): string {
  if (s.champion) return `Season complete · ${s.champion} is champion`;
  const fx = nextFixture(s);
  if (!fx) return "Season";
  return fx.stage === "league" ? `Week ${fx.week} of ${LEAGUE_WEEKS}` : fx.label;
}

export interface Award {
  title: string;
  id: string;
  detail: string;
}

/** End-of-season honours, from every match including the playoffs. */
export function seasonAwards(s: SeasonState): Award[] {
  const out: Award[] = [];
  const tot = new Map<string, { elims: number; damage: number; outs: number; matches: number }>(s.entrants.map((e) => [e.id, { elims: 0, damage: 0, outs: 0, matches: 0 }]));
  for (const r of s.records)
    for (const p of r.rows) {
      const t = tot.get(p.id)!;
      t.elims += p.elims;
      t.damage += p.damage;
      t.outs += p.eliminated ? 1 : 0;
      t.matches++;
    }
  const best = (score: (t: { elims: number; damage: number; outs: number; matches: number }) => number) => [...tot.entries()].filter(([, t]) => t.matches > 0).sort((a, b) => score(b[1]) - score(a[1]))[0];
  if (s.champion) out.push({ title: "Champion", id: s.champion, detail: "won the Grand Final" });
  const table = standings(s);
  if (table[0]?.played) out.push({ title: "League leader", id: table[0].id, detail: `${plural(table[0].points, "point")} from ${plural(table[0].played, "match")}` });
  const ex = best((t) => t.elims * 1000 + t.damage / 1000);
  if (ex && ex[1].elims > 0) out.push({ title: "Executioner", id: ex[0], detail: `${plural(ex[1].elims, "elimination")}` });
  const hh = best((t) => t.damage);
  if (hh) out.push({ title: "Heavy hitter", id: hh[0], detail: `${Math.round(hh[1].damage)} damage dealt` });
  const sv = best((t) => 1 - t.outs / t.matches + t.matches / 1000);
  if (sv) out.push({ title: "Survivor", id: sv[0], detail: `eliminated ${sv[1].outs === 0 ? "never" : plural(sv[1].outs, "time")} in ${plural(sv[1].matches, "match")}` });
  const feud = rivalries(s)[0];
  if (feud) out.push({ title: "Rivalry of the season", id: feud.a, detail: `${feud.a} ${feud.aKills} : ${feud.bKills} ${feud.b} in eliminations` });
  const upset = s.records.find((r) => r.upset && r.stage === "league");
  if (upset) out.push({ title: "Upset of the season", id: upset.rows[0].id, detail: `won ${upset.label} from ${ordinal(upset.rankBefore[upset.rows[0].id])} in the table` });
  return out;
}

/** Final classification: Grand Final order, then Last Chance losers, then the bots that missed the cut. */
export function finalOrder(s: SeasonState): string[] {
  const out: string[] = [];
  const push = (id: string) => void (out.includes(id) || out.push(id));
  s.records.find((r) => r.stage === "final")?.rows.forEach((p) => push(p.id));
  s.records.find((r) => r.stage === "lastchance")?.rows.forEach((p) => push(p.id));
  standings(s).forEach((r) => push(r.id));
  return out;
}

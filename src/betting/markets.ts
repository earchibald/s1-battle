import { LEAGUE_WEEKS, POINTS, recordFor, standings, type Fixture, type MatchRecord, type SeasonState } from "../season/season";
import { LOSE, WIN, share, type Grade, type MarketKind, type MarketSpec } from "./book";

/**
 * What can be bet on, and how each market is decided.
 *
 * Every market is graded by one pure function of the season state: gradeMarket(spec, season) returns a grade
 * per selection, or null while the result is not yet determined. The same function settles the real market
 * and scores every simulated season the pricer rolls out, so a price and its settlement can never disagree
 * about the rules.
 *
 * PER MATCH (one set per fixture)
 *   match_win    The winner: first in the official classification.
 *   match_top2   Finish first or second. In the Last Chance match this is "to qualify".
 *   match_hcap   Handicap between two bots on match points (5/3/1/0 by place, +1 per elimination, +1 top
 *                damage). The line is added to the first bot's points; a tie after the line is a push.
 *   match_time   Fight length in seconds, over or under a line set at the simulated median. A fight that
 *                lasts exactly the line is a push.
 * PER ROUND (league weeks)
 *   round_top    Most league points scored in the week across both matches. Ties are a dead heat.
 * PER SEASON
 *   season_champion   Wins the Grand Final.
 *   season_finalist   Reaches the Grand Final.
 *   season_league     Tops the league table after the last league week (the table's own tiebreaks apply).
 *   season_hcap       Handicap league: each bot starts with a head start in league points fixed when the
 *                     market opens; most points after the head start wins. Ties are a dead heat.
 */

export const KIND_LABEL: Record<MarketKind, string> = {
  match_win: "Match winner",
  match_top2: "Top two",
  match_hcap: "Points handicap",
  match_time: "Fight length",
  round_top: "Top scorer of the week",
  season_champion: "Champion",
  season_finalist: "To reach the Grand Final",
  season_league: "League winner",
  season_hcap: "Handicap league",
};

/** The most match points one bot can take from a four-bot match. */
export const MAX_MATCH_POINTS = POINTS.place[0] + 3 * POINTS.elimination + POINTS.topDamage;

/** A line in half points as text: 3 -> "+1.5", -3 -> "-1.5", 0 -> "0". */
export const lineText = (line2: number, signed = true) => `${signed && line2 > 0 ? "+" : ""}${line2 / 2}`;

const bots = (ids: string[]) => ids.map((id) => ({ id, label: id }));

export function matchMarkets(seasonId: string, fx: Fixture): MarketSpec[] {
  const base = { scope: "match" as const, round: fx.week, fixtureId: fx.id, params: {} };
  const out: MarketSpec[] = [
    { ...base, id: `${seasonId}/${fx.id}/win`, kind: "match_win", label: `${fx.label} · Winner`, winners: 1, selections: bots(fx.bots) },
    { ...base, id: `${seasonId}/${fx.id}/top2`, kind: "match_top2", label: `${fx.label} · ${fx.stage === "lastchance" ? "To qualify" : "Top two"}`, winners: 2, selections: bots(fx.bots) },
    {
      ...base,
      id: `${seasonId}/${fx.id}/time`,
      kind: "match_time",
      label: `${fx.label} · Fight length`,
      winners: 1,
      params: { line2: 91 },
      selections: [
        { id: "over", label: "Over" },
        { id: "under", label: "Under" },
      ],
    },
  ];
  const sorted = fx.bots.slice().sort();
  for (let i = 0; i < sorted.length; i++)
    for (let j = i + 1; j < sorted.length; j++) {
      const [a, b] = [sorted[i], sorted[j]];
      out.push({ ...base, id: `${seasonId}/${fx.id}/hcap/${a}~${b}`, kind: "match_hcap", label: `${fx.label} · ${a} v ${b} handicap`, winners: 1, params: { a, b, line2: 1 }, selections: bots([a, b]) });
    }
  return out;
}

export function roundMarket(seasonId: string, s: SeasonState, week: number): MarketSpec {
  return { id: `${seasonId}/w${week}/top`, kind: "round_top", scope: "round", round: week, fixtureId: null, label: `Week ${week} · Top scorer`, winners: 1, params: {}, selections: bots(s.entrants.map((e) => e.id)) };
}

export function seasonMarkets(seasonId: string, s: SeasonState): MarketSpec[] {
  const all = bots(s.entrants.map((e) => e.id));
  const base = { scope: "season" as const, round: 0, fixtureId: null, params: {} };
  return [
    { ...base, id: `${seasonId}/season/champion`, kind: "season_champion", label: "Champion", winners: 1, selections: all },
    { ...base, id: `${seasonId}/season/finalist`, kind: "season_finalist", label: "To reach the Grand Final", winners: 4, selections: all },
    { ...base, id: `${seasonId}/season/league`, kind: "season_league", label: "League winner", winners: 1, selections: all },
    { ...base, id: `${seasonId}/season/hcap`, kind: "season_hcap", label: "Handicap league", winners: 1, params: { handicaps: Object.fromEntries(all.map((b) => [b.id, 0])) }, selections: all },
  ];
}

const leagueDone = (s: SeasonState) => s.records.filter((r) => r.stage === "league").length === LEAGUE_WEEKS * 2;
const pointsIn = (rec: MatchRecord, id: string) => rec.rows.find((r) => r.id === id)?.points ?? 0;

/** Grade the best of a set of scores: the single best wins, equal bests share a dead heat. */
function gradeBest(ids: string[], score: (id: string) => number): Record<string, Grade> {
  const best = Math.max(...ids.map(score));
  const tied = ids.filter((id) => score(id) === best).length;
  return Object.fromEntries(ids.map((id) => [id, score(id) === best ? share(tied) : LOSE]));
}

/** Decide a market from the season as it stands. Null while the outcome is still open. */
export function gradeMarket(m: Pick<MarketSpec, "kind" | "fixtureId" | "round" | "params" | "selections">, s: SeasonState): Record<string, Grade> | null {
  const ids = m.selections.map((x) => x.id);
  const each = (win: (id: string) => boolean) => Object.fromEntries(ids.map((id) => [id, win(id) ? WIN : LOSE]));
  switch (m.kind) {
    case "match_win":
    case "match_top2": {
      const rec = m.fixtureId ? recordFor(s, m.fixtureId) : undefined;
      if (!rec) return null;
      const n = m.kind === "match_win" ? 1 : 2;
      const top = rec.rows.slice(0, n).map((r) => r.id);
      return each((id) => top.includes(id));
    }
    case "match_hcap": {
      const rec = m.fixtureId ? recordFor(s, m.fixtureId) : undefined;
      if (!rec) return null;
      const { a, b, line2 } = m.params;
      const d = 2 * (pointsIn(rec, a!) - pointsIn(rec, b!)) + (line2 ?? 0);
      if (d === 0) return { [a!]: "void", [b!]: "void" };
      return { [a!]: d > 0 ? WIN : LOSE, [b!]: d < 0 ? WIN : LOSE };
    }
    case "match_time": {
      const rec = m.fixtureId ? recordFor(s, m.fixtureId) : undefined;
      if (!rec) return null;
      // Durations are recorded to a tenth of a second and the line is in half seconds: compare in twentieths.
      const d = Math.round(rec.duration * 10) * 2 - (m.params.line2 ?? 0) * 10;
      if (d === 0) return { over: "void", under: "void" };
      return { over: d > 0 ? WIN : LOSE, under: d < 0 ? WIN : LOSE };
    }
    case "round_top": {
      const recs = s.records.filter((r) => r.stage === "league" && r.week === m.round);
      if (recs.length < 2) return null;
      return gradeBest(ids, (id) => recs.reduce((n, r) => n + pointsIn(r, id), 0));
    }
    case "season_champion":
      return s.champion ? each((id) => id === s.champion) : null;
    case "season_finalist": {
      const fin = s.fixtures.find((f) => f.stage === "final");
      return fin ? each((id) => fin.bots.includes(id)) : null;
    }
    case "season_league": {
      if (!leagueDone(s)) return null;
      const top = standings(s)[0].id;
      return each((id) => id === top);
    }
    case "season_hcap": {
      if (!leagueDone(s)) return null;
      const pts = new Map(standings(s).map((r) => [r.id, r.points]));
      return gradeBest(ids, (id) => (pts.get(id) ?? 0) + (m.params.handicaps?.[id] ?? 0));
    }
  }
}

/** How a selection reads on a betting slip, with its line or head start where it has one. */
export function selectionText(m: Pick<MarketSpec, "kind" | "params">, selectionId: string): string {
  if (m.kind === "match_hcap") {
    const l = m.params.line2 ?? 0;
    return `${selectionId} ${lineText(selectionId === m.params.a ? l : -l)}`;
  }
  if (m.kind === "match_time") return `${selectionId === "over" ? "Over" : "Under"} ${lineText(m.params.line2 ?? 0, false)}s`;
  if (m.kind === "season_hcap") {
    const h = m.params.handicaps?.[selectionId] ?? 0;
    return h ? `${selectionId} +${h}` : `${selectionId} (scratch)`;
  }
  return selectionId;
}

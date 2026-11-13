import { entrant, type MatchRecord, type SeasonState } from "../season/season";

/**
 * Designer prize money: what a season match pays the users whose bots fought in it. Pure, like the season
 * itself. The credits land in the same wallet the user bets from, so building a good bot funds the betting
 * and a busted bettor can design their way back.
 */

export const PRIZES = {
  /** League match, by finishing place. */
  league: [40, 20, 10, 0],
  /** Per elimination credited to the bot, in any match. */
  elimination: 5,
  /** Last Chance: the two bots that go through. */
  lastChance: [60, 60, 0, 0],
  /** Grand Final, by finishing place. */
  final: [300, 120, 60, 30],
} as const;

export interface Prize {
  ownerId: string;
  bot: string;
  amount: number;
  place: number;
  note: string;
}

const ORD = ["", "1st", "2nd", "3rd", "4th"];

/** The prizes one recorded match pays out. House bots (no owner) earn nothing. */
export function prizesFor(s: SeasonState, rec: MatchRecord): Prize[] {
  const table = rec.stage === "league" ? PRIZES.league : rec.stage === "lastchance" ? PRIZES.lastChance : PRIZES.final;
  const out: Prize[] = [];
  for (const row of rec.rows) {
    const owner = entrant(s, row.id)?.owner;
    if (!owner) continue;
    const amount = (table[row.place - 1] ?? 0) + row.elims * PRIZES.elimination;
    if (amount <= 0) continue;
    const what = rec.stage === "final" && row.place === 1 ? "champion" : rec.stage === "lastchance" && row.place <= 2 ? "through to the Grand Final" : `${ORD[row.place] ?? `${row.place}th`} in ${rec.label}`;
    out.push({ ownerId: owner.id, bot: row.id, amount, place: row.place, note: `${row.id}: ${what}${row.elims ? `, ${row.elims} KO` : ""}` });
  }
  return out;
}

/** The most a single bot can still earn over a full season: for the "what is this worth" line in the UI. */
export const SEASON_TOP_PRIZE = PRIZES.league[0] * 4 + PRIZES.final[0];

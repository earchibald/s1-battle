/**
 * Plays a whole season headlessly (baseline brains) and prints it: schedule, every result with its
 * headlines, the league table, the playoffs, the champion and the awards. Proves the format end to end.
 *
 *   npx tsx scripts/season-sim.ts [seed] [garage.json] [--check]
 *
 * The optional garage export (an array of builds, or { builds }) enters those builds as the player's own.
 * --check also verifies the schedule's guarantees and that the season replays identically from its seed.
 */
import { readFileSync } from "node:fs";
import { stockBuild } from "../shared/bots/index";
import { normalizeBuild, type BotBuild } from "../shared/build";
import { LEAGUE_SIZE, SEASON_MATCHES, candidatePool, createSeason, finalOrder, fixtureHook, isComplete, lastRecord, nextFixture, ordinal, rivalries, seasonAwards, standings, zoneOf, type SeasonState } from "../src/season/season";
import { simulateNext } from "../src/season/runner";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const check = process.argv.includes("--check");
const seed = Number(args[0] ?? 1);

let roster: BotBuild[] = [];
if (args[1]) {
  const raw = JSON.parse(readFileSync(args[1], "utf8")) as unknown;
  const list = Array.isArray(raw) ? raw : (raw as { builds?: unknown[] }).builds ?? [];
  roster = list.map((b, i) => normalizeBuild(b, stockBuild, `slot-${i}`));
}

function play(seed: number, verbose: boolean): SeasonState {
  const pool = candidatePool(roster, []).filter((c) => c.selected);
  let s = createSeason(pool, seed);
  const log = (...a: unknown[]) => verbose && console.log(...a);
  log(`SEASON seed ${seed} · ${LEAGUE_SIZE} bots · ${SEASON_MATCHES} matches`);
  log(`entrants: ${s.entrants.map((e) => `${e.id}${e.mine ? "*" : ""} (${e.build.kind}, ${e.origin})`).join(", ")}\n`);
  let table = false;
  while (!isComplete(s)) {
    const fx = nextFixture(s)!;
    if (fx.stage !== "league" && !table) {
      table = true;
      printTable(s, log);
    }
    log(`${fx.label.toUpperCase()}: ${fx.bots.join(" · ")}`);
    log(`  hook: ${fixtureHook(s, fx)}`);
    s = simulateNext(s);
    const r = lastRecord(s)!;
    log(`  ${r.duration.toFixed(0)}s (${r.reason})  ` + r.rows.map((p) => `${p.place}. ${p.id} +${p.points}${p.eliminated ? ` [${p.eliminated}${p.by ? " by " + p.by : ""}]` : ` [${p.hp}hp]`}`).join("  "));
    for (const h of r.headlines) log(`  > ${h}`);
    log();
  }
  log(`CHAMPION: ${s.champion}`);
  log(`final order: ${finalOrder(s).map((id, i) => `${i + 1}. ${id}`).join("  ")}`);
  log(`awards:`);
  for (const a of seasonAwards(s)) log(`  ${a.title.padEnd(22)} ${a.id.padEnd(12)} ${a.detail}`);
  const feuds = rivalries(s).slice(0, 3);
  if (feuds.length) log(`rivalries: ${feuds.map((f) => `${f.a} ${f.aKills}:${f.bKills} ${f.b} (${f.meetings} meetings)`).join(" · ")}`);
  return s;
}

function printTable(s: SeasonState, log: (...a: unknown[]) => void) {
  log("LEAGUE TABLE");
  for (const r of standings(s)) {
    log(`  ${String(r.rank).padStart(2)}. ${r.id.padEnd(12)} ${String(r.points).padStart(3)} pts  P${r.played} W${r.wins}  elims ${r.elims}  dmg ${String(r.damage).padStart(4)}  form ${r.form.join("")}  ${zoneOf(r.rank) === "final" ? "-> Grand Final" : zoneOf(r.rank) === "lastchance" ? "-> Last Chance" : "out"}`);
  }
  log();
}

const season = play(seed, true);

if (check) {
  const fail = (msg: string) => {
    console.error(`CHECK FAILED: ${msg}`);
    process.exitCode = 1;
  };
  // Replays identically from the seed.
  if (JSON.stringify(play(seed, false)) !== JSON.stringify(season)) fail("the season did not replay identically");
  let seasons = 0;
  const champs: Record<string, number> = {};
  for (let sd = 1; sd <= 30; sd++) {
    const s = play(sd, false);
    seasons++;
    champs[s.champion!] = (champs[s.champion!] ?? 0) + 1;
    if (s.records.length !== SEASON_MATCHES) fail(`seed ${sd}: ${s.records.length} matches, expected ${SEASON_MATCHES}`);
    const league = s.fixtures.filter((f) => f.stage === "league");
    const meets = new Map<string, number>();
    const played = new Map<string, number>();
    for (const f of league) {
      if (new Set(f.bots).size !== 4) fail(`seed ${sd}: ${f.id} does not have four distinct bots`);
      for (const a of f.bots) {
        played.set(a, (played.get(a) ?? 0) + 1);
        for (const b of f.bots) if (a < b) meets.set(`${a}|${b}`, (meets.get(`${a}|${b}`) ?? 0) + 1);
      }
    }
    if ([...played.values()].some((n) => n !== 4) || played.size !== LEAGUE_SIZE) fail(`seed ${sd}: not every bot plays 4 league matches`);
    if (meets.size !== (LEAGUE_SIZE * (LEAGUE_SIZE - 1)) / 2) fail(`seed ${sd}: some pair never meets in the league`);
    if (Math.max(...meets.values()) > 3) fail(`seed ${sd}: a pair meets more than 3 times`);
    const fin = s.fixtures.find((f) => f.stage === "final")!;
    const top2 = standings(s).slice(0, 2).map((r) => r.id);
    if (!top2.every((id) => fin.bots.includes(id))) fail(`seed ${sd}: a top-2 bot is missing from the final`);
    if (!fin.bots.includes(s.champion!)) fail(`seed ${sd}: the champion was not in the final`);
    if (s.records.some((r) => r.headlines.length === 0)) fail(`seed ${sd}: a match has no headline`);
    if (s.fixtures.some((f) => !fixtureHook(s, f))) fail(`seed ${sd}: a fixture has no hook`);
  }
  console.log(`\ncheck: ${seasons} seasons played, champions ${JSON.stringify(champs)}${process.exitCode ? "" : " · all checks passed"}`);
  void ordinal;
}

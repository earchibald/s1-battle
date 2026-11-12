# Changelog

The version shows in the arena's top bar (click it for this list). Bump `version` in package.json for each
release and add a section here; the page shows the newest section.

## 0.3.0 — 2026-11-11

- **Users** (`P` or your name on the control bar). Everyone at the machine is a user with their own wallet of
  play-money credits, their own Garage and their own saved builds, and each user is both a bettor and a bot
  designer. Saved builds are signed by their designer, bots enter a season under their designer's name, and a
  designed bot pays its designer prize money after every season match (40 / 20 / 10 in the league, +5 per
  elimination, 60 through Last Chance, 300 / 120 / 60 / 30 in the Grand Final) into the same wallet they bet
  from. The Users screen shows the wallet's ledger and each designer's record. Your existing Garage and library
  carry over to the first user.

## 0.2.0 — 2026-11-09

- **Event log.** Every bot thought (decision, brain, confidence, danger) and every action, hazard and match beat
  is kept for the session in a log that sits as a tab in the lower right. Open it (click or `L`) to scroll back,
  search (`/`), filter by category or bot, and limit to this match. Decisions no longer flood the ticker.
- **Calmer callouts.** Comic callouts now only mark eliminations, big critical hits (20+) and huge hits (30+),
  with a 4 s breather between them: about 8 per match instead of about 42. Each one is a single short word with a
  plain caption saying who did what to whom.
- **Three new arena traps.** **Flame vents**: five nozzles south of center erupt in a sweep (west to east, then
  back) every 11 s, burning and igniting whatever stands on them. **Launch pad**: a tile north of center that
  charges for 1.6 s, then throws anything on it toward the pit, every 9 s. **Shock plates**: two panels flanking the
  pit approach that take turns discharging every 7 s, stunning and breaking grabs. Every trap is telegraphed, the
  brains see them (Jev, baseline conditions), bots route around live ones, and drags and shoves aim victims at them.
- **Season mode** (`S` or 🏆 Season). Eight bots, four league weeks of two four-bot matches, points for place,
  eliminations and top damage, then a Last Chance match for 3rd–6th and a four-bot Grand Final: ten matches, about
  fifteen minutes. Rivalries, revenge, streaks, upsets and cut-line drama are written from the season's own history
  into fixture hooks and result headlines, ending in a champion screen with awards. It saves after every match;
  exhibition fights stay the default. `npx tsx scripts/season-sim.ts 1 --check` plays whole seasons headlessly.
- **Visible versioning.** Version and build commit in the top bar, with this changelog behind it.

## 0.1.0 — 2026-11-08

- Four Jev-driven combat bots in a 3D arena; pit and kill-saw hazards; synthesized sound; comic callouts and
  earned critical hits.
- The Garage: builds, parts, budget and mass; editable baseline and Jev brains; a logic tuner; a library.
- Seven weapon systems; oriented-box chassis collisions.
- The trained brain: a rollout-labeled outcome network running in the browser, with personality sliders.

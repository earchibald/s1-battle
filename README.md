# S1 Arena — Jev Robot Battles

Four combat robots fight in a 3D arena, picked from seven weapon systems. Each one thinks with **Jev**, TypeSafe's System One model: several
times a second, every bot sends a plain-English description of what it can see to Jev and gets back a typed
decision — who to target, which maneuver to run, and a probability that it is about to be hit. Code turns
that decision into motor and weapon commands at 60 Hz.

Jev answers in ~80–150 ms, so the whole thing runs in realtime. Every bot can be flipped live between three
brains: **Jev**, a scripted **baseline** rule tree, and a **trained** brain: a ~145k-weight network trained on
this machine from the simulator itself, running in the browser in ~0.2 ms per decision. Its personality (aggression,
caution, showboating, hazard play...) is a set of Garage sliders that take effect without retraining. See
[docs/trained-brain.md](docs/trained-brain.md). It improves itself through an SPRT-gated champion/challenger
league with an Elo ladder: [docs/improvement-loop.md](docs/improvement-loop.md).

```
npm install
cp .env.example .env     # put your TYPESAFE_API_KEY in .env
npm run dev              # server on :8787, client on :5173
```

Open http://localhost:5173. Without an API key the arena runs on the trained brain (local, free), or on the
baseline trees if you prefer. To run a second checkout beside a running one: `PORT=8797 npx tsx server/index.ts` and
`API_PORT=8797 npx vite --port 5199`.

## The bots

| Bot | Weapon | Character | Jev's maneuver vocabulary |
| --- | --- | --- | --- |
| **RIPSAW** | vertical spinning saw blade | fast, fragile, continuous contact damage; blade needs spin-up and loses speed on every bite | engage · flank · circle · retreat · spin_up |
| **PILEDRIVER** | overhead pneumatic hammer | slow, armored (35%); windup → strike → recover → long cooldown; huge hit + stun | engage · strike_now · hold · circle · retreat |
| **CLAMP** | hydraulic grabbing arm | control bot; grabs, crushes, and drags victims into the pit or onto the kill saws | engage · grab_now · flank · circle · retreat · drag_to_pit · drag_to_saws · crush · release |
| **LAUNCHER** | pneumatic flipper wedge | quick, long recharge; throws opponents into the air — landings and walls do the damage | engage · flip_now · flank · circle · retreat |
| **CYCLONE** | horizontal bar spinner | wide reach, huge knockback, slow spin-up, every hit stops the bar; the gyro keeps it turning | engage · spin_up · hold · circle · flank · retreat |
| **SCORCH** | flamethrower | a cone of flame that half-ignores armor and keeps burning; limited fuel that refills while not firing | engage · burn · flank · circle · retreat · hold |
| **DOZER** | armored ram plate | no weapon but mass and a boost reserve: slams, wall pins, and shoving bots into hazards | engage · ram_now · shove_to_pit · shove_to_saws · flank · retreat · hold |

The default roster is the first four; the Garage's **Library** tab loads any stock bot (or any saved one) into any
slot, so two saws or four rams is a legal line-up.

Arena hazards: a **pit** that opens on a cycle (first at 30 s, 12 s open / 18 s closed) and two **kill saw**
slots that rise every 10 s. Walls hurt at speed, especially when you arrive airborne.

Three **traps** run on their own clocks, and each one telegraphs before it fires:

- **Flame vents**: a row of five floor nozzles south of center. Every 11 s they erupt one after another, sweeping
  west to east and back on alternate cycles; each ring blinks for a second before its flame stands up for 1.2 s.
  A bot on a lit vent takes fire damage and keeps burning afterwards. The sweep is a moving wall: time the gap,
  or pin somebody in its path.
- **Launch pad**: a pneumatic tile just north of center with chevrons pointing at the pit. Every 9 s it charges
  for 1.6 s and then kicks whatever is standing on it into the air, northward. With the pit open a light bot
  thrown from the far half of the pad lands in the hole; with it closed the landing still hurts.
- **Shock plates**: two electrified panels either side of the pit approach. They take turns (one discharge every
  7 s, west first at 16 s), arcing for 2 s before the pulse. A bot caught on the plate takes a little damage and
  is stunned, which is an open invitation to a hammer (stunned targets are critical), a shove into the pit, or
  a grab.

Bots steer around a trap that is charging and drive off one that lights up under them. They can also use them:
CLAMP's `drag_to_saws` and DOZER's `shove_to_saws` pick a live trap over the saw slots when one is closer to the
victim, the stock rule trees have a `trap` rule for it, flips and spinner hits throw bots onto them, and Jev reads
each trap's state and who is standing on one. Damage a trap does is credited to whoever held or hit the victim in
the last 3 s. The trained brain's inputs predate the traps: it does not see their timers (its features are
unchanged), it only benefits from the controller's avoidance.

**Critical hits** are earned, not rolled (plus a small random chance): a saw bite from *behind*, a hammer on a
bot that is stunned / airborne / held, a flip that sends a bot toward a wall, a crit flip's landing, a wall hit
while airborne, a crush from a rear grab, a spinner hit on a bot *closing* on the bar, flame on a bot's back, and
a ram slam that pins a bot against the wall. Crits do 1.75× damage, chime, flash a comic "CRITICAL!" callout,
and buy a beat of slow motion. This is what makes Jev's `flank` decision worth choosing.

**Sound** is entirely synthesized with Web Audio (`src/audio/sound.ts`): saw whine tracks blade spin, hammer
thuds, pneumatic flips, metallic wall clangs, a pit klaxon, a vent roar, the launch pad's hiss and thump, a
shock plate's buzz and zap, a crowd that swells on big moments, and a slide whistle for anyone who goes down
the pit. Click anywhere once to unlock audio; `M` or the 🔊 button mutes.

**Callouts** (`src/ui/callouts.ts`, rules in `src/ui/calloutPolicy.ts`): a comic-book "K.O.!" / "WHAM!" burst with
a plain caption ("RIPSAW shreds CLAMP · 24"), reserved for eliminations, critical hits of 20+ and hits of 30+, with
a 4 s breather between non-elimination callouts. That is about 8 per match (the old rules fired about 42);
`npx tsx scripts/callout-survey.ts` measures it.

**Event log** (`src/ui/eventlog.ts`): every bot thought (maneuver, target, brain, the brain's own note, runner-up
options, Jev latency) and every action, hazard and match line, kept for the session. It sits as a tab in the
lower right; open it with a click or `L` to scroll back at your own pace, search with `/`, filter by category
(thoughts, actions, hazards, match) or by bot, limit to this match, or copy the filtered log as text. Scrolling
up pauses auto-follow and a "↓ N new" pill brings you back. The on-screen ticker now carries only actions, hazards
and match beats.

**Version.** The top bar shows the version and build commit (a trailing `+` means uncommitted changes); click it for
what's new. Versions come from `package.json`; release notes live in `CHANGELOG.md`.

Match rules: 4-bot free-for-all, 3-minute cap, last bot standing wins; on time-out the judges score health
then damage dealt. Matches typically run 40–90 s.

## The Garage (designer)

Press `G` or click **🛠 Garage** to open the designer. Each of the four roster slots is a **build** you can
change end to end, with a live 3D turntable of the result:

- **Build.** Pick a weapon system (saw / hammer / jaws / flipper / bar spinner / flamethrower / ram plate), set
  ten parts on a 0–5 scale and install techniques. Chassis: armor, drive motors, frame, steering. Weapon: power,
  cycle. Systems: **wedge skirt** (flip and impact resistance), **traction** (knockback resistance), **gyro**
  (shorter stuns; a spinner keeps its turn rate with the bar up) and **sensors** (the brain decides 40 ms sooner
  per level, Jev or baseline, and spots threats farther out). Everything costs points from a **60-point budget**
  on a steep curve (1 / 3 / 6 / 10 / 15 per level), and armor, frame, weapon power and the wedge add **mass**,
  which drags on top speed, acceleration and turn rate. Stock bots sit at 53–60 points, so there is no free
  lunch: a saw with hammer-grade armor is a slow saw. Parts show on the model (plates, tire width, skirt, gyro
  dome, sensor mast). The spec sheet shows every derived number and its delta from stock; illegal builds cannot
  deploy.
- **Baseline brain.** The scripted decision tree, fully editable: a targeting policy plus ordered
  `IF conditions THEN maneuver` rules over a small condition vocabulary (my health, target distance, target
  facing me, nearest threat distance, pit open, saws rising, a trap is live, the target's distance to it, ...).
  With a match running, every condition lights up green or red for that bot and the firing rule glows.
- **Jev brain.** The prompts for the `maneuver`, `target` and `in_danger` questions, the description Jev reads
  for each installed technique, the gate that decides when a technique is offered, and the speculative yes/no
  questions that ride along. A live panel shows exactly what Jev sees right now.
- **Logic tuning.** After a **Quick sim** every baseline rule shows how often it fired (and how much fell through
  to the default). Every numeric threshold (rule conditions, targeting policy) has a **⚙ tune** button that sweeps
  seven values through the headless sim with the current roster, same seeds per bar, and plots this bot's win
  count per value; click a bar to apply it. **A/B vs stock brain** runs the roster twice, with this slot's rules
  as edited and as stock, same body and seeds. All of it runs in the page in a second or two.
- **Library.** **💾 Save build** stores the selected slot under its callsign; the Library tab lists saved builds
  and the seven stock bots, loads any into any slot, saves and loads whole rosters, and imports/exports the
  library as JSON.

Brain edits apply to the fighting bot **live**; body changes need **Deploy** (which starts a new match).
The roster and library persist in `localStorage`; **Export / Import** moves the roster as JSON, and
`npx tsx scripts/headless.ts 24 1 s1-garage.json` runs a longer tournament with it. The build travels with each
`/api/decide` request, so the server stays stateless.

Cost and latency, measured: a match generates ~400–600 Jev decisions (one request each, ~7/s across four
bots), ~90–100 ms average latency, ~450k input tokens ≈ $0.02 per match at Jev 1.14 pricing.

## Season mode

Press `S` or click **🏆 Season** for a season arc: eight bots, ten matches, one champion. Exhibition (the endless
auto-advancing free-for-all with the Garage roster) is still what the arena does on load; a season in progress
shows a **Resume** chip instead of taking over.

- **The league.** Your Garage roster and Library builds enter first (anything you have actually changed from
  stock), the seven stock bots fill the remaining places, and three house wildcards (HACKSAW, MAELSTROM, BULWARK:
  stock bodies, retuned) are there to make up eight. The setup screen lets you swap entrants. Builds are frozen
  when the season starts.
- **Format.** Four league weeks of two four-bot matches: every bot fights every week, and the schedule
  guarantees every pair meets at least once. Then the cut: the top two go straight to the **Grand Final**,
  3rd to 6th fight one **Last Chance** match for the other two places, 7th and 8th are out. The Grand Final is
  one match, winner takes the title.
- **Points.** 5 / 3 / 1 / 0 by finishing place (outlasting a bot always places above it), +1 for each bot you
  eliminate, +1 for the match's top damage dealer. Ties: wins, eliminations, damage.
- **Storylines.** Eliminations build head-to-head rivalries, so fixtures arrive with a hook: a grudge match, a
  bot that has been knocked out twice by the same rival and never answered, a win streak to end, first against
  second, a bot fighting the cut line in the last league week. Results come with headlines (upsets, revenge,
  streaks snapped), and the table shows form, streaks and who has moved.
- **Between matches** the season screen shows the table, the last result, the next fixture with its hook, the
  rivalries and the schedule (click a played match to reread it). **Play next match** runs it in the arena with
  whatever brains you have selected; **Simulate it** runs it instantly on baseline brains. The season ends on a
  champion screen with final placings, honours and the season in ten lines.
- The season saves to `localStorage` after every match. **Exhibition** steps out and keeps it; **Abandon season**
  deletes it; a Garage **Deploy** is an exhibition match, so it steps out too. In season mode `N` restarts the
  fixture in progress (or starts the next one).

All of the scheduling, scoring and storyline logic is pure and seeded (`src/season/season.ts`), so
`npx tsx scripts/season-sim.ts [seed] [garage.json] [--check]` plays a whole season headlessly on baseline brains
and prints every fixture, hook, result and headline; `--check` also verifies the schedule's guarantees over 30
seeds and that a season replays identically from its seed.

## Users: bettors and bot designers

Everyone who plays on the machine is a **user** (`P` or the name on the control bar), and a user does both jobs:

- **One wallet.** Each user has a balance of play-money credits (◈, starting at 1,000) with a ledger of every
  entry. Bets are staked from it and paid back into it, and so is designer prize money. It is the only wallet:
  `accounts.debit()` / `accounts.credit()` in `src/account/accounts.ts` are how anything moves credits.
- **Their own Garage.** The four roster slots belong to the user at the controls; switching user swaps the
  Garage (and the exhibition match) to theirs. **Save build** signs the build with its designer. The Library tab
  shows your builds, and other designers' builds to copy from.
- **Bots enter seasons under their designer.** The season picker offers every user's Garage and saved builds;
  each entrant carries its designer (`Entrant.owner`), shown beside the bot and used in the storylines
  ("Ana's RIPSAW…", "Designer against designer").
- **Prize money.** A designed bot pays its designer after every season match, played or simulated: 40 / 20 / 10
  for 1st / 2nd / 3rd in a league match, +5 per elimination, 60 for getting through Last Chance, and
  300 / 120 / 60 / 30 in the Grand Final (`src/account/prizes.ts`). House bots earn nothing.
- **Designer record.** Bots entered, matches, wins, titles and prize money, kept per user.

Users are local profiles in `localStorage` (up to eight, hot-seat); nothing leaves the machine. The Garage roster
and saved builds from before accounts existed are adopted by the first user. `npx tsx scripts/account-check.ts`
checks the wallet arithmetic, ownership through a season and the prize table headlessly.

## Season betting

Every season has a book on it (the **Betting** panel in the season hub; design and evidence in
[`docs/betting.md`](docs/betting.md)). Bets are play-money credits staked from the user's wallet.

- **Per match:** the winner, a top-two finish (in Last Chance: to qualify), a points **handicap** between any two
  of the four bots, and fight length over or under a line.
- **Per round:** top scorer of the league week across both matches.
- **Per season:** champion, to reach the Grand Final, league winner, and a **handicap league** in which every bot
  gets a head start in league points that levels the field. Season markets reprice after every match.
- **Prices come from the game.** The bookmaker rolls the rest of the season forward on the real match engine and
  grades every market on every simulated season with the same function that will settle it. The offered price is
  the estimate plus a safety loading and a margin, shortened further as money piles onto a selection.
- **The book cannot go wrong quietly.** Whole credits only; every bet is fully collateralised in escrow the moment
  it is struck, so a payout can never fail; an append-only hash-chained ledger; hard liability caps per selection;
  typed rejections that change nothing; idempotent bet requests; settlement that pays each bet exactly once; and
  an audit that rebuilds everything from the ledger and refuses a saved book that does not add up.
- **Nobody can know a result while betting is open.** A match's seed is fixed by a secret the house committed to
  before the bets and by the ledger as it stood when betting closed (`src/betting/fair.ts`).
- **Dead heats, pushes and abandoned seasons** are handled the way a bookmaker would: a tie pays the winning
  fraction of the stake at full odds, a push returns the stake, and abandoning a season refunds every open bet.
- A user with fewer than ◈ 100 at the start of a season is topped up to it, so nobody is locked out for good.

`npm run bet:check` runs the engine's correctness checks (about a minute). `npm run bet:sim` plays whole seasons
against a simulated public of 40 bettors, including a sharp syndicate with a better model than the house, many
accounts hammering one selection, and a fuzzer, and reports the house's result, each kind of bettor's return, the
calibration of the prices, and whether any integrity check failed. The same engine runs as a local house server
with minimal registration (a handle and a bearer token) under `/api/bet` (`server/betting.ts`). There a user can
also enter one Garage build (`PUT /api/bet/bot`): it joins the next server season under its designer's handle and
pays prize money into the wallet they bet from. The server prices in slices so it keeps taking bets, and plays
its seasons on a clock when `BET_MATCH_EVERY` is set. `npm run bet:house` checks it end to end over HTTP.

## How a decision works

1. `src/sim/perception.ts` builds two views of the moment for a bot: a semantic **Perception** (words and
   buckets only — "close", "ahead-left", "hammer raised and ready", "the pit (open) is a few meters away,
   behind-left") and numeric **Facts** for code.
2. The browser POSTs `{ kind, sense }` to `/api/decide`. The server (`server/jev.ts`) builds the question
   set from the bot definition and sends **one** Jev request with everything fanned out together:
   - `target` — Choice over the living opponents
   - `maneuver` — Choice over the maneuvers that are *actually possible right now* (`def.available(sense)`)
   - `in_danger` — Noul: am I about to be hit?
   - kind-specific speculative Nouls (`strike_will_land`, `third_party_threat`, `flip_toward_hazard`)
3. `interpretAnswers` validates the answer against the Facts (dead targets, impossible maneuvers) and hands
   the bot an `Intent`. The HUD shows the full probability distribution and latency.
4. `src/sim/controller.ts` drives the intent every physics tick: steering, hazard avoidance, and the reflex
   of firing a one-shot weapon when a target slides into reach during an aggressive maneuver.

Baseline brains are explicit decision trees over the same information, so Jev vs. scripted is an
apples-to-apples comparison. Both brains are data (`shared/build.ts` `BotLogic`), interpreted by
`shared/logic.ts`; the four stock bots in `shared/bots/*.ts` are builds like any the Garage produces. If a Jev
call fails or times out, the bot falls back to its baseline for that decision and the HUD says so.

The **trained brain** skips the server entirely: `src/brain/trained/` encodes the moment as numbers
(`src/sim/features.ts`), runs the network in plain TypeScript, and weighs its six predicted outcomes per
(technique, target) with the bot's style. It is limited by the same technique gates as Jev and decides at the
same Sensors cadence. It was trained from counterfactual rollouts: the headless sim forks a decision once per
option and plays each one out (`scripts/train/`).

## Layout

```
shared/      types; build.ts (builds, parts, costs, derived stats, condition language, BotLogic);
             logic.ts (rule-tree interpreter, Jev gates/questions); bots/ (the seven stock builds). Browser + server.
server/      Express: /api/decide proxies Jev (key stays server-side), /api/health, /api/stats;
             betting.ts (/api/bet: the house as a local server, handle + token registration, designers' entered
             bots and their prize money, sliced pricing, the match clock, state in data/betting)
src/sim/     deterministic simulation: physics, weapons, hazards and traps, perception, controller, match rules, quicksim
src/brain/   decision scheduler (cadence, event nudges, stale-answer guard, fallback); trained/ (network + style policy)
src/render/  Three.js arena (pit, saws, vents, launch pad, shock plates), procedural bot models (armor plates, wheel size and rig scale follow the build)
src/ui/      HUD cards, ticker/commentary, event log, labels, comic callouts (+ policy), result screen,
             designer.ts (the Garage), library.ts
src/season/  season.ts (pure: schedule, points, table, rivalries, hooks, headlines, awards), runner.ts (World -> result,
             headless fixtures), storage.ts, seasonUi.ts + season.css (setup / hub / champion screens, arena hooks)
src/account/ accounts.ts (users: profiles, the one wallet and its ledger, designer records), garage.ts (per-user rosters),
             prizes.ts (pure: designer prize money per match), accountUi.ts + account.css (the Users screen)
src/betting/ ledger.ts (double-entry, hash-chained), book.ts (markets, bets, limits, settlement, audit), markets.ts
             (what can be bet on and how it is graded), pricing.ts (Monte Carlo prices from the match engine), fair.ts
             (commit-reveal seeds), seasonBook.ts (a season and its markets moving together), punters.ts (simulated
             bettors), desk.ts + deskUi.ts + betting.css (the browser's book on the local season, and its panel)
src/audio/   procedural Web Audio sound engine (no asset files)
scripts/     probe-jev.ts (latency check), headless.ts (tournaments; stock kinds or a garage export), balance.ts (win share sweep)
             season-sim.ts (a whole season, headless), account-check.ts (wallet, ownership, prizes)
             betting-check.ts (engine correctness), betting-sim.ts (whole seasons against simulated bettors),
             house-check.ts (the house server end to end over HTTP)
             dump-corpus.ts, compare-backends.ts, d1/ (the local d1 evaluation: docs/d1-local-eval.md)
             train/ (rollout data generation, PyTorch training, parity/fork checks, brain-vs-brain tournaments)
             league/ (improvement loop: paired matches, SPRT promotion gate, Bradley–Terry ladder, curriculum)
public/models/trained-brain.json   the shipped trained-brain weights (league model g3b, float16, ~390 KB)
```

## Controls

Space pause · N new match · G garage · S season · P users · L event log · / search the log · Esc close it ·
C auto/free camera · F (or ⛶) fullscreen · D debug nav lines · M mute · 1/2/3 speed · J all Jev · T all trained ·
B all baseline. In free camera: drag to orbit, Option/⌘/Shift-drag (Alt/Ctrl/Shift elsewhere) or right-drag to pan
across the floor, scroll to zoom.
Click a bot card's brain badge to cycle that bot Jev → Trained → Baseline.

## Tuning and extending

- `npx tsx scripts/headless.ts 24 1 saw,spinner,torch,ram` runs 24 baseline-vs-baseline matches with those stock
  kinds (or a garage export) and prints lengths, winners, damage and elimination types.
  `npx tsx scripts/balance.ts 36 1` runs seven mixed rosters and prints each weapon system's overall win share
  (25% is even; the stock bots sit at roughly 18–33% depending on the seed). Weapon numbers derive from build
  levels in `shared/build.ts` (`derive`); crit rules live in `src/sim/weapons.ts` (`CRIT_MULT`, `isBehind`),
  hazard and trap geometry and timing in `src/sim/arena.ts` (`ARENA.vents`, `ARENA.pad`, `ARENA.shock`; all pure
  functions of fight time), applied to the bots in `World.traps`.
- Add a technique: add it to `Maneuver` in `shared/types.ts` and to `TECHNIQUES` in `shared/build.ts` (cost,
  weapon restriction), implement it in `controller.ts`, and give the stock builds a description/gate for it.
- Add a weapon system: a `BotKind` in `shared/types.ts`, a `WEAPONS` entry and tuning in `shared/build.ts`, a
  stock build in `shared/bots/`, mechanics in `weapons.ts` (and `bot.ts` for the hitbox and readiness), words in
  `perception.ts`, a rig in `render/botMesh.ts`, an icon in `ui/hud.ts`, and sounds/callouts to taste.
- Add a condition subject: add it to `SUBJECTS` in `shared/build.ts` and to `subjectValue` in `shared/logic.ts`;
  the designer picks it up automatically.
- Add a weapon system: new entry in `WEAPONS`, a stock build in `shared/bots/`, a weapon branch in
  `src/sim/weapons.ts` and a model in `src/render/botMesh.ts`.

- Brain vs brain: `npx tsx scripts/train/tournament.ts --matches 400` (trained vs baseline; `--vs trained --style
  berserker` for personality A/B, `--vs jev` with an API key). Retraining is in docs/trained-brain.md.

Ideas queued: 1v1 brackets, Garage model adapters for the trained brain, a Jev "color commentator"
(Score questions on excitement/momentum), team battles, replay export.

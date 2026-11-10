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

**Critical hits** are earned, not rolled (plus a small random chance): a saw bite from *behind*, a hammer on a
bot that is stunned / airborne / held, a flip that sends a bot toward a wall, a crit flip's landing, a wall hit
while airborne, a crush from a rear grab, a spinner hit on a bot *closing* on the bar, flame on a bot's back, and
a ram slam that pins a bot against the wall. Crits do 1.75× damage, chime, flash a comic "CRITICAL!" callout,
and buy a beat of slow motion. This is what makes Jev's `flank` decision worth choosing.

**Sound** is entirely synthesized with Web Audio (`src/audio/sound.ts`): saw whine tracks blade spin, hammer
thuds, pneumatic flips, metallic wall clangs, a pit klaxon, a crowd that swells on big moments, and a slide
whistle for anyone who goes down the pit. Click anywhere once to unlock audio; `M` or the 🔊 button mutes.

**Callouts** (`src/ui/callouts.ts`): comic-book "WHAM!" / "SHRED!" / "K.O.!" bursts anchored to the hit for
the hits worth shouting about.

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
  facing me, nearest threat distance, pit open, saws rising, ...). With a match running, every condition lights
  up green or red for that bot and the firing rule glows.
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
server/      Express: /api/decide proxies Jev (key stays server-side), /api/health, /api/stats
src/sim/     deterministic simulation: physics, weapons, hazards, perception, controller, match rules, quicksim
src/brain/   decision scheduler (cadence, event nudges, stale-answer guard, fallback); trained/ (network + style policy)
src/render/  Three.js arena, procedural bot models (armor plates, wheel size and rig scale follow the build)
src/ui/      HUD cards, ticker/commentary, labels, comic callouts, result screen, designer.ts (the Garage), library.ts
src/audio/   procedural Web Audio sound engine (no asset files)
scripts/     probe-jev.ts (latency check), headless.ts (tournaments; stock kinds or a garage export), balance.ts (win share sweep)
             train/ (rollout data generation, PyTorch training, parity/fork checks, brain-vs-brain tournaments)
             league/ (improvement loop: paired matches, SPRT promotion gate, Bradley–Terry ladder, curriculum)
public/models/trained-brain.json   the shipped trained-brain weights (league model g3b, float16, ~390 KB)
```

## Controls

Space pause · N new match · G garage · C auto/free camera · D debug nav lines · M mute · 1/2/3 speed ·
J all Jev · T all trained · B all baseline. Click a bot card's brain badge to cycle that bot Jev → Trained → Baseline.

## Tuning and extending

- `npx tsx scripts/headless.ts 24 1 saw,spinner,torch,ram` runs 24 baseline-vs-baseline matches with those stock
  kinds (or a garage export) and prints lengths, winners, damage and elimination types.
  `npx tsx scripts/balance.ts 36 1` runs seven mixed rosters and prints each weapon system's overall win share
  (25% is even; the stock bots sit at roughly 18–33% depending on the seed). Weapon numbers derive from build
  levels in `shared/build.ts` (`derive`); crit rules live in `src/sim/weapons.ts` (`CRIT_MULT`, `isBehind`),
  hazard timing in `src/sim/arena.ts`.
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

# S1 Arena — Jev Robot Battles

Four combat robots fight in a 3D arena. Each one thinks with **Jev**, TypeSafe's System One model: several
times a second, every bot sends a plain-English description of what it can see to Jev and gets back a typed
decision — who to target, which maneuver to run, and a probability that it is about to be hit. Code turns
that decision into motor and weapon commands at 60 Hz.

Jev answers in ~80–150 ms, so the whole thing runs in realtime. Every bot can be flipped between its **Jev
brain** and a scripted **baseline brain** live, so you can watch the difference.

```
npm install
cp .env.example .env     # put your TYPESAFE_API_KEY in .env
npm run dev              # server on :8787, client on :5173
```

Open http://localhost:5173. Without an API key the arena still runs on baseline brains.

## The bots

| Bot | Weapon | Character | Jev's maneuver vocabulary |
| --- | --- | --- | --- |
| **RIPSAW** | vertical spinning saw blade | fast, fragile, continuous contact damage; blade needs spin-up and loses speed on every bite | engage · flank · circle · retreat · spin_up |
| **PILEDRIVER** | overhead pneumatic hammer | slow, armored (35%); windup → strike → recover → long cooldown; huge hit + stun | engage · strike_now · hold · circle · retreat |
| **CLAMP** | hydraulic grabbing arm | control bot; grabs, crushes, and drags victims into the pit or onto the kill saws | engage · grab_now · flank · circle · retreat · drag_to_pit · drag_to_saws · crush · release |
| **LAUNCHER** | pneumatic flipper wedge | quick, long recharge; throws opponents into the air — landings and walls do the damage | engage · flip_now · flank · circle · retreat |

Arena hazards: a **pit** that opens on a cycle (first at 30 s, 12 s open / 18 s closed) and two **kill saw**
slots that rise every 10 s. Walls hurt at speed, especially when you arrive airborne.

**Critical hits** are earned, not rolled (plus a small random chance): a saw bite from *behind*, a hammer on a
bot that is stunned / airborne / held, a flip that sends a bot toward a wall, a crit flip's landing, a wall hit
while airborne, and a crush from a rear grab. Crits do 1.75× damage, chime, flash a comic "CRITICAL!" callout,
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

- **Build.** Pick a weapon system (saw / hammer / jaws / flipper), set six parts on a 0–5 scale (armor, drive
  motors, frame, steering, weapon power, weapon cycle) and install techniques. Everything costs points from a
  **50-point budget** on a steep curve (1 / 3 / 6 / 10 / 15 per level), and armor, frame and weapon power add
  **mass**, which drags on top speed, acceleration and turn rate. Stock bots sit at 47–50 points, so there is
  no free lunch: a saw with hammer-grade armor is a slow saw. The spec sheet shows every derived number and its
  delta from stock; illegal builds cannot deploy.
- **Baseline brain.** The scripted decision tree, fully editable: a targeting policy plus ordered
  `IF conditions THEN maneuver` rules over a small condition vocabulary (my health, target distance, target
  facing me, nearest threat distance, pit open, saws rising, ...). With a match running, every condition lights
  up green or red for that bot and the firing rule glows.
- **Jev brain.** The prompts for the `maneuver`, `target` and `in_danger` questions, the description Jev reads
  for each installed technique, the gate that decides when a technique is offered, and the speculative yes/no
  questions that ride along. A live panel shows exactly what Jev sees right now.

Brain edits apply to the fighting bot **live**; body changes need **Deploy** (which starts a new match).
**Simulate** runs 12 headless baseline-vs-baseline matches with the roster and shows win counts. The roster
persists in `localStorage`; **Export / Import** moves it as JSON, and `npx tsx scripts/headless.ts 24 1
s1-garage.json` runs a longer tournament with it. The build travels with each `/api/decide` request, so the
server stays stateless.

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

## Layout

```
shared/      types; build.ts (builds, parts, costs, derived stats, condition language, BotLogic);
             logic.ts (rule-tree interpreter, Jev gates/questions); bots/ (the four stock builds). Browser + server.
server/      Express: /api/decide proxies Jev (key stays server-side), /api/health, /api/stats
src/sim/     deterministic simulation: physics, weapons, hazards, perception, controller, match rules, quicksim
src/brain/   decision scheduler (cadence, event nudges, stale-answer guard, fallback)
src/render/  Three.js arena, procedural bot models (armor plates, wheel size and rig scale follow the build)
src/ui/      HUD cards, ticker/commentary, labels, comic callouts, result screen, designer.ts (the Garage)
src/audio/   procedural Web Audio sound engine (no asset files)
scripts/     probe-jev.ts (latency check), headless.ts (balance tuning / tournaments, accepts a garage export)
```

## Controls

Space pause · N new match · G garage · C auto/free camera · D debug nav lines · M mute · 1/2/3 speed ·
J all Jev · B all baseline. Click a bot card's brain badge to switch just that bot.

## Tuning and extending

- `npx tsx scripts/headless.ts 24` runs 24 baseline-vs-baseline matches and prints lengths, winners, and
  elimination types. Weapon numbers derive from build levels in `shared/build.ts` (`derive`); crit rules live
  in `src/sim/weapons.ts` (`CRIT_MULT`, `isBehind`), hazard timing in `src/sim/arena.ts`.
- Add a technique: add it to `Maneuver` in `shared/types.ts` and to `TECHNIQUES` in `shared/build.ts` (cost,
  weapon restriction), implement it in `controller.ts`, and give the stock builds a description/gate for it.
- Add a condition subject: add it to `SUBJECTS` in `shared/build.ts` and to `subjectValue` in `shared/logic.ts`;
  the designer picks it up automatically.
- Add a weapon system: new entry in `WEAPONS`, a stock build in `shared/bots/`, a weapon branch in
  `src/sim/weapons.ts` and a model in `src/render/botMesh.ts`.

Ideas queued: Jev vs. baseline tournament mode with win-rate tracking, 1v1 brackets, a Jev "color commentator"
(Score questions on excitement/momentum), team battles, replay export.

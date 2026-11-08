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

Baseline brains (`shared/bots/*.ts → baseline()`) are explicit decision trees over the same information,
so Jev vs. scripted is an apples-to-apples comparison. If a Jev call fails or times out, the bot falls back
to its baseline for that decision and the HUD says so.

## Layout

```
shared/      types + bot definitions (stats, Jev maneuver vocabulary, baseline brains). Browser + server.
server/      Express: /api/decide proxies Jev (key stays server-side), /api/health, /api/stats
src/sim/     deterministic simulation: physics, weapons, hazards, perception, controller, match rules
src/brain/   decision scheduler (cadence, event nudges, stale-answer guard, fallback)
src/render/  Three.js arena, procedural bot models with animated weapon rigs, sparks/smoke/rings, camera
src/ui/      HUD cards, ticker/commentary, world-anchored labels, comic callouts, result screen
src/audio/   procedural Web Audio sound engine (no asset files)
scripts/     probe-jev.ts (latency check), headless.ts (balance tuning: runs matches with no renderer)
```

## Controls

Space pause · N new match · C auto/free camera · D debug nav lines · M mute · 1/2/3 speed · J all Jev · B all baseline.
Click a bot card's brain badge to switch just that bot.

## Tuning and extending

- `npx tsx scripts/headless.ts 24` runs 24 baseline-vs-baseline matches and prints lengths, winners, and
  elimination types. Weapon numbers and crit rules live in `src/sim/weapons.ts` (`TUNING`, `CRIT_MULT`, `isBehind`), hazard timing in `src/sim/arena.ts`.
- Add a maneuver: add it to `Maneuver` in `shared/types.ts`, describe it in the bot's `maneuvers`, gate it in
  `available()`, and implement it in `controller.ts`.
- Add a bot: new file in `shared/bots/`, register in `BOT_DEFS`, add a weapon branch in `src/sim/weapons.ts`
  and a model in `src/render/botMesh.ts`.
- Add a Jev question: return it from the bot's `extraQuestions()`; it rides along in the same request for free
  and shows up in the ticker note.

Ideas queued: Jev vs. baseline tournament mode with win-rate tracking, 1v1 brackets, a Jev "color commentator"
(Score questions on excitement/momentum), team battles, replay export.

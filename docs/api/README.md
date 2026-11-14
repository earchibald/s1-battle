# S1 Arena API

One API for everything a player, a script or a model can do in S1 Arena: read the season, bet on it, design a
bot and enter it, and drive a robot directly in a match.

<!-- repo-only -->
| File | What it is |
| --- | --- |
| [`openapi.yaml`](openapi.yaml) | The HTTP API, OpenAPI 3.1. 46 operations. |
| [`asyncapi.yaml`](asyncapi.yaml) | The WebSocket API, AsyncAPI 3.0. Three sockets (seat control, spectating, the live feed), 33 message types. |
| [`index.html`](index.html) | Both of the above and this guide as one browsable page. Built by `npm run api:docs`. |

`npm run api:lint` checks both specs with the standard linters. With the server running, the page is served at
`http://localhost:8787/api/docs/`. The specs load unchanged into Swagger UI, Redoc, Postman and code generators.
<!-- /repo-only -->

## Status

This is a specification. Part of it describes what the house server already does and part is proposed. Every
operation is marked:

| Mark | Meaning | Count |
| --- | --- | --- |
| `live` | Served today, at the older path shown beside it (`/api/bet/...`) | 11 |
| `partial` | The data is served today in a different shape or without filters | 6 |
| `proposed` | Specified here, not built | 29 |

Live today: health, registration, the caller's profile, reading, entering and withdrawing a bot, placing a bet,
the leaderboard, the audit, the fairness records and advancing the season. The season view, the table, entrants,
fixtures, markets and the bet list are partial. Everything under Matches, all three sockets, API keys and the
rules catalog are proposed. Nothing in `server/` changed to produce this document
except a static route that serves it.

The v1 paths are new names for the live routes. Until v1 is built, use the path in each operation's
"Today" line.

## The four surfaces

| Surface | Read | Drive |
| --- | --- | --- |
| **Seasons** | Table, fixtures, results, entrants and builds, seed commitments | Enter a bot; advance the season or set its clock (admin); simulate a whole season statelessly |
| **Betting** | Markets, live prices, your bets and wallet, the leaderboard, the audit | Place a bet |
| **Design** | The rules catalog, stock builds, derived stats for any build | Check a build, enter it, replace it, withdraw it |
| **Matches** | World state, senses, events, replays, timing reports | Create a match, send intents or motor commands, step it, fork it |

## Quick start

Against a local server (`npm run dev`), using the routes that exist today:

```bash
# 1. Register. The token is shown once.
curl -s localhost:8787/api/bet/register -H 'content-type: application/json' \
  -d '{"handle":"pit-boss"}'
# {"ok":true,"userId":"u-3fa91c07b2d4","handle":"pit-boss","token":"9b1c…","balance":1000}

# 2. Read the season: table, the open round, markets and prices.
curl -s localhost:8787/api/bet/season -H "authorization: Bearer $TOKEN"

# 3. Bet 25 credits on RIPSAW to win Week 1 Match A, refusing anything shorter than 3.10.
curl -s localhost:8787/api/bet/bets -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"key":"my-first-bet","marketId":"s1/w1a/win","selectionId":"RIPSAW","stake":25,"minPrice":310}'

# 4. Enter a bot for the next season. Anything left out comes from the stock saw.
curl -s -X PUT localhost:8787/api/bet/bot -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"build":{"name":"TIN OPENER","kind":"saw","levels":{"motor":4,"steering":3}}}'

# 5. Play the next match (local development only).
curl -s -X POST 'localhost:8787/api/bet/advance?wait=1'
```

## Conventions

- **Envelope.** Every JSON response has `ok`. Success is `{ "ok": true, ... }`. Failure is
  `{ "ok": false, "code": "...", "error": "..." }` with a 4xx or 5xx status. Bet rejections use `message`
  instead of `error` and add `price` or `maxStake` where that helps; this matches what the book returns today.
- **Money** is whole play-money credits. Nothing is ever fractional.
- **Prices** are decimal odds in hundredths: `235` is 2.35 and a winning bet returns
  `floor(stake × 235 / 100)` in total. Every division rounds toward the house. `0` means not offered.
- **Lines** are kept integral: `line2: 3` is +1.5 points, `line2: 91` is 45.5 seconds.
- **Time.** Wall-clock values are milliseconds since the Unix epoch. Match time is in **ticks**: 60 per
  simulated second. The countdown is ticks 0 to 179 and the bell is tick 180.
- **Ids.** Users `u-3fa91c07b2d4`, seasons `s12`, fixtures `w1a` … `w4b`, `lastchance`, `final`, matches
  `m-9c41d07be2a1` or `s12.w1a` for a season fixture, bets `house:b412`. A bot's id is its callsign. Market ids
  contain slashes (`s12/w1a/win`) and are passed in queries and bodies, never in paths.
- **Pagination.** `?limit=&cursor=` in, `{ items, nextCursor }` out. `nextCursor` is null on the last page.
- **Idempotency.** Bets carry a caller-chosen `key`. Repeating it returns the original bet and moves no money.
- **Geometry.** Metres. The arena is a 20 m square centred on the origin, +x east, +y north. Headings are
  radians, 0 facing east, positive anticlockwise. Positive `steer` turns left.

## Authentication

Send `Authorization: Bearer <credential>`. Public reads (season, markets, leaderboard, audit, rules, replays of
finished matches) need no credential.

| Credential | How you get it | What it can do |
| --- | --- | --- |
| Registration token, 64 hex | `POST /users` with a handle. Live today. | Every scope except `admin` |
| API key, `s1_` + 64 hex | `POST /me/keys`, with the scopes you choose. Proposed. | Only its scopes |
| Browser session | After OAuth sign-in. Provisional, see below. | Every scope except `admin` |
| Socket ticket | `POST /ws-tickets`. Single use, 30 s. Proposed. | Opens one WebSocket |

Scopes on API keys: `account` (read your profile, wallet and bets), `bets` (place bets), `bots` (enter or
withdraw your bot), `drive` (create matches and control seats). `admin` cannot be minted; today it is the
`X-Admin-Token` header checked against `BET_ADMIN_TOKEN`.

Give each program the narrowest key that works. A match harness with a `drive` key cannot touch the wallet, and
a betting bot with a `bets` key cannot enter or change a bot.

**OAuth is provisional.** A parallel piece of work recommends Discord-first OAuth (authorization-code flow with
a server-side exchange, the same app serving a Discord Activity and web sign-in), an identities table mapping
`(provider, provider user id)` to the existing `u-…` user id, and identity stored in SQLite while balances stay
in the hash-chained ledger. None of that is approved or built. This spec depends on only two things from it,
both already agreed between the two efforts: the user id format does not change, and bearer credentials for
scripts stay. Handle registration is kept for development and programmatic use and is expected to be retired
for human sign-up once OAuth lands.

## Seasons

A season is ten matches: a league of eight bots over four weeks (two four-bot matches a week, every bot fights
every week), a Last Chance match for 3rd to 6th, and a Grand Final. League points are 5/3/1/0 by place, +1 per
elimination, +1 for top damage. The top two go straight to the final.

The house runs one season at a time, either on a clock (`BET_MATCH_EVERY` seconds, later `PUT
/admin/season/clock`) or one match per `POST /admin/season/advance`. Each step locks betting on the next
fixture, reveals its seed, plays it, settles its markets and pays designer prizes, atomically.

Pricing a new round simulates a few thousand matches (10 to 20 s of one core). `pricing.progress` in the season
view, and `season.pricing` on the feed, show it; a round's markets open when its prices are ready.

**Seeds are provably not chosen by the house.** When a fixture's markets open the house publishes
`commit = sha256("s1-commit|season|fixture|secret")`. When betting closes it takes the ledger's head hash as
`anchor`, reveals `secret`, and the seed is the first 32 bits of `sha256("s1-seed|secret|anchor")`. Bettors
cannot compute the seed early (no secret); the house cannot steer it (it committed before the bets that fix the
anchor). With the seed and the entrants' builds, `GET /matches/{matchId}/replay` lets anyone re-run the match.

`POST /seasons/simulate` runs a whole season for any eight builds in about 100 ms, statelessly. It is the same
code the house prices with, which makes it the honest tool for building your own betting model.

## Betting

Fixed odds against the house, singles only, no cash-out, play money.

| Scope | Markets |
| --- | --- |
| Per match | `match_win`, `match_top2`, `match_hcap` (per pair, on match points), `match_time` (fight length over/under) |
| Per league week | `round_top` (most league points that week) |
| Per season | `season_champion`, `season_finalist`, `season_league`, `season_hcap` |

A bet is accepted only if it can be fully collateralised on the spot: your stake and the house's maximum loss
both move into that market's escrow and stay there until the market settles or is voided. A payout can
therefore never fail. Limits today: 1 to 100 credits per bet; 200 per user per match or round market and 300
per season market; the house's liability per selection is capped at 3,000 (6,000 for season markets). Prices
shorten as a selection's exposure grows, so always send `minPrice`.

Rejections are typed (`price_changed`, `liability_limit`, `user_limit`, `market_closed` …) and never change
anything. See `BetRejection` in the reference for all fourteen.

`GET /audit` re-verifies the whole book on request: the ledger's hash chain, that every bet's stake, price and
collateral agree, that every settled bet was paid exactly what its grade owes, and that every revealed seed
follows from its commitment.

## Design

A bot is plain data, a `BotBuild`:

- a **weapon system** (`kind`): saw, hammer, grabber, flipper, spinner, torch or ram;
- ten **parts** at levels 0 to 5 (armor, motor, frame, steering, power, cycle, wedge, traction, gyro, sensors);
- installed **techniques** (maneuvers such as `flank` or `drag_to_pit`);
- **logic**: a rule tree in a small condition language, a style for the trained network, and prompts for Jev.

The budget is 60 points. Levels cost 0/1/3/6/10/15; techniques cost 0 to 3. Mass costs speed, acceleration and
turn rate, so armor and weapon power are paid for twice.

`GET /rules` returns the whole catalog. `POST /builds/check` normalises a build and returns its cost, derived
stats and problems without storing anything. `PUT /me/bot` enters it. Only `name` and `kind` are required;
everything else falls back to the stock build of that kind.

The rule tree is the first way to bring your own deterministic code: it runs server-side, in season matches,
and it is what the house prices. The other ways are below.

## Driving a robot

### Who can control a seat

A match has two to four seats. Each seat has a bot and a controller:

| Controller | What moves the bot | Use it for |
| --- | --- | --- |
| `builtin` `rules` | The build's rule tree | Deterministic opponents; what season matches run on |
| `builtin` `trained` | The trained network with the build's style sliders | Stronger deterministic opponents |
| `builtin` `jev` | Jev, over the network | The original S1 Arena brain. Realtime only, not deterministic |
| `remote` | Your code, your model or your hands | Everything in this section |
| `replay` | The recorded inputs of a seat in an earlier match | Re-running a human's inputs under other conditions |
| `idle` | Nothing | A sparring dummy |

A `builtin` seat takes `outputDelayMs`, which delays that brain's motor outputs. It is the difficulty dial for
bots that face a human.

### Control levels

A remote seat declares a level. The level decides which inputs are accepted and what happens when you say
nothing.

| Level | You send | The server does | With no fresh input |
| --- | --- | --- | --- |
| `intent` | A maneuver and a target, a few times a second | Steering, throttle, hazard avoidance and weapon timing at 60 Hz | The last intent stays in force |
| `direct` | `throttle`, `steer`, `trigger`, `release` | Physics only | Hold the last values for `holdTicks`, then neutral |
| `hybrid` | Both, in any mix | Drives from your intent; any channel you send overrides it | The overridden channel returns to the server's controller |

Every channel of a control frame is optional, and that is what makes mixtures possible:

- A language model sends intents and never touches the motors.
- A script sends `throttle` and `steer` every tick and leaves `trigger` to the server's reflexes.
- A person steers by hand while a model on the same seat chooses targets.
- A reinforcement-learning policy sends all four channels and nothing else decides anything.

The **fallback** brain (default `rules`) covers the gaps: it decides when an intent is illegal or missing, and
it takes over a silent `direct` seat after `takeoverMs`. Whoever is actually moving the bot each tick is
reported as `you.driver`: `controller`, `hold` or `fallback`.

Intents take effect only at the bot's **decision points**: every 250 to 450 ms of fight time depending on its
sensors level, and within about 80 ms of an urgent event (a big hit, a grab, a flip, the pit opening). That
keeps the sensors part meaningful for remote commanders exactly as it is for built-in brains.

### What you observe

The simulation hides nothing. Every seat and every spectator sees the same world.

| Observation | Contents | Rate |
| --- | --- | --- |
| `state` | Every bot's position, heading, velocity, health, stun, weapon charge; every hazard's phase; your seat's control status | 10, 20, 30 or 60 per second (realtime); once per step (lockstep) |
| `sense` | One bot's decision-level view: `perception` in words for language models, `facts` in numbers for code, and the `available` maneuvers | Before each decision point |
| `events` | Hits, grabs, flips, eliminations, hazard warnings, seat status changes | As they happen |

Hazards are pure functions of fight time, so a controller that reads `arena` from `/rules` can predict every
pit opening and trap exactly.

### Two clocks

The simulation is a fixed 60 ticks per second and is deterministic: the same seed and the same inputs at the
same ticks give the same match, bit for bit, on the same engine version. One tick costs about 3 microseconds
for four bots, and a whole headless match is about 10 ms of computation. The clock mode decides how those ticks relate
to real time.

**`realtime`** steps on the wall clock. Inputs take effect when they arrive. This is the mode for people, and
for measuring what a real network does.

**`lockstep`** steps only when every remote seat has submitted. There is no wall clock. A model that needs four
seconds to think plays the same match as one that needs four milliseconds, and a test can run a three-minute
fight in the time it takes to exchange the messages. Use `POST /matches/{id}/step` (one call per step, like a
reinforcement-learning environment) or `commit` on the seat socket.

```
realtime, direct seat, holdTicks 15

tick      1300   1301   1302   1303   1304  ...  1318   1319   1320
input      A ─────┐                    B ──┐
applied           A      A      A      A   B  ...  B      B      ∅
driver           ctl    hold   hold   hold ctl ... hold   hold  neutral
                  └ took effect at 1301            └ B lapses 15 ticks after it arrived
```

### Timing semantics

These rules are the same in both clocks.

1. **Arrival.** An input takes effect on the first tick simulated after it reaches the simulation. With
   `forTick` it takes effect at that tick instead, if that is no more than `maxLeadTicks` (default 6) ahead. A
   `forTick` already past is applied at once and counted **late**.
2. **Ordering.** Inputs carry a client `seq`. An input with a `seq` at or below the last one applied is dropped.
3. **Hold.** A channel with no fresh input keeps its last value for `holdTicks` (default 15, a quarter of a
   second), then lapses.
4. **Takeover.** After `takeoverMs` (default 2000) with no input at all, the fallback brain drives until input
   resumes. `seat_fallback` and `seat_resumed` events mark the edges.
5. **Acknowledgement.** Every `state` sent to a seat carries `you.lastSeq` and `you.appliedTick`. Stamp inputs
   with `basedOnTick` (the tick of the observation you acted on) and the server can report the full loop: world
   to your eyes, to your hands, and back into the world.
6. **Rate.** At most 120 input messages per second per seat.

A client that stamps every frame `forTick = latest tick seen + N` gets a constant N-tick delay and stops
feeling jitter smaller than N ticks. That trade is the standard way to make a jittery link feel steady.

### Simulating a network

Each seat may carry a `net` block. The server applies it between the controller and the simulation:

| Field | Effect |
| --- | --- |
| `uplinkMs` | Delay on the seat's inputs before the simulation sees them |
| `downlinkMs` | Delay on observations before the seat gets them. Add a human's reaction time here |
| `jitterMs` | Uniform ± jitter per message, each way |
| `lossPct` | Share of messages dropped, each way. A lost input means hold-last |
| `seed` | Seeds the jitter and loss draws, so a conditioned match is reproducible |

In `realtime` the conditioning adds to whatever the real link does. In `lockstep` it is the only latency there
is, converted to whole ticks, which makes network experiments exact and repeatable: run the same controller,
the same seed and the same opponents at 0, 50, 100, 150 and 200 ms and the only thing that changed is the lag.

`GET /matches/{id}/timing` reports, per seat: inputs applied, late, dropped and rejected; ticks spent on hold
and on the fallback brain; and distributions of round-trip time, input delay and staleness.

### What lag costs

Measured on this simulator on 13 November 2026 by delaying one rule-tree bot's motor outputs while the other
three ran undelayed (stock bots; 240 four-bot matches or 360 duels per point). For scale, an even share is 25%
in a four-bot fight and 50% in a duel.

| Output delay | Four-bot win share | Four-bot, instant trigger | Duel win share | Duel, instant trigger |
| --- | --- | --- | --- | --- |
| 0 ms | 23% | | steady | |
| 100 ms | 22% | | steady | |
| 150 ms | 14% | | steady | |
| 200 ms | 7.5% | 16.7% | steady | |
| 250 ms | | | 24% | |
| 300 ms | | | 17% | 25.8% |
| 400 ms | 4% | | | |

Blank cells were not measured. "Steady" means the study recorded no drop up to about 200 ms in duels; the
undelayed duel figure itself was not kept. Two things follow. Total loop delay under about 100 ms costs almost nothing in a
four-bot fight, and a human's reaction time alone is 200 ms or more, so piloted seats need `assists.autoFire`
(the "instant trigger" columns) or opponents handicapped with `outputDelayMs` to be competitive. These numbers
are for a rule-tree bot being delayed, not for a human; they are the baseline the API's timing tools are meant
to refine.

### Replays and forks

Every finished match has a replay: seed, builds, each seat's controller, and every input with the tick it took
effect. Re-simulating it on the same `engineVersion` must reproduce `resultHash`. Determinism is verified
within one engine build; it is **not** verified across JavaScript engines or CPU architectures, which is why
the server is the only authority on a result and clients never are.

`POST /matches/{id}/fork` (sandbox, lockstep) copies a match at its current tick. Sibling forks share their
random numbers, so two lines of play can be compared with little noise. It is the primitive for search-based
controllers.

### Integrity: driven matches are not bettable

The house prices a season by simulating it on built-in brains from the entrants' builds. That is only honest if
those brains are what actually fights. A remote controller could be far stronger than the simulation assumed,
or could lose on purpose with a bet on the other side. So:

- Season fixtures are run entirely by built-in brains. `bettable` is true only for them.
- Matches you create (`sandbox`, `exhibition`) are never priced and never have markets.
- You may bet on your own bot in a season. Prices are simulated from the build you actually entered, so
  sandbagging a design gains nothing.

## Recipes

**Deterministic rules, no client at all.** Write a rule tree, `POST /builds/check` until it is legal, `PUT
/me/bot`. It plays in the next season and earns prize money.

**A language model as commander.** Create a lockstep match with a `remote` `intent` seat. Loop:
`POST /step` with `observe: ["sense"]`, give the model `perception` and `available`, send its answer as the
next step's `intent`. Each step is one decision; the model's latency does not matter.

```python
m = post("/matches", {"clock": {"mode": "lockstep", "stepTicks": 18}, "seats": [
    {"bot": {"stock": "grabber"}, "controller": {"type": "remote", "level": "intent"}},
    {"bot": {"stock": "spinner"}, "controller": {"type": "builtin", "brain": "rules"}}]})["match"]
out = post(f"/matches/{m['id']}/step", {"observe": ["sense"]})
while not out["done"]:
    sense = out["senses"]["0"]
    choice = model.decide(sense["perception"], sense["available"])   # your model
    out = post(f"/matches/{m['id']}/step",
               {"inputs": {"0": {"intent": choice}}, "observe": ["sense"]})
print(out["result"]["winner"])
```

**A model choosing targets, code driving.** A `hybrid` seat. The model sends `intent` when it has an opinion;
a local 60 Hz loop reads `state` and sends `throttle` and `steer`; `trigger` is left to the server.

**A human pilot.** An `exhibition` in `realtime` with a `direct` seat and `assists.autoFire`. The client sends
a control frame on every input change and at least every 200 ms, and renders from `state` at 30 or 60 Hz.

**A latency study.** One `sandbox` lockstep match per condition, same `seed`, same opponents, the `net` block
swept. Compare results and `GET /timing`. To replay a real person's session under worse conditions, use a
`replay` controller pointing at their recorded seat.

**A betting model.** Read `/seasons/current/entrants` for the builds, run `/seasons/simulate` a few hundred
times, compare your probabilities with `/markets`, and bet with `minPrice` where you disagree. A bettor with
about three times the house's simulation budget was profitable against default pricing in the house's own
tests, and the house still came out ahead on the rest of the field.

## Limits

| What | Limit |
| --- | --- |
| Registration | 5, then 1 per 20 s, per IP address (live) |
| Bets | 20, then 2 per second, per user (live) |
| Bot entry | 20, then 1 per 5 s, per user (live) |
| Request body | 256 kB (live) |
| Season simulation | 10, then 1 per 5 s, per user |
| Concurrent matches | 4 per user |
| Seat inputs | 120 messages per second |
| Lockstep budget | 20,000 simulated ticks per wall-clock second per user |
| Lobby wait | 120 s, then the match is aborted |
| Lockstep idle | 10 minutes without a step, then aborted |
| Match length | 180 s of fight time plus a 3 s countdown |

A limited request gets `429` with `Retry-After`. Limits not marked live are proposed defaults, published in
`/rules`.

## Open decisions

These are choices this spec makes that have not been confirmed. Each is easy to change now and expensive later.

1. **Builds become public at season start.** Replay verification needs them, and so does any outside betting
   model. The cost is that a designer's rule tree can be copied after one season.
2. **Driven matches are never bettable.** The alternative is markets on exhibitions priced from a controller's
   track record, with designers barred from betting on matches they drive.
3. **Sensors in direct drive.** A directly driven bot is not bound by its decision cadence, so the sensors part
   buys it only threat awareness. Ranked piloting may want sensors to set the observation delay instead.
4. **Full information.** Every seat sees the whole arena, as built-in brains do today. Fog of war would be a
   rules change, not an API change, but it would add a per-seat view to `state`.
5. **JSON first.** Snapshots are whole JSON objects (an estimated 1.5 kB for four bots, so about 45 kB/s at
   30 Hz; not yet measured). The 5-byte
   binary control frame is specified for input; a binary state format is deferred until measurement says JSON
   is the bottleneck.
6. **No server-side user code.** Custom logic runs either as a rule tree (server-side, sandboxed by
   construction) or on the client through this API. Uploading arbitrary programs to run next to the simulation
   is deliberately out of scope.
7. **No ranked ladder yet.** `sandbox` and `exhibition` only. Rated human-versus-human play needs matchmaking
   and anti-cheat decisions this spec does not make.

## Building it

The order that gets value soonest, with what each step needs from the code as it stands:

1. **Rename and fill in the read side.** Mount today's router at `/api/v1` with the v1 paths; add `/rules`,
   `/builds/check`, `/builds/stock`, fixtures and entrants with builds, uniform error codes. No new mechanics.
2. **The input seam.** `control()` in `src/sim/controller.ts` writes `throttle`, `steer`, `trigger` and
   `wantRelease` on each bot every tick, and physics reads only those. Give `World.step` an optional per-bot
   override so a control frame can replace or partly replace what `control()` wrote.
3. **Lockstep matches over HTTP.** `Driver` already runs a match with a policy per bot, pins intents and forks.
   `POST /matches`, `/step`, `/fork`, `/replay` and the `net` conditioning are a thin layer over it, with no
   sockets and no wall clock. This alone delivers model harnesses and the latency studies.
4. **Realtime and sockets.** A 60 Hz server loop per match, the seat and watch sockets, ping and the timing
   report.
5. **The feed, API keys, OAuth.** Independent of the above and of each other.

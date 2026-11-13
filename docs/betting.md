# Season betting

A bookmaker for bot seasons: per-match, per-round and season-long markets, with handicaps, in play-money
credits. The engine is pure TypeScript with no DOM, clock or randomness of its own, so the same code runs in the
browser (the Betting panel in the season hub), in the simulator, and as a local house server.

This document says what the system is, why each piece is the way it is, and what the simulations show.

**What the simulations show (36 seasons, 39,363 bets, 1.18 million credits staked, three pricing settings):**

- No integrity failure of any kind: no audit or fairness violation, no invalid request accepted out of 16,488
  sent by the fuzzer, no market past its loss bound, credits conserved in every season.
- The house came out ahead on average at every setting and in 28 of 36 seasons, but a single season can lose:
  the worst was −8,322 credits against a bank of 1,000,000.
- A sharp syndicate that simulates more than the house made money at every setting (+5% to +13% on stakes).
  The house's safeguards bound what it can take; they do not stop it.
- Prices are calibrated: selections the model put near 47% won 45% to 49% of the time, and the model beats a
  base-rate guess on Brier score (0.198 against 0.236).

## What you can bet on

A season is eight bots, four league weeks of two four-bot matches, a Last Chance match and a Grand Final.

| Scope | Market | Selections | Decided by |
| --- | --- | --- | --- |
| Match | Winner | the four bots | first in the official classification |
| Match | Top two (Last Chance: to qualify) | the four bots, two win | first or second |
| Match | **Points handicap**, one per pair of bots (six a match) | the two bots | match points with the line added to the first bot; level after the line is a push |
| Match | Fight length | over, under | seconds fought against a line at the simulated median; exactly on the line is a push |
| Round | Top scorer of the week | all eight bots | most league points across the week's two matches; ties are a dead heat |
| Season | Champion | all eight | wins the Grand Final |
| Season | To reach the Grand Final | all eight, four win | is in the final's lineup |
| Season | League winner | all eight | top of the table after week 4, by the table's own tiebreaks |
| Season | **Handicap league** | all eight | league points plus a head start fixed when the market opens; ties are a dead heat |

Match points are the league's own: 5 / 3 / 1 / 0 by place, +1 per elimination, +1 for top damage. A handicap
line is set on a half point where the simulated contest is closest to even, so "CLAMP +4.5 v HACKSAW −4.5" asks
whether HACKSAW outscores CLAMP by five or more. The handicap league's head starts are each bot's expected
shortfall to the favourite, so the weakest bot is a live bet.

Only single bets. No accumulators and no cash-out: both multiply the ways a price can be wrong, and neither is
needed for the game to be fun.

## The life of a round

```
open()             prices are computed; match markets open; a hash of each match's secret is published
   bets            season-long markets are open too, at fresh prices
lock(fixture)      betting on that match closes for good; the week's top-scorer market closes with the
                   week's first match; season markets are suspended; the match seed is revealed
   the match       played in the arena, or simulated
result(fixture)    recorded; every market it decides is settled; season markets reprice and reopen
```

Season markets stay open between matches and close for good just before the match that decides them starts:
the two league markets with the last league match, "to reach the final" with Last Chance, "champion" with the
Grand Final. `src/betting/seasonBook.ts` is the only code that moves a season and its markets, so they cannot
drift apart.

## Why it is hard to break

**Whole credits, integer prices.** Balances and stakes are integers. Prices are decimal odds in hundredths (235
is 2.35), so a payout is `floor(stake × price / 100)`. No floating-point number ever touches a balance, and
every rounding goes to the house.

**A double-entry ledger with a hash chain** (`ledger.ts`). Every movement is an entry whose legs sum to zero.
Credits come into existence only from the `mint` account. No other account can go negative, and a posting that
would break a rule changes nothing. Each entry carries the hash of the one before, so any edit to history
changes the head hash.

**Every bet is fully collateralised when it is struck** (`book.ts`). The stake leaves the bettor and the bet's
maximum profit leaves the house bank, and both sit in that market's escrow until the market is settled or
voided. So a payout can never fail, the house can never owe more than it holds, and a bet the house could not
pay is refused at the door rather than discovered at settlement.

**Hard limits.** Per bet (minimum and maximum stake), per user per market, and per selection: the house's total
liability on one selection of one market is capped, which bounds the worst possible loss on a market at
`winners × cap` whatever the prices were. The simulator checks that no market ever exceeds its bound.

**Requests cannot corrupt state.** `placeBet` never throws on input; it returns one of thirteen typed rejections
and changes nothing. Each request carries a caller-chosen key: repeating a key returns the original bet, and
reusing it with different terms is refused, so a retried request can never double-stake. A request can name the
worst price it accepts, so a price that shortened between quote and bet is a rejection, not a surprise.

**Settlement pays each bet exactly once.** A market must be closed before it is settled, every selection needs a
grade, and the grades may not pay more winners than the market allows. Settling again with the same result pays
nothing; settling again with a different result is refused. Dead heats pay the winning fraction of the stake at
full odds; a push or a void returns the stake.

**One grading function.** `gradeMarket(market, season)` is a pure function of the season state. It settles the
real market, and it is the same function the pricer uses to score every simulated season, so a price and its
settlement cannot disagree about the rules.

**An audit from first principles.** `Book.audit()` rebuilds everything from the ledger and the bet records:
the hash chain, every balance, every bet against its stake entry and its payout entry, every payout against its
market's grades, every escrow against the bets it should be holding, every limit. `SeasonBook.verify()` adds:
every revealed seed against its commit, every simulated result against a replay from its seed, and every
settled market against a fresh grading. A saved book that fails its audit is refused on load, never patched.

**Nobody can know a result while betting is open** (`fair.ts`). A season match is a deterministic function of its
lineup and seed, so a known seed would be a known result. For a betting season the seed is fixed by two things:

1. *Commit.* When a match's markets open, the house draws a secret and publishes only its hash.
2. *Anchor.* When betting on the match closes, the head hash of the ledger is taken. It depends on every bet
   struck, so the house could not have known it when it committed.

The seed is the first 32 bits of `sha256(secret, anchor)`, and the secret is published at that moment. Bettors
cannot compute it early (no secret); the house cannot steer it (it committed before the anchor existed).
Afterwards anyone can check the commit, recompute the seed and replay the match. The pricer never sees a real
seed: its simulations run on their own seed stream.

## Where prices come from

The bookmaker does not have opinions about bots. It plays the rest of the season forward on the real match
engine, many times, and counts (`pricing.ts`).

- A match takes about 10 ms, so each lineup gets a **pool** of simulated outcomes and season rollouts draw from
  the pools. Matches are independent (every match starts from fresh builds), so this is exact apart from the
  pool being finite. Fixtures that exist get a full pool in their true start-corner order; playoff lineups that
  only might happen get a smaller pool that grows with how often they come up.
- Each rollout is a complete simulated season. Every open market is graded on every rollout, which gives a
  win frequency per selection, and the handicap lines and head starts are fitted from the same rollouts.
- **The offered price is not the fair price.** A frequency from a few hundred simulations is an estimate, and
  anyone can run the same engine with more samples. So the implied probability is the estimate plus `z` standard
  errors, times a margin (4 to 8% by market), and the odds are rounded down to a ladder and capped. Selections
  the model saw win almost never or almost always are not offered.
- **Exposure shortens the price.** As liability builds on a selection its price is cut, by up to 20% at the
  cap, at which point the selection takes no more.

Because prices come from simulating the actual builds, entering a deliberately weak bot gives its designer no
edge: the price already knows. That is why a user may bet on their own bot.

The model is only right for the brain it simulates. Server seasons are played on the same deterministic brain
the pricer uses. In the browser a match played in the arena on a different brain (Jev, the trained network) is
priced on baseline behaviour, which is a known gap and a reason the local game is for fun rather than proof.

## What the simulations show

`scripts/betting-sim.ts` plays whole seasons with a book against 40 simulated accounts (`punters.ts`), each
starting a season with 1,000 credits: casual bettors, favourite and longshot backers, a fan of each bot,
handicap players, a three-account **sharp** syndicate with its own better-sampled model that bets only where
the offered price beats it, six **whale** accounts all backing the favourite at the maximum stake, and a
**fuzzer** sending malformed, stale, duplicate and out-of-range requests. The audit runs after every betting
window and the full verification at the end of every season.

Twelve seasons at each of three pricing settings (run 2026-11-12):

| | Default | No safety loading | Heavier pricing |
| --- | --- | --- | --- |
| Pool per fixture, `z` | 160, 0.5 | 160, 0 | 400, 1.0 |
| Sharp's simulation budget | 3× the house | 3× | 1.5× |
| Bets, credits staked | 13,111 · 379,029 | 15,537 · 445,566 | 10,715 · 355,659 |
| House result per season, mean (sd) | +3,849 (3,549) | +2,603 (5,050) | +3,509 (3,695) |
| Worst and best season | −2,966 · +8,958 | −8,322 · +10,350 | −2,417 · +8,751 |
| Winning seasons | 10 of 12 | 9 of 12 | 9 of 12 |
| Hold (house result / stakes) | 12.2% | 7.0% | 11.8% |
| Sharp syndicate: staked, net, return | 52,909 · +3,145 · +5.9% | 104,149 · +4,744 · +4.6% | 21,770 · +2,887 · +13.3% |
| Worst single market (its bound) | −1,918 (−3,000) | −2,732 (−6,000) | −2,190 (−3,000) |
| Brier score (base-rate guess) | 0.199 (0.236) | 0.195 (0.236) | 0.198 (0.235) |
| Audit / fairness violations | 0 | 0 | 0 |
| Invalid requests accepted | 0 of 5,496 | 0 of 5,496 | 0 of 5,496 |
| Markets over their loss bound | 0 | 0 | 0 |
| Pricing cost per season (house) | 4,033 matches | 4,015 | 6,558 |

How to read it:

- **Integrity held everywhere.** This is the claim the system is built to make, and it is the one the evidence
  supports without qualification.
- **The house's profit is an average, not a guarantee.** The season-to-season spread is as large as the mean,
  and two or three seasons in every dozen lost. Losses are small next to the bank: the worst season cost 0.8%
  of it. What is guaranteed is the bound, not the sign.
- **Twelve seasons is a small sample.** An earlier default run on the same twelve season seeds (before the
  eliminations market was replaced) gave the house a 3.4% hold and the sharps +28%. Differences between the
  three columns above are mostly noise; do not tune pricing from one run.
- **Sharps win.** The engine is open and deterministic, so anyone can out-simulate a 160-sample pool. The
  safety loading and heavier pricing shrink how often a sharp finds a bet (stakes fell from about 53,000 to
  22,000) more than they shrink what it wins. The protection that holds is structural: the per-selection
  liability cap, exposure shading and stake limits kept the syndicate to roughly 250 to 400 credits a season
  while the rest of the crowd lost several thousand. If beating the bookmaker by doing the work is unwelcome
  in a play-money game, the levers are a larger pool, a larger `z`, and lower caps on the handicap markets,
  where most of the edge is found.
- **Whales hit the caps, not the bank.** Six accounts at maximum stake on one selection drove it to its
  liability cap in most matches and lost 11% to 23% of their stakes.
- **Dead heats and pushes occur in practice** (95 dead-heat payouts and 5 pushes across the three runs) and
  settle through the same audited path.

The eliminations over/under market in the first draft was dropped: fights nearly always end with exactly three
bots eliminated, so it had no price to offer. Fight length replaced it.


## Running it

```
npm run bet:check                      # engine correctness, about a minute
npm run bet:sim -- --seasons 12        # whole seasons against the simulated public, several minutes
npm run bet:sim -- --pool 400 --z 1    # the same with heavier pricing
```

`betting-check.ts` covers hashing against node:crypto, the ledger, every rejection, rounding, dead heats,
pushes, voids, limits and shading, idempotency, persistence and tamper detection, the outside-wallet mode, a
whole season with the audit and fairness checks after every step, determinism (the same inputs give the same
book, bet for bet), a save and restore between lock and result, a season advanced outside the book, one book
across two seasons, and bots with hostile names.

### In the game

The Betting panel sits in the season hub. Stakes come out of the wallet of the user at the controls
(`src/account`) and winnings go back into it; the Users screen shows each as a ledger line. Betting on a match
closes when you press Play or Simulate. Pricing runs in slices between frames with a progress bar; a match
started before its prices are ready simply has no markets. The book is saved in `localStorage` beside the
season, re-audited on load, and wound up with full refunds if the season is abandoned or replaced. If the book
and the season ever disagree, the book is closed with refunds and the season carries on: betting can never
block a match.

On one machine the player owns the storage the secrets live in, so commit-reveal there is a rehearsal, not a
defence. It becomes a defence on a server.

### As a server

`server/betting.ts` mounts the same engine at `/api/bet` in `npm run dev`:

| | |
| --- | --- |
| `POST /register {handle}` | a user id, 1,000 credits and a bearer token (shown once; only its hash is stored) |
| `GET /me` | wallet and bets |
| `GET /season` | table, fixtures, fairness records, live markets with prices and the caller's maximum stakes |
| `POST /bets {key, marketId, selectionId, stake, minPrice?}` | the bet, or a typed rejection |
| `GET /leaderboard`, `GET /audit` | balances; the full audit run on request |
| `POST /advance` | development: lock, play and settle the next match, or start the next season |

One book and its wallets live across seasons. State is rewritten atomically after every change to
`data/betting/state.json` (set `BET_DATA_DIR` to move it) and reloaded through the audit; a file that fails
stops the server. A fixture is locked and saved before its match runs, so a crash mid-match restarts with
betting still closed.

## What is not done yet

- **Registration is a handle and a token.** Enough to own a wallet. Nothing stops one person registering many
  handles; per-user limits therefore protect nobody, and the per-selection liability cap is the limit that
  holds (the simulator's whales and sharps are multi-account for this reason). Email or OAuth can attach to the
  same user id later without touching the book.
- **The server prices on the request thread.** Opening a season blocks for some seconds. A deployed house should
  price in a worker and should run seasons on a schedule rather than on `POST /advance`.
- **The house can grind the anchor in principle** by inserting its own bets before a lock. Play money makes that
  pointless; with anything of value at stake, anchor to an outside randomness beacon as well.
- **Different JavaScript engines may differ in the last bit of a trig function**, so a browser replay of a
  server match could in principle diverge. The server's result is authoritative; replays should be verified on
  the same runtime, or the sim moved to fixed-point trig.
- **User-designed bots in server seasons.** The server enters the stock bots and house wildcards. Entrants
  already carry an owner, so designer-entered bots are a registration and submission feature, not a betting one.
- **No accumulators, no cash-out, no in-play betting.** Deliberately.

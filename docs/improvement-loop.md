# The improvement loop

How the trained brain gets better on its own, and how we know it did. `scripts/league/` turns the manual
recipe in [trained-brain.md](trained-brain.md) (generate → train → eyeball a 400-match tournament) into a
champion/challenger **league**: every new model has to beat the reigning champion under a sequential test
with known error rates before it replaces it, the champion's measured weak spots steer what data comes next,
and every result ever played feeds one Elo ladder.

```
            ┌──────────────────────────────────────────────────────────────────────────┐
            │                                                                          │
            ▼                                                                          │
 1 DIAGNOSE champion vs baseline, 3,000 pairs ─► per-weapon win share ─► curriculum weights
            │                                                                          │
 2 GENERATE rollout data, champion as behaviour + continuation brain,                  │
            rosters oversampling the weapons it does worst with                        │
            │                                                                          │
 3 TRAIN    K candidates on the newest datasets (different seeds / capacity)           │
            │                                                                          │
 4 GATE     screen candidates vs champion (same seeds) ─► SPRT the best on fresh seeds │
            ─► non-inferiority vs baseline and the previous champion                   │
            │                                                                          │
            ├── pass ─► promote (optionally ship to public/models) ────────────────────┤
            └── fail ─► keep champion; the new data still joins the training pool ─────┘
 5 REPORT   Bradley–Terry ladder over every recorded pair → data/league/REPORT.md
```

## Why the old evaluation was not enough

A 400-match tournament has a standard error of 2.5 points of win share, about ±17 Elo at 95%. Iteration gains
are around +10 to +25 Elo, so a single run could not separate a real gain from luck. Measured on the league
(3,000 side-swapped pairs each, mixed stock and random builds):

| comparison | old docs (400 matches, stock builds) | league (6,000 matches, mixed builds) |
| --- | --- | --- |
| iter1 vs iter0 | 50.2% | **53.2%**, +22.5 Elo [15.3, 29.7] |
| iter2 vs iter1 | 53.3% | **51.4%**, +9.7 Elo [2.8, 16.7] |
| iter2 vs iter0 | 56.8% | **54.4%**, +30.8 Elo [23.4, 38.3] |
| iter2 vs baseline | 67–70% | **67.5%**, +127 Elo [118, 136] |

Both iterations helped. The ordering of the gains was reversed, though: most of the gain came in the first
round and the second was half as large as reported. Matches are cheap (~40 ms each; 14 workers play ~300 a
second), so there is no reason to decide anything on 400.

## The statistics

**Pairs, not matches.** Every comparison is a set of *pairs*: one roster and seed, played twice, with the two
brains swapping bots between the halves. The pair is the unit. Its score for side A is 0, ¼, ½, ¾ or 1 (the
pentanomial model chess-engine testing uses), and its variance is estimated empirically, so the correlation
between the two halves is accounted for, not assumed away. Everything about a pair (roster, which bots start
on which side, the sim seed) is a function of its seed, so any pair can be replayed.

**Builds.** By default half the pairs use four distinct stock bots and half use random legal Garage builds,
so a model is judged on the whole design space and not only on the stock four.

**Elo and LOS.** A comparison reports the mean score with a 95% interval, the logistic Elo with its interval,
and the likelihood of superiority (P(A is truly stronger)).

**SPRT gate.** Promotion uses a generalized sequential probability ratio test on pair scores (the normal
approximation fishtest uses): H0 "candidate ≤ 0 Elo better", H1 "≥ 8 Elo better", α = β = 0.05, checked
every 280 pairs, capped at 30,000. The test stops as soon as the evidence is strong either way, so clear
wins and clear losses cost little and close calls get more matches. `scripts/league/check-stats.ts` checks
the real error rates of this exact schedule by simulation:

| true difference | wrong decision | nominal | average pairs |
| --- | --- | --- | --- |
| 0 Elo | promoted 3.0% | ≤ 5% | ~5,200 |
| −8 Elo | promoted 0.0% | | ~1,800 |
| +8 Elo | rejected 3.3% | ≤ 5% | ~5,250 |
| +25 Elo | promoted 100% | | |

**Several candidates without the winner's curse.** When a generation trains more than one candidate, all of
them play the champion on the *same* screening seeds and the best goes forward. The SPRT then runs on *fresh*
seeds, so picking the luckiest screen score cannot inflate the confirmatory test. A seed counter in
`state.json` guarantees no two tests share seeds unless they are meant to be paired.

**Non-regression guards.** Beating the champion head-to-head is not enough: a candidate could exploit the
champion's quirks and get worse in general (non-transitivity). After a passing SPRT, the candidate and the
champion each play baseline, and the previous champion, on identical seeds. The paired difference must have
its 95% lower bound above −3 points of score (non-inferiority, ≈ −21 Elo). A truly equal candidate passes
~96% of the time; a real regression fails.

**One ladder for everything.** Every pair ever played is appended to `data/league/results.jsonl`. `league.ts
ladder` fits Bradley–Terry strengths to all of it (baseline fixed at 0 Elo) with 95% intervals from 300
bootstrap resamples, so diagnoses, screens, SPRTs, guards and ad-hoc duels all sharpen the same ranking.
The check script confirms the fit recovers known strengths within ~6 Elo and that the intervals cover them.

## The feedback into training

1. **Curriculum from weak spots.** The diagnosis breaks the champion's win share down by weapon, with Wilson
   intervals. Each weapon gets a weight `exp((mean − shrunk share) / 0.08)`, where the share is shrunk toward
   the mean with 300 pseudo-games and the weight is clamped to [0.5, 2.5] and normalized. `gen.ts --focus`
   samples rosters with those weights, so the next dataset spends more rollouts where the champion loses.
   Example: iter2 wins 82% of its bot-matches with the hammer but 58% with the spinner, so the spinner gets
   ~3.4× the hammer's weight.
2. **Expert iteration.** The champion is both the behaviour brain and the rollout continuation brain while
   generating, so each dataset labels "what happens if I do X, then play like the current best".
3. **A rolling window.** Candidates train on the newest `window` datasets (default 4), so old, weaker-policy
   data ages out and memory stays bounded (~0.7 GB per dataset).
4. **Hyperparameters judged by matches.** By default each generation trains two variants: the standard net
   and a wider (128 hidden), longer-trained one. Screening scores show which kind of change actually wins
   matches, not only which lowers validation loss.

## Running it

```bash
# once: register the existing models and datasets (already done in data/league/ on this machine)
npm run league -- init --champion iter2=data/models/iter2.json \
  --history iter0=data/models/iter0.json,iter1=data/models/iter1.json \
  --datasets data/iter0,data/iter1,data/iter2 --first-gen 3

# N generations; resumable (every step skips finished work). SHIP=1 also copies each new champion to the game.
WORKERS=14 scripts/league/loop.sh 2
SHIP=1 scripts/league/loop.sh 3

# inspect
npm run league -- status
npm run league -- ladder                       # Bradley–Terry Elo of every model, baseline = 0
npm run league -- duel g4a iter2 --pairs 3000  # any two players (names, model paths, or baseline)
npm run league -- duel g4a iter2 --sprt        # sequential instead of fixed N
open data/league/REPORT.md                     # ladder, generation table, weak spots

# statistics self-test (simulation; < 1 s)
npx tsx scripts/league/check-stats.ts
```

Knobs live in `data/league/state.json` under `config`: SPRT bounds and error rates, batch size and cap,
screening/diagnosis/guard pair counts, the guard margin, guard depth, dataset window and curriculum
temperature. Candidate variants are the `CANDIDATES` environment variable of `loop.sh`, a `;`-separated
list of `train.py` argument sets.

Cost per generation on the M5 Max with 14 workers: diagnosis ~20 s, data ~16–20 min, training ~1–3 min per
candidate, gate 1–4 min. Data generation is still the bottleneck; the statistics are nearly free.

## Files

| | |
| --- | --- |
| `scripts/league/stats.ts` | pentanomial summary, Elo/LOS, GSPRT, Wilson, paired differences, Bradley–Terry + bootstrap |
| `scripts/league/arena.ts` | plays one seeded, side-swapped pair between two contenders |
| `scripts/league/pool.ts` | worker-thread pool for pairs |
| `scripts/league/league.ts` | registry, diagnose, gate, duel, ladder, report |
| `scripts/league/loop.sh` | the generation loop |
| `scripts/league/check-stats.ts` | simulation checks of the statistics |
| `scripts/train/gen.ts --focus`, `builds.ts` | curriculum-weighted roster sampling |
| `data/league/` (gitignored) | `state.json`, `results.jsonl`, `models/`, `candidates/`, `focus-g*.json`, `REPORT.md` |

## Results

RESULTS_PLACEHOLDER

## Ideas next

- **Train the style.** The same gate can tune the ten style weights (Turtle already beats Balanced): SPRT a
  style change against the current default and promote the default the same way as a model.
- **Gate on the game's format too.** Add a guard against Jev (a few dozen pairs, ~$0.02 a match) so a model
  that overfits sim-only opponents is caught.
- **Match-outcome value head.** The league already records who won each match. Labelling rollout moments with
  the eventual match result would give a longer-horizon target than the 2.5 s rollouts.
- **Matchup curriculum.** Weights are per weapon today; per (my weapon, their weapon) cells would target
  specific bad matchups once the ladder has enough pairs to resolve them.

# The trained brain

A third way for a bot to think, next to the **Jev** brain (hosted System One model reading words) and the
**baseline** brain (the hand-written rule tree): a small neural network, trained here on this machine from the
simulator itself, that runs inside the browser in a fraction of a millisecond.

It is not a language model and reads no text. It reads numbers about the moment (where everyone is, who is
facing whom, weapon charge, hazards, build stats) and answers one question for every option the bot has:
*if I did this to that opponent for the next second, what would happen over the next few seconds?*

## Results

Measured on this M5 Max (2026-11-08). Tournaments put two bots on each brain per match and swap sides on the
same roster and seed, so 50% is even; ±2.5 points is one standard error at 400 matches.

| | trained brain | baseline rule trees | Jev (hosted) |
| --- | --- | --- | --- |
| Head-to-head win share, stock builds (400 matches) | **70.0%** | 30.0% | |
| Head-to-head win share, random Garage builds (400) | **67.3%** | 32.5% | |
| Head-to-head win share vs Jev, stock builds (20 matches, iteration-1 model) | **65%** (13–7) | | 35% |
| Avg damage dealt per bot (vs baseline, stock) | 394 | 255 | |
| Danger: AUC vs "actually hit within 1.5 s" (held out; 0.5 = chance) | **0.874** | | 0.63* |
| Decision time | **~0.1–0.4 ms** in the browser, synchronous | ~0 | 83 ms p50 + network |
| Cost per match | $0 | $0 | ~$0.02 |
| Where it runs | browser, 233 KB of float16 weights | browser | server → TypeSafe |

\* Jev's AUC is from the earlier d1 evaluation corpus (four stock bots, older sim), so it is indicative,
not a same-corpus comparison. In the Jev tournament Jev had its real latency: each answer was applied after
its measured round trip, in sim time, like in the browser (3,900 Jev answers, 0 errors).

Technique mix against Jev: the trained brain engaged 43% / held 15% / retreated 14% / flanked 13%; Jev engaged
38% / retreated 27% (the retreat bias noted in earlier sessions).

Offline (held-out rows from unseen matches): picking the network's best option leaves 19 hp of regret against
the best option the rollouts found, vs 29 hp for a random installed option and 25 hp for "engage the first
opponent". Rollout outcomes are single noisy samples, so no model gets near 0 here; the tournaments are the
real test.

## How it works

### 1. Labels come from the simulator, by playing every option out

The sim is deterministic and runs headless at roughly 10,000× real time on one core, so instead of asking
anyone what a good decision is, the generator *tries them all*:

1. Play a match between random legal builds (any weapon, any parts within budget, any technique set), with
   the behaviour brains plus 15% random exploration so unusual situations show up.
2. At a sampled decision moment, fork the whole world (`World.clone`, RNG included) once per
   *(installed technique × living opponent)* whose technique gate holds right now.
3. In each fork, force that choice for 1.0 s, then let every bot (this one included) carry on with its normal
   brain until 2.5 s have passed.
4. Record, for the deciding bot, six outcome numbers:

   | component | meaning |
   | --- | --- |
   | `dealt` | damage dealt, including the remaining health of anyone it put in the pit (per 100 hp) |
   | `taken` | damage taken (per 100 hp) |
   | `kills` | opponents it eliminated |
   | `died` | 1 if it was eliminated |
   | `crit` | critical-hit damage dealt (also counted in dealt) |
   | `hazard` | damage dealt through walls, kill saws and the pit (also counted in dealt) |

   Sibling forks share their random numbers (the RNG is copied), so differences between options are not
   drowned in crit-roll noise.
5. Separately, record whether the bot actually took damage in the next 1.5 s on the real trajectory: the label
   for the danger head (the same definition the Jev `in_danger` evaluation used).

`scripts/train/check-fork.ts` verifies forks replay bit-identically (196/196 checks).

### 2. The network

A set encoder, so opponents have no order and dead ones simply drop out (the d1 evaluation showed how much
option order can bias a decision model):

```
s      = relu(self1 · self)                      79 numbers about me
e_i    = relu(opp2 · relu(opp1 · [opp_i, s]))    45 numbers per opponent, shared weights
pool   = [mean e_i, max e_i]
c      = relu(trunk · [s, pool])
danger = sigmoid(danger · c)                     P(I get hit in the next 1.5 s)
q_i    = pair2 · relu(pair1 · [e_i, c])          17 techniques × 6 outcomes, for opponent i
```

About 87k weights, 96 hidden units, stored as float16 in `public/models/trained-brain.json` (~230 KB).
Training is PyTorch on the CPU (`scripts/train/train.py`): masked MSE on the outcomes that were rolled out
(each component scaled to unit variance), plus binary cross-entropy for danger. 20–60 s per run on the M5, depending on how many datasets are stacked.

The forward pass is re-implemented in plain TypeScript (`src/brain/trained/net.ts`): no ONNX, no WebGL, no
server. `scripts/train/check-parity.ts` confirms it matches PyTorch to within 1e-4 on held-out rows.

### 3. Style is applied at decision time

The network predicts the six outcomes separately, so a bot's **personality** is just how it weighs them:

```
value(technique, target) = aggression·dealt − caution·taken + 0.5·killer·kills − 1.5·survival·died
                         + showboat·crit + hazards·hazard
                         + commitment / grudge / technique-bias nudges
```

and the bot picks the best-valued pair among the techniques that are installed and whose gates hold (the same
gates the Jev brain is limited to), or samples among the near-best when decisiveness is below 1. Because the
weights are applied after the network, **every slider takes effect immediately, with no retraining**, and one
set of network weights serves every bot.

| slider | effect |
| --- | --- |
| Aggression | value of damage dealt |
| Caution | cost of damage taken |
| Killer instinct | bonus for eliminations |
| Self-preservation | cost of being eliminated |
| Showboating | extra value for critical hits |
| Hazard play | extra value for wall / saw / pit damage |
| Decisiveness | 1 = always the best option; lower samples (softmax) among the near-best |
| Commitment | reluctance to switch technique or target mid-plan |
| Grudge | preference for whoever hit me last |
| Nerves | scales the danger estimate the motors react to (weaving, flooring it) |
| Technique bias | ±10 hp of value per installed technique |

Presets: Balanced, Berserker, Turtle, Showboat, Hazard hunter, Grudge match, Wildcard.

Measured with the shipped model, each preset against Balanced, everyone on the trained brain
(200 matches each; ±3.5 points):

| preset | win share vs Balanced | avg damage (vs Balanced's) | what changes |
| --- | --- | --- | --- |
| Turtle | **55.0%** | 282 (337) | retreat 27%, hold 25%: deals less, survives more |
| Hazard hunter | **54.0%** | 324 (320) | more saw/pit plays |
| Berserker | 41.0% | 318 (331) | engage 61%, retreat 7% |
| Showboat | 40.5% | 316 (331) | chases crits, dies more |
| Grudge match | 43.5% | 310 (334) | tunnel vision on whoever hit it |
| Wildcard | 43.5% | 290 (362) | samples widely: circle 11%, flank 16% |

Balanced is what the network was scored on during evaluation, but it is not the optimum for
last-bot-standing: survival-weighted styles (Turtle, Hazard hunter) beat it. The defaults are a tuning lever,
not a law.

### 4. Expert iteration

The first model learns "what happens if I do X now and then behave like the baseline tree". It is then used as
the behaviour *and* continuation brain for most bots when generating the next dataset, so the next model learns
"…and then behave like the trained brain". Datasets are aggregated across iterations.

| model | data it learned from | vs baseline (stock / random builds) | head-to-head |
| --- | --- | --- | --- |
| iteration 0 | 300k moments, baseline continuations | 63.0% / 67.0% | |
| iteration 1 | + 281k moments, iteration-0 brain in the loop | 69.3% / 64.0% | 50.2% / 54.0% vs iteration 0 |
| **iteration 2 (shipped)** | + 279k moments, iteration-1 brain in the loop | **70.0% / 67.3%** | 53.3% / 52.5% vs iteration 1; 56.8% vs iteration 0 |

These head-to-head numbers came from 400-match runs (±17 Elo at 95%). Re-measured later in the league with
3,000 side-swapped pairs each on mixed builds, both rounds helped, but the sizes were the other way round:
iteration 1 vs 0 **+22.5 Elo** [15.3, 29.7], iteration 2 vs 1 **+9.7 Elo** [2.8, 16.7]. Ladder vs baseline: 0 → +96,
1 → +112, 2 → +125 Elo. From here on, improvement runs through the automated, SPRT-gated loop in
[improvement-loop.md](improvement-loop.md).

Cost of each round on the M5 Max: ~6 min (iteration 0) or ~16 min (with the network in every rollout) of data
generation on 14–16 cores, plus ~40–60 s of training. Each iteration's gain is a few points; a third round
is cheap if wanted.

## In the game

- Every bot card's brain badge cycles **Jev → Trained → Baseline**. `T` (or **All Trained**) puts everyone on it.
- With no `TYPESAFE_API_KEY`, bots set to Jev run the trained brain instead (badge shows `JEV→NET`), so the
  arena plays well offline and for free.
- The side panel shows the loaded model; the card shows each decision's compute time in µs.
- The trained brain respects the bot's **Sensors** level: it decides at the same cadence the other brains do,
  even though it could decide every physics tick. Reaction time stays a build choice.
- **Garage → TRAINED BRAIN**: presets, the ten sliders, per-technique bias, a live table of every option the
  network is weighing for that bot right now (value plus the six predicted outcomes and danger), the model's
  held-out metrics, and **⚖ Test style** (16 matches with this personality vs the same 16 with Balanced).
  Style lives in the build (`logic.trained`), so it saves to the library, exports, and applies live.

## Retraining

For repeated improvement, use the league loop (`scripts/league/loop.sh`, see [improvement-loop.md](improvement-loop.md)):
it runs these steps, gates every new model with a sequential test against the champion, and keeps an Elo ladder.
The manual recipe:

```bash
# 1. data (≈6 min on 16 workers; ~300k labelled moments, ~700 MB, gitignored)
npx tsx scripts/train/gen.ts --name iter0 --workers 16 --matches 80 --seed 1
# 2. train (≈20 s)
python3 scripts/train/train.py data/iter0 --out data/models/iter0.json
npx tsx scripts/train/check-parity.ts data/models/iter0.json
# 3. expert iteration: generate with the model in the loop, train on everything
npx tsx scripts/train/gen.ts --name iter1 --workers 16 --matches 80 --seed 2 --model data/models/iter0.json
python3 scripts/train/train.py data/iter0 data/iter1 --out data/models/iter1.json
# 4. evaluate, then ship
scripts/train/eval-iters.sh data/models/iter0.json data/models/iter1.json 400   # each vs baseline, then head-to-head
scripts/train/eval-styles.sh data/models/iter1.json 200                         # personality presets vs Balanced
cp data/models/iter1.json public/models/trained-brain.json
# optional: against Jev (uses API credit, ~1 min and ~$0.01 per match)
npx tsx --env-file=.env scripts/train/tournament.ts --model public/models/trained-brain.json --vs jev --matches 20
```

Requirements: Node (already needed) and Python 3 with `torch` and `numpy`. No GPU; the M5's CPU cores do it.
Cloud compute is not needed at this scale.

**Changing the features or the techniques list breaks the model contract.** `FEATURE_VERSION` in
`src/sim/features.ts`, the maneuver list and the outcome list are written into every dataset and model, and
`TrainedNet` refuses a mismatched model with a "Retrain" error. Adding a weapon, technique or arena hazard
means: bump `FEATURE_VERSION`, regenerate, retrain. Rebalancing weapon numbers does not break anything but
makes the model's predictions stale; retrain when the balance changes a lot.

## Files

| | |
| --- | --- |
| `src/sim/world.ts` `clone()`, `src/sim/bot.ts` `cloneForFork()` | forkable simulation |
| `src/sim/driver.ts` | headless match driver with per-bot synchronous policies, pins and `fork()` |
| `src/sim/features.ts` | the numeric encoder (the model's input contract) |
| `src/sim/rollout.ts` | one counterfactual rollout → outcome vector |
| `src/brain/trained/net.ts` | model file format and the TypeScript forward pass |
| `src/brain/trained/policy.ts` | style weighting, gating, sampling → `Intent` |
| `scripts/train/gen.ts`, `builds.ts`, `spec.ts` | dataset generation (worker threads), random legal builds, row layout |
| `scripts/train/train.py` | training and export |
| `scripts/train/tournament.ts` | head-to-head evaluation (vs baseline, vs Jev, style or model A/B) |
| `scripts/train/check-fork.ts`, `check-parity.ts` | determinism and parity checks |
| `scripts/train/eval-iters.sh`, `eval-styles.sh` | the evaluation runs behind the tables above |

## Ideas next

- **Garage model adapters.** The style already acts like a zero-cost adapter. Next steps: per-weapon
  fine-tuned heads (a few thousand weights each, trained on that weapon's rows), or a learned per-build
  embedding, selectable in the Garage like parts.
- **Train the style.** Search the ten style numbers per build with the tournament as the objective (the
  logic tuner's sweep, applied to the trained brain). Turtle beating Balanced says there is headroom.
- **Longer horizons.** A value head for match outcome would let the bot trade a little damage now for position.
- **Reflex mode.** The model is fast enough to decide every tick; a Sensors-level-6 style "reflex" part could
  buy that.

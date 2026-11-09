#!/usr/bin/env bash
# Compare trained-brain iterations: each vs baseline (stock and random builds), then newest vs previous.
#   scripts/train/eval-iters.sh data/models/iter0.json data/models/iter1.json [matches=400]
set -euo pipefail
prev="$1"
next="$2"
n="${3:-400}"
run() { npx tsx scripts/train/tournament.ts "$@" --seed 21 --matches "$n" | sed -n '/win share  /p'; }
for model in "$prev" "$next"; do
  for builds in stock random; do
    echo "== $(basename "$model" .json) vs baseline ($builds builds)"
    run --model "$model" --builds "$builds"
  done
done
for builds in stock random; do
  echo "== $(basename "$next" .json) vs $(basename "$prev" .json) ($builds builds)"
  run --model "$next" --vs trained --model-b "$prev" --builds "$builds"
done

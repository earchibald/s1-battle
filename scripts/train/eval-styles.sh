#!/usr/bin/env bash
# Every personality preset vs Balanced, everyone on the same trained model: win share and technique mix.
#   scripts/train/eval-styles.sh [model=public/models/trained-brain.json] [matches=200]
set -euo pipefail
model="${1:-public/models/trained-brain.json}"
n="${2:-200}"
for style in berserker turtle showboat hazard grudge wildcard; do
  echo "== $style vs balanced"
  npx tsx scripts/train/tournament.ts --model "$model" --vs trained --style "$style" --style-b balanced --matches "$n" --seed 41 | sed -n '/win share  /p;/technique mix/{n;p;}'
done

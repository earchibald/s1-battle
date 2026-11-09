#!/usr/bin/env bash
# Recursive improvement loop for the trained brain. Each generation:
#   1. diagnose   champion vs baseline, per-weapon win share → curriculum weights
#   2. generate   rollout data with the champion in the loop, rosters skewed toward its weak weapons
#   3. train      several candidates on the newest datasets (different seeds / capacity)
#   4. gate       screen candidates vs champion, SPRT the best on fresh seeds, non-regression guards; promote
#   5. report     Bradley–Terry ladder + generation table in data/league/REPORT.md
# Every step skips work whose output already exists, so an interrupted loop resumes where it stopped.
#
#   scripts/league/loop.sh [generations=1]
#
# Environment: WORKERS (default: cores − 4) · MATCHES (gen.ts matches per worker, default 80) ·
# SHIP=1 (copy each new champion to public/models/trained-brain.json) · CANDIDATES (";"-separated train.py
# argument sets, one candidate each; "{gen}" expands to the generation number).
# First run: initialise the league (see docs/improvement-loop.md).
set -euo pipefail
cd "$(dirname "$0")/../.."

GENERATIONS="${1:-1}"
CORES="$(sysctl -n hw.ncpu 2>/dev/null || nproc)"
WORKERS="${WORKERS:-$((CORES > 6 ? CORES - 4 : 2))}"
MATCHES="${MATCHES:-80}"
CANDIDATES="${CANDIDATES:---seed {gen};--seed {gen} --hidden 128 --epochs 18}"
LEAGUE="npx tsx scripts/league/league.ts"
ROOT="${LEAGUE_DIR:-data/league}"
export LEAGUE_WORKERS="$WORKERS"

stamp() { date "+%H:%M:%S"; }

for ((i = 0; i < GENERATIONS; i++)); do
  gen="$($LEAGUE next-gen)"
  echo "[$(stamp)] ===== generation $gen (champion $($LEAGUE champion-path)) ====="

  # 1. Diagnose (writes the curriculum weights the generator reads).
  if [[ ! -f "$ROOT/focus-g$gen.json" ]]; then
    $LEAGUE diagnose --gen "$gen"
  fi

  # 2. Generate data with the current champion as behaviour and continuation brain.
  if [[ ! -f "data/g$gen/meta.json" ]]; then
    echo "[$(stamp)] generating data/g$gen ($WORKERS workers × $MATCHES matches)"
    npx tsx scripts/train/gen.ts --name "g$gen" --workers "$WORKERS" --matches "$MATCHES" --seed "$((100 + gen))" \
      --model "$($LEAGUE champion-path)" --focus "$ROOT/focus-g$gen.json"
  fi
  $LEAGUE add-dataset "data/g$gen" --gen "$gen" > /dev/null

  # 3. Train candidates on the newest datasets.
  mkdir -p "$ROOT/candidates"
  window="$($LEAGUE window)"
  cands=()
  IFS=';' read -ra variants <<< "$CANDIDATES"
  letters=(a b c d e f)
  for k in "${!variants[@]}"; do
    out="$ROOT/candidates/g${gen}${letters[$k]}.json"
    args="${variants[$k]//\{gen\}/$gen}"
    if [[ ! -f "$out" ]]; then
      echo "[$(stamp)] training $(basename "$out") on: $window  [$args]"
      # shellcheck disable=SC2086
      python3 scripts/train/train.py $window --out "$out" --note "league gen $gen: $args" $args > "$ROOT/candidates/g${gen}${letters[$k]}.log"
      tail -2 "$ROOT/candidates/g${gen}${letters[$k]}.log" | head -1 | cut -c1-200
    fi
    npx tsx scripts/train/check-parity.ts "$out"
    cands+=("$out")
  done

  # 4. Gate.
  echo "[$(stamp)] gating"
  joined="$(IFS=,; echo "${cands[*]}")"
  if [[ -n "${SHIP:-}" ]]; then $LEAGUE gate --gen "$gen" --candidates "$joined" --ship; else $LEAGUE gate --gen "$gen" --candidates "$joined"; fi

  # 5. Report.
  $LEAGUE ladder
  echo "[$(stamp)] generation $gen done → $ROOT/REPORT.md"
done

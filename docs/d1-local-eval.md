# Local Liquid d1 as a Jev alternative — evaluation (2026-11-08)

Question: can [LiquidAI/d1-omni-600M](https://huggingface.co/LiquidAI/d1-omni-600M), run locally, replace Jev as the
bots' brain? Short answer: **it plugs in with zero game-code changes, but the 600M model is not good enough to drive
the bots.** Its larger sibling d1-3B is a credible second opinion but slower than hosted Jev on this machine.

## Integration: drop-in

d1 speaks the same System One schema Jev does (`noul` / `choice` / `score`, `instructions`, `criteria`). The TypeSafe
SDK honours `TYPESAFE_BASE_URL`, so a local server that answers `POST /v1/systemone` in Jev's wire format is all
that is needed. `scripts/d1/serve.py` is that server (MLX, via `mlx-vlm`). Two gotchas it handles:

- The SDK **zstd-compresses request bodies** (`Content-Encoding: zstd`).
- mlx-vlm's answer shape differs (`bool`/`probability`, `value`, `metadata.confidence`); the server reshapes to
  `{type:"noul", noul}` / `{type:"choice", choice, confidence, probabilities}`.

The Homebrew llama.cpp here (build 10050) cannot load the d1 GGUF (`missing tensor 'blk.16.ffn_gate.weight'`), and
`llama-server -hf` hung silently; a newer llama.cpp is needed for that route. Liquid's GGUF card says llama-server
serves `/v1/systemone` natively, which would make it a second drop-in option once upgraded.

## Method

`scripts/dump-corpus.ts` records 320 real decision moments from 6 seeded headless matches (all four bot kinds), each
with the exact questions the game asks and a ground-truth label: did this bot take damage within the next 1.5 s
(57% did). `scripts/compare-backends.ts` replays the corpus through the real SDK against any backend;
`scripts/d1/analyze.py` compares. Each local model was also re-run with the `maneuver`/`target` options in
**reversed order**, to separate reading-the-situation from picking-by-position. Apple M5 Max, 64 GB, MLX fp16 / 8-bit.

## Results

| | Jev (hosted) | d1-omni-600M fp16 | d1-3B 8-bit |
|---|---|---|---|
| Maneuver changes when only option order is reversed | 8% | **51%** | 14% |
| Picks the first-listed maneuver | 51% | 82% | 34% |
| Maneuver / target top-1 agreement with Jev | — | 48% / 53% | 48% / 55% |
| `in_danger` vs. real hits: AUC (0.5 = chance) | **0.63** | 0.54 | 0.59 |
| `in_danger` correlation with Jev | — | +0.12 | +0.72 |
| Latency p50 / p95 / max, serial, warm | 139 / 306 / 457 ms (conc. 4) | 135 / 459 / 993 ms | 271 / 545 / 1864 ms |
| Throughput (one server process) | ~25 req/s at conc. 4 | ~6 req/s | ~3 req/s |
| Cost per match | ~$0.02 | $0 | $0 |

Behaviour, maneuver mix per kind:

- **Jev** varies with the situation: LAUNCHER engage 33% / retreat 26% / flank 24% / circle 12%.
- **d1-omni-600M** collapses: LAUNCHER engage 98%, PILEDRIVER engage 97%. Half its maneuver answers flip when only
  the option order changes, and its danger estimate is near chance. It is mostly reading list position, not the arena.
- **d1-3B** reads the situation (order-stable, danger tracks Jev at r=0.72) but has its own style (flank-heavy:
  LAUNCHER flank 84%), which would need prompt re-tuning, and is about 2x slower than Jev.

Latency is shape-driven: an identical repeat request takes 34 ms; a new prompt length costs ~100–300 ms while MLX
specializes kernels, and a cold first request after idle took >2.5 s (the game's timeout → baseline fallback).
Prompts are ~1,400 input positions because d1 re-reads the state once per question.

## Verdict and levers

d1-omni-600M is not a viable bot brain here: not faster than hosted Jev on this workload, it can't keep up with
four bots' ~7 req/s from one process, and its decisions are dominated by option order. Its model card's Decision
Index (16 vs. 40–50 for 3B+ decision models) predicted this.

If offline / zero-cost play matters, d1-3B is the one to pursue, with:

1. Cross-bot batching — one forward pass for all four bots' requests (mlx-vlm's d1 code already batches rows).
2. Padding prompts to a few fixed lengths so MLX stops re-specializing (kills the latency tail).
3. Prompt tuning against its flank bias; re-run `analyze.py` after.
4. Or upgrade llama.cpp and compare its `/v1/systemone` throughput.

## Reproduce

```bash
uv venv ~/models/d1/venv --python 3.12
uv pip install --python ~/models/d1/venv/bin/python "mlx-vlm>=0.7.8" zstandard
~/models/d1/venv/bin/python scripts/d1/serve.py --port 8091          # or --model LiquidAI/d1-3B-MLX-8bit

npx tsx scripts/dump-corpus.ts corpus.jsonl 6 7
npx tsx scripts/compare-backends.ts corpus.jsonl out-jev.jsonl 4
TYPESAFE_BASE_URL=http://127.0.0.1:8091 npx tsx scripts/compare-backends.ts corpus.jsonl out-d1.jsonl 1
~/models/d1/venv/bin/python scripts/d1/analyze.py corpus.jsonl out-jev.jsonl out-d1.jsonl

# Play the game on d1 (server/jev.ts still requires TYPESAFE_API_KEY to be set; any value works locally):
TYPESAFE_BASE_URL=http://127.0.0.1:8091 npm run dev
```

License: LFM Open License v1.0 — free, including commercial use, below $10M annual revenue.

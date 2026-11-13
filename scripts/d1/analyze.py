"""
Compare backend replays (scripts/compare-backends.ts output) against a reference replay, usually Jev.
    python scripts/d1/analyze.py corpus.jsonl ref.jsonl other.jsonl [other2.jsonl ...]
"""
import json
import statistics as st
import sys
from collections import Counter, defaultdict


def load(p):
    return [json.loads(l) for l in open(p) if l.strip()]


def pct(xs, q):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(len(xs) * q))]


corpus = load(sys.argv[1])
ref = load(sys.argv[2])
others = sys.argv[3:]


def auc(scores, labels):
    pos = [s for s, t in zip(scores, labels) if t]
    neg = [s for s, t in zip(scores, labels) if not t]
    return sum((p > q) + 0.5 * (p == q) for p in pos for q in neg) / (len(pos) * len(neg))


def summarize(name, rows):
    ok = [r for r in rows if "answers" in r]
    ms = [r["ms"] for r in ok]
    toks = [r.get("usage", {}).get("input_tokens", 0) for r in ok]
    print(f"\n== {name}: {len(ok)}/{len(rows)} ok, client latency p50 {pct(ms, .5):.0f} ms p95 {pct(ms, .95):.0f} ms, "
          f"input tokens mean {st.mean(toks):.0f}")
    by_kind = defaultdict(Counter)
    for r in ok:
        by_kind[r["kind"]][r["answers"]["maneuver"]["choice"]] += 1
    for k, c in sorted(by_kind.items()):
        tot = sum(c.values())
        print(f"   {k:8s} " + "  ".join(f"{m} {n * 100 / tot:.0f}%" for m, n in c.most_common()))
    # Ground truth from dump-corpus.ts: did this bot actually get hit within the horizon?
    pairs = [(r["answers"]["in_danger"]["noul"], c["hitSoon"]) for c, r in zip(corpus, rows) if "answers" in r and "hitSoon" in c]
    if pairs and 0 < sum(t for _, t in pairs) < len(pairs):
        print(f"   in_danger vs real hits: AUC {auc(*zip(*pairs)):.2f}")


summarize(sys.argv[2], ref)
base = Counter()
for c, r in zip(corpus, ref):
    if "answers" in r:
        base[c["baseline"]["maneuver"] == r["answers"]["maneuver"]["choice"]] += 1
print(f"   (Jev vs baseline maneuver agreement: {base[True] * 100 / sum(base.values()):.0f}%)")

for path in others:
    rows = load(path)
    summarize(path, rows)
    man = tgt = tgt_n = 0
    soft = []
    dang = []
    extra = defaultdict(list)
    vs_base = 0
    n = 0
    by_kind = defaultdict(lambda: [0, 0])
    for c, a, b in zip(corpus, ref, rows):
        if "answers" not in a or "answers" not in b:
            continue
        n += 1
        A, B = a["answers"], b["answers"]
        same = A["maneuver"]["choice"] == B["maneuver"]["choice"]
        man += same
        by_kind[c["kind"]][0] += same
        by_kind[c["kind"]][1] += 1
        soft.append(B["maneuver"]["probabilities"].get(A["maneuver"]["choice"], 0))
        vs_base += c["baseline"]["maneuver"] == B["maneuver"]["choice"]
        if "target" in A:
            tgt_n += 1
            tgt += A["target"]["choice"] == B["target"]["choice"]
        dang.append((A["in_danger"]["noul"], B["in_danger"]["noul"]))
        for k, v in A.items():
            if v["type"] == "noul" and k != "in_danger" and k in B:
                extra[k].append((v["noul"], B[k]["noul"]))
    print(f"   maneuver top-1 agrees with Jev: {man * 100 / n:.0f}%  "
          f"(" + ", ".join(f"{k} {x * 100 / t:.0f}%" for k, (x, t) in sorted(by_kind.items())) + ")")
    print(f"   mean P(Jev's maneuver) under this model: {st.mean(soft):.2f}")
    print(f"   maneuver agrees with baseline tree: {vs_base * 100 / n:.0f}%")
    print(f"   target top-1 agrees with Jev: {tgt * 100 / max(tgt_n, 1):.0f}% of {tgt_n}")
    for k, pairs in [("in_danger", dang), *extra.items()]:
        xs, ys = zip(*pairs)
        r = st.correlation(xs, ys) if len(pairs) > 2 and st.pstdev(ys) > 0 and st.pstdev(xs) > 0 else float("nan")
        agree = sum((x > .5) == (y > .5) for x, y in pairs) * 100 / len(pairs)
        print(f"   {k:20s} n={len(pairs):3d} corr {r:+.2f}  same side of 0.5 {agree:.0f}%  "
              f"mean Jev {st.mean(xs):.2f} vs {st.mean(ys):.2f}")

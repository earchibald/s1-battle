"""
Train the S1 Arena trained brain from rollout datasets made by scripts/train/gen.ts.

    python3 scripts/train/train.py data/iter0 [data/iter1 ...] --out public/models/trained-brain.json

The network (mirrored exactly by src/brain/trained/net.ts):

    s      = relu(self1 . norm(self))
    e_i    = relu(opp2 . relu(opp1 . [norm(opp_i), s]))        shared weights, one per living opponent
    pool   = [mean_i e_i, max_i e_i]
    c      = relu(trunk . [s, pool])
    danger = sigmoid(danger . c)                                trained on hit_soon (BCE)
    q_i    = pair2 . relu(pair1 . [e_i, c])                      maneuvers x outcome components (masked MSE)

The last shard of each dataset is held out for validation, so validation rows come from unseen matches.
"""

import argparse
import base64
import json
import math
import os
import time

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

p = argparse.ArgumentParser()
p.add_argument("data", nargs="+")
p.add_argument("--out", default="public/models/trained-brain.json")
p.add_argument("--hidden", type=int, default=96)
p.add_argument("--epochs", type=int, default=14)
p.add_argument("--batch", type=int, default=1024)
p.add_argument("--lr", type=float, default=2e-3)
p.add_argument("--wd", type=float, default=1e-4)
p.add_argument("--danger-weight", type=float, default=0.15)
p.add_argument("--device", default="cpu")
p.add_argument("--seed", type=int, default=0)
p.add_argument("--note", default="")
args = p.parse_args()
torch.manual_seed(args.seed)
np.random.seed(args.seed)
torch.set_num_threads(min(16, os.cpu_count() or 4))


def load(dirs):
    metas, train, val = [], [], []
    for d in dirs:
        meta = json.load(open(os.path.join(d, "meta.json")))
        metas.append(meta)
        shards = [s for s in meta["shards"] if s["rows"] > 0]
        for i, s in enumerate(shards):
            a = np.fromfile(os.path.join(d, s["file"]), dtype=np.float32).reshape(-1, meta["row"])
            (val if i == len(shards) - 1 else train).append(a)
    m0 = metas[0]
    for m in metas[1:]:
        for k in ("feature_version", "row", "maneuvers", "components", "self_dim", "opp_dim"):
            assert m[k] == m0[k], f"datasets disagree on {k}"
    return m0, np.concatenate(train), np.concatenate(val)


meta, tr, va = load(args.data)
S, O, MO, M, K = meta["self_dim"], meta["opp_dim"], meta["max_opps"], meta["n_maneuvers"], meta["n_components"]
off = {}
o = 0
for name, n in meta["fields"]:
    off[name] = (o, o + n)
    o += n


def split(a):
    g = lambda k: a[:, off[k][0] : off[k][1]]
    return dict(
        self=g("self"),
        opps=g("opps").reshape(-1, MO, O),
        opp_mask=g("opp_mask"),
        avail=g("avail"),
        q=g("q").reshape(-1, MO, M, K),
        q_mask=g("q_mask").reshape(-1, MO, M),
        hit=g("hit_soon")[:, 0],
    )


TR, VA = split(tr), split(va)
print(f"rows: train {len(tr)}  val {len(va)}  | self {S} opp {O} x{MO}  maneuvers {M}  components {K}")

# Feature normalization (opponent stats over real slots only). A floor on std keeps rare flags sane.
self_mean = TR["self"].mean(0)
self_std = np.maximum(TR["self"].std(0), 0.05)
real = TR["opps"][TR["opp_mask"] > 0]
opp_mean = real.mean(0)
opp_std = np.maximum(real.std(0), 0.05)

# Scale each outcome component to unit variance for the loss so rare ones (kills, died) still get learned.
qm = TR["q_mask"] > 0
comp_std = np.maximum(TR["q"][qm].std(0), 1e-3)
print("outcome mean", np.round(TR["q"][qm].mean(0), 4), "std", np.round(comp_std, 4))
print(f"hit_soon base rate: train {TR['hit'].mean():.3f}  val {VA['hit'].mean():.3f}")


class Net(nn.Module):
    def __init__(self, H):
        super().__init__()
        self.H = H
        self.self1 = nn.Linear(S, H)
        self.opp1 = nn.Linear(O + H, H)
        self.opp2 = nn.Linear(H, H)
        self.trunk = nn.Linear(3 * H, H)
        self.danger = nn.Linear(H, 1)
        self.pair1 = nn.Linear(2 * H, H)
        self.pair2 = nn.Linear(H, M * K)

    def forward(self, s, opps, mask):
        B = s.shape[0]
        s = F.relu(self.self1(s))
        e = F.relu(self.opp2(F.relu(self.opp1(torch.cat([opps, s[:, None, :].expand(B, MO, self.H)], -1)))))
        m = mask[:, :, None]
        n = m.sum(1).clamp(min=1)
        mean = (e * m).sum(1) / n
        mx = torch.where(m > 0, e, torch.full_like(e, -1e9)).max(1).values
        mx = torch.where(mask.sum(1, keepdim=True) > 0, mx, torch.zeros_like(mx))
        c = F.relu(self.trunk(torch.cat([s, mean, mx], -1)))
        d = self.danger(c)[:, 0]
        q = self.pair2(F.relu(self.pair1(torch.cat([e, c[:, None, :].expand(B, MO, self.H)], -1))))
        return d, q.view(B, MO, M, K)


dev = torch.device(args.device)


def tensors(D):
    return dict(
        self=torch.tensor((D["self"] - self_mean) / self_std),
        opps=torch.tensor((D["opps"] - opp_mean) / opp_std) * torch.tensor(D["opp_mask"])[:, :, None],
        opp_mask=torch.tensor(D["opp_mask"]),
        q=torch.tensor(D["q"]),
        q_mask=torch.tensor(D["q_mask"]),
        hit=torch.tensor(D["hit"]),
    )


T, V = tensors(TR), tensors(VA)
cs = torch.tensor(comp_std)
net = Net(args.hidden).to(dev)
nparams = sum(p.numel() for p in net.parameters())
print(f"params {nparams}")
opt = torch.optim.AdamW(net.parameters(), lr=args.lr, weight_decay=args.wd)
N = len(T["self"])
steps = args.epochs * math.ceil(N / args.batch)
sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=args.lr, total_steps=steps, pct_start=0.1)


def losses(D, idx):
    d, q = net(D["self"][idx].to(dev), D["opps"][idx].to(dev), D["opp_mask"][idx].to(dev))
    qm = D["q_mask"][idx].to(dev)
    err = ((q - D["q"][idx].to(dev)) / cs.to(dev)) ** 2
    lq = (err * qm[..., None]).sum() / (qm.sum() * K).clamp(min=1)
    ld = F.binary_cross_entropy_with_logits(d, D["hit"][idx].to(dev))
    return lq, ld, d, q


def auc(score, label):
    order = np.argsort(score)
    ranks = np.empty(len(score))
    ranks[order] = np.arange(1, len(score) + 1)
    pos = label > 0.5
    npos, nneg = pos.sum(), (~pos).sum()
    if npos == 0 or nneg == 0:
        return float("nan")
    return (ranks[pos].sum() - npos * (npos + 1) / 2) / (npos * nneg)


DEFAULT_W = np.array([1.0, -1.0, 0.5, -1.5, 0.0, 0.0], dtype=np.float32)


@torch.no_grad()
def validate(D, Draw):
    net.train(False)
    ds, qs, lqs, lds = [], [], [], []
    for i in range(0, len(D["self"]), 8192):
        idx = torch.arange(i, min(i + 8192, len(D["self"])))
        lq, ld, d, q = losses(D, idx)
        lqs.append(lq.item() * len(idx))
        lds.append(ld.item() * len(idx))
        ds.append(torch.sigmoid(d).cpu().numpy())
        qs.append(q.cpu().numpy())
    net.train(True)
    n = len(D["self"])
    dpred, qpred = np.concatenate(ds), np.concatenate(qs)
    qtrue, qmask = Draw["q"], Draw["q_mask"] > 0
    # R^2 per component over rolled-out pairs.
    r2 = 1 - ((qpred - qtrue) ** 2)[qmask].mean(0) / qtrue[qmask].var(0).clip(1e-9)
    # Decision quality under the default style: the network's pick vs the best and a random rolled-out pair.
    vt = (qtrue * DEFAULT_W).sum(-1)
    vp = (qpred * DEFAULT_W).sum(-1)
    flat_m = qmask.reshape(n, -1)
    vt_f = np.where(flat_m, vt.reshape(n, -1), -np.inf)
    vp_f = np.where(flat_m, vp.reshape(n, -1), -np.inf)
    best = vt_f.max(1)
    pick = vt_f[np.arange(n), vp_f.argmax(1)]
    rand = np.where(flat_m, vt.reshape(n, -1), 0).sum(1) / flat_m.sum(1).clip(1)
    # A fixed reference: "engage" against opponent slot 0.
    eng = np.where(flat_m[:, 0], vt.reshape(n, -1)[:, 0], rand)
    multi = flat_m.sum(1) > 1
    return dict(
        q_loss=sum(lqs) / n,
        danger_bce=sum(lds) / n,
        danger_auc=auc(dpred, Draw["hit"]),
        r2={c: round(float(x), 3) for c, x in zip(meta["components"], r2)},
        regret_hp=float((best - pick)[multi].mean() * 100),
        random_regret_hp=float((best - rand)[multi].mean() * 100),
        engage_regret_hp=float((best - eng)[multi].mean() * 100),
        top1=float((pick == best)[multi].mean()),
    )


t0 = time.time()
for ep in range(args.epochs):
    perm = torch.randperm(N)
    tl = 0.0
    for i in range(0, N, args.batch):
        idx = perm[i : i + args.batch]
        lq, ld, _, _ = losses(T, idx)
        loss = lq + args.danger_weight * ld
        opt.zero_grad()
        loss.backward()
        opt.step()
        sched.step()
        tl += loss.item() * len(idx)
    ev = validate(V, VA)
    print(
        f"epoch {ep + 1:2d}  train {tl / N:.4f}  val q {ev['q_loss']:.4f}  danger auc {ev['danger_auc']:.3f}  "
        f"regret {ev['regret_hp']:.2f} hp (random {ev['random_regret_hp']:.2f}, engage {ev['engage_regret_hp']:.2f})  top1 {ev['top1']:.3f}  [{time.time() - t0:.0f}s]",
        flush=True,
    )

ev = validate(V, VA)
print("final", json.dumps(ev))


def b64(t, dtype):
    a = t.detach().cpu().numpy().astype(np.float16 if dtype == "f16" else np.float32)
    return base64.b64encode(a.tobytes()).decode()


layers = {}
for name in ("self1", "opp1", "opp2", "trunk", "danger", "pair1", "pair2"):
    L = getattr(net, name)
    layers[name] = dict(shape=list(L.weight.shape), w=b64(L.weight, "f16"), b=b64(L.bias, "f16"))
out = dict(
    format="s1-trained-brain",
    version=1,
    feature_version=meta["feature_version"],
    self_dim=S,
    opp_dim=O,
    max_opps=MO,
    maneuvers=meta["maneuvers"],
    components=meta["components"],
    hidden=args.hidden,
    dtype="f16",
    norm=dict(self_mean=self_mean.round(5).tolist(), self_std=self_std.round(5).tolist(), opp_mean=opp_mean.round(5).tolist(), opp_std=opp_std.round(5).tolist()),
    layers=layers,
    info=dict(
        trained_at=time.strftime("%Y-%m-%d %H:%M"),
        datasets=[os.path.basename(d.rstrip("/")) for d in args.data],
        rows=int(N),
        val_rows=int(len(VA["self"])),
        params=int(nparams),
        epochs=args.epochs,
        note=args.note,
        val=ev,
    ),
)
os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
json.dump(out, open(args.out, "w"))
print(f"wrote {args.out} ({os.path.getsize(args.out) / 1024:.0f} KB)")

# Parity vectors: raw inputs and the outputs of the f16-rounded network, for scripts/train/check-parity.ts.
with torch.no_grad():
    for name in layers:
        L = getattr(net, name)
        L.weight.copy_(L.weight.half().float())
        L.bias.copy_(L.bias.half().float())
    net.train(False)
    pick = np.random.RandomState(1).choice(len(VA["self"]), 16, replace=False)
    idx = torch.tensor(pick)
    d, q = net(V["self"][idx].to(dev), V["opps"][idx].to(dev), V["opp_mask"][idx].to(dev))
    parity = dict(
        self=VA["self"][pick].tolist(),
        opps=VA["opps"][pick].reshape(len(pick), -1).tolist(),
        opp_mask=VA["opp_mask"][pick].tolist(),
        danger=torch.sigmoid(d).cpu().numpy().tolist(),
        q=q.cpu().numpy().reshape(len(pick), -1).tolist(),
    )
json.dump(parity, open(args.out.replace(".json", ".parity.json"), "w"))

import { FEATURE_VERSION, MAX_OPPS, MANEUVERS, OPP_DIM, SELF_DIM, type Encoded } from "../../sim/features";
import { COMPONENTS } from "../../sim/rollout";

/**
 * Forward pass of the trained brain, in plain TypeScript (no runtime, no WebGL): about 90k weights, well
 * under a millisecond per decision. The architecture must match scripts/train/train.py:
 *
 *   s      = relu(self1 · norm(self))
 *   e_i    = relu(opp2 · relu(opp1 · [norm(opp_i), s]))         one per living opponent, shared weights
 *   pool   = [mean_i e_i, max_i e_i]
 *   c      = relu(trunk · [s, pool])
 *   danger = sigmoid(danger · c)
 *   q_i    = pair2 · relu(pair1 · [e_i, c])                       maneuvers × outcome components, per opponent
 */

export interface ModelFile {
  format: "s1-trained-brain";
  version: 1;
  feature_version: number;
  self_dim: number;
  opp_dim: number;
  max_opps: number;
  maneuvers: string[];
  components: string[];
  hidden: number;
  dtype: "f16" | "f32";
  norm: { self_mean: number[]; self_std: number[]; opp_mean: number[]; opp_std: number[] };
  layers: Record<string, { shape: [number, number]; w: string; b: string }>;
  /** Free-form training notes shown in the Garage (iteration, rows, held-out metrics). */
  info?: Record<string, unknown>;
}

interface Dense {
  out: number;
  in: number;
  w: Float32Array;
  b: Float32Array;
}

export interface NetOutput {
  danger: number;
  /** [MAX_OPPS][maneuvers][components], row-major. */
  q: Float32Array;
}

function decode(b64: string, dtype: "f16" | "f32"): Float32Array {
  const bin = typeof atob === "function" ? atob(b64) : Buffer.from(b64, "base64").toString("binary");
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  if (dtype === "f32") return new Float32Array(bytes.buffer);
  const h = new Uint16Array(bytes.buffer);
  const out = new Float32Array(h.length);
  for (let i = 0; i < h.length; i++) {
    const x = h[i];
    const sign = x & 0x8000 ? -1 : 1;
    const exp = (x >> 10) & 0x1f;
    const frac = x & 0x3ff;
    out[i] = exp === 0 ? sign * 2 ** -14 * (frac / 1024) : exp === 31 ? (frac ? NaN : sign * Infinity) : sign * 2 ** (exp - 15) * (1 + frac / 1024);
  }
  return out;
}

/** y = W x + b, optionally relu'd, into `y`. W is [out][in] row-major. */
function dense(L: Dense, x: Float32Array, y: Float32Array, relu: boolean) {
  const { w, b } = L;
  const n = L.in;
  for (let o = 0; o < L.out; o++) {
    let acc = b[o];
    const row = o * n;
    for (let i = 0; i < n; i++) acc += w[row + i] * x[i];
    y[o] = relu && acc < 0 ? 0 : acc;
  }
}

export class TrainedNet {
  readonly file: ModelFile;
  readonly hidden: number;
  readonly nOut: number;
  private L: Record<string, Dense> = {};
  private selfMean: Float32Array;
  private selfStd: Float32Array;
  private oppMean: Float32Array;
  private oppStd: Float32Array;

  constructor(file: ModelFile) {
    if (file.format !== "s1-trained-brain") throw new Error("not a trained-brain model file");
    if (file.feature_version !== FEATURE_VERSION || file.self_dim !== SELF_DIM || file.opp_dim !== OPP_DIM || file.max_opps !== MAX_OPPS)
      throw new Error(`model expects feature layout v${file.feature_version} (${file.self_dim}/${file.opp_dim}); this build has v${FEATURE_VERSION} (${SELF_DIM}/${OPP_DIM}). Retrain.`);
    if (file.maneuvers.join() !== MANEUVERS.join() || file.components.join() !== COMPONENTS.join()) throw new Error("model maneuver/component list does not match this build. Retrain.");
    this.file = file;
    this.hidden = file.hidden;
    this.nOut = MANEUVERS.length * COMPONENTS.length;
    for (const [name, l] of Object.entries(file.layers)) {
      this.L[name] = { out: l.shape[0], in: l.shape[1], w: decode(l.w, file.dtype), b: decode(l.b, file.dtype) };
    }
    this.selfMean = Float32Array.from(file.norm.self_mean);
    this.selfStd = Float32Array.from(file.norm.self_std);
    this.oppMean = Float32Array.from(file.norm.opp_mean);
    this.oppStd = Float32Array.from(file.norm.opp_std);
  }

  forward(x: Encoded): NetOutput {
    const H = this.hidden;
    const L = this.L;
    const sIn = new Float32Array(SELF_DIM);
    for (let i = 0; i < SELF_DIM; i++) sIn[i] = (x.self[i] - this.selfMean[i]) / this.selfStd[i];
    const s = new Float32Array(H);
    dense(L.self1, sIn, s, true);

    const n = x.oppIds.length;
    const e: Float32Array[] = [];
    const oIn = new Float32Array(OPP_DIM + H);
    const h1 = new Float32Array(H);
    for (let k = 0; k < n; k++) {
      for (let i = 0; i < OPP_DIM; i++) oIn[i] = (x.opps[k * OPP_DIM + i] - this.oppMean[i]) / this.oppStd[i];
      oIn.set(s, OPP_DIM);
      dense(L.opp1, oIn, h1, true);
      const ek = new Float32Array(H);
      dense(L.opp2, h1, ek, true);
      e.push(ek);
    }
    const tIn = new Float32Array(3 * H);
    tIn.set(s, 0);
    if (n) {
      for (let j = 0; j < H; j++) {
        let sum = 0;
        let mx = -Infinity;
        for (const ek of e) {
          sum += ek[j];
          if (ek[j] > mx) mx = ek[j];
        }
        tIn[H + j] = sum / n;
        tIn[2 * H + j] = mx;
      }
    }
    const c = new Float32Array(H);
    dense(L.trunk, tIn, c, true);
    const d = new Float32Array(1);
    dense(L.danger, c, d, false);

    const q = new Float32Array(MAX_OPPS * this.nOut);
    const pIn = new Float32Array(2 * H);
    const ph = new Float32Array(H);
    const qk = new Float32Array(this.nOut);
    for (let k = 0; k < n; k++) {
      pIn.set(e[k], 0);
      pIn.set(c, H);
      dense(L.pair1, pIn, ph, true);
      dense(L.pair2, ph, qk, false);
      q.set(qk, k * this.nOut);
    }
    return { danger: 1 / (1 + Math.exp(-d[0])), q };
  }
}

/**
 * Checks that the TypeScript forward pass (src/brain/trained/net.ts) reproduces PyTorch's outputs on held-out
 * rows, using the parity file train.py writes next to the model.
 *   npx tsx scripts/train/check-parity.ts data/models/iter0.json
 */
import { readFileSync } from "node:fs";
import { MAX_OPPS } from "../../src/sim/features";
import { TrainedNet, type ModelFile } from "../../src/brain/trained/net";

const path = process.argv[2] ?? "public/models/trained-brain.json";
const net = new TrainedNet(JSON.parse(readFileSync(path, "utf8")) as ModelFile);
const P = JSON.parse(readFileSync(path.replace(".json", ".parity.json"), "utf8")) as { self: number[][]; opps: number[][]; opp_mask: number[][]; danger: number[]; q: number[][] };

let worstD = 0;
let worstQ = 0;
const t0 = performance.now();
P.self.forEach((s, i) => {
  const ids = P.opp_mask[i].map((m, k) => (m > 0 ? `o${k}` : null)).filter((x): x is string => !!x);
  // Rows put real opponents first, so the mask is a prefix.
  const out = net.forward({ self: Float32Array.from(s), opps: Float32Array.from(P.opps[i]), oppMask: Float32Array.from(P.opp_mask[i]), oppIds: ids });
  worstD = Math.max(worstD, Math.abs(out.danger - P.danger[i]));
  const per = P.q[i].length / MAX_OPPS;
  for (let k = 0; k < ids.length; k++) for (let j = 0; j < per; j++) worstQ = Math.max(worstQ, Math.abs(out.q[k * per + j] - P.q[i][k * per + j]));
});
const us = ((performance.now() - t0) / P.self.length) * 1000;
console.log(`${P.self.length} rows: max |Δdanger| ${worstD.toExponential(2)}, max |Δq| ${worstQ.toExponential(2)}, ${us.toFixed(0)} µs/forward (cold)`);
process.exit(worstD < 1e-3 && worstQ < 1e-3 ? 0 : 1);

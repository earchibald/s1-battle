/**
 * Headless match runner: baseline brains only, no renderer, no Jev. Used to tune weapon numbers so
 * matches land in the 30–240 s window, and to test custom builds.
 *
 *   npx tsx scripts/headless.ts [matches] [seed] [garage.json]
 *
 * The optional third argument is a garage export from the designer (an array of builds).
 */
import { readFileSync } from "node:fs";
import { BOT_DEFS, stockBuild } from "../shared/bots/index";
import { normalizeBuild, costOf, derive } from "../shared/build";
import { defFromBuild } from "../shared/logic";
import { quickSim, median } from "../src/sim/quicksim";

const matches = Number(process.argv[2] ?? 20);
const seed0 = Number(process.argv[3] ?? 1);
const garage = process.argv[4];

let defs = Object.values(BOT_DEFS);
if (garage) {
  const raw = JSON.parse(readFileSync(garage, "utf8")) as unknown;
  const list = Array.isArray(raw) ? raw : (raw as { builds?: unknown[] }).builds ?? [];
  defs = list.map((b, i) => defFromBuild(normalizeBuild(b, stockBuild, `slot-${i}`)));
}

for (const d of defs) {
  const c = costOf(d.build);
  const s = derive(d.build);
  console.log(
    `${d.name.padEnd(12)} ${d.kind.padEnd(8)} ${c.total}/50 pts  mass ${s.mass} (${s.weightClass})  hp ${s.hp}  armor ${Math.round(s.armor * 100)}%  speed ${s.maxSpeed}  accel ${s.accel}  turn ${s.turnRate}`,
  );
}
console.log();

const res = await quickSim(defs, {
  matches,
  seed: seed0,
  onMatch(i, r, w) {
    const st = w.result!;
    console.log(
      `match ${i + 1}: ${w.fightTime.toFixed(1)}s  winner=${st.winner} (${st.reason})  ` +
        st.standings.map((s) => `${s.id}:${s.hp}hp/${s.damageDealt}dmg${s.eliminated ? "(" + s.eliminated + ")" : ""}`).join("  "),
    );
  },
});
const L = res.lengths.slice().sort((a, b) => a - b);
console.log("\nwins", res.wins);
console.log("reasons", res.reasons, "eliminations", res.eliminations);
console.log(`length min=${L[0].toFixed(0)} median=${median(L).toFixed(0)} max=${L[L.length - 1].toFixed(0)} mean=${(L.reduce((a, b) => a + b, 0) / L.length).toFixed(0)}`);

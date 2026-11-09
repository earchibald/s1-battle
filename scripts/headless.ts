/**
 * Headless match runner: baseline brains only, no renderer, no Jev. Used to tune weapon numbers so
 * matches land in the 30–240 s window, and to test custom builds.
 *
 *   npx tsx scripts/headless.ts [matches] [seed] [garage.json | kind,kind,kind,kind] [--quiet]
 *
 * The optional third argument is a garage export from the designer (an array of builds), or a
 * comma-separated list of stock weapon kinds (e.g. `saw,spinner,torch,ram`). Default: the stock four.
 */
import { readFileSync } from "node:fs";
import { BOT_DEFS, DEFAULT_ROSTER, stockBuild } from "../shared/bots/index";
import { normalizeBuild, costOf, derive, BUDGET } from "../shared/build";
import { defFromBuild } from "../shared/logic";
import { BOT_KINDS, type BotKind } from "../shared/types";
import { quickSim, median } from "../src/sim/quicksim";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const quiet = process.argv.includes("--quiet");
const matches = Number(args[0] ?? 20);
const seed0 = Number(args[1] ?? 1);
const garage = args[2];

let defs = DEFAULT_ROSTER.map((k) => BOT_DEFS[k]);
if (garage && garage.split(",").every((k) => (BOT_KINDS as string[]).includes(k))) {
  const kinds = garage.split(",") as BotKind[];
  // Same kind twice gets a numbered callsign so the arena can tell them apart.
  defs = kinds.map((k, i) => {
    const b = stockBuild(k);
    const dupes = kinds.slice(0, i).filter((x) => x === k).length;
    if (dupes) b.name = `${b.name} ${["II", "III", "IV"][dupes - 1]}`;
    return defFromBuild({ ...b, id: `slot-${i}` });
  });
} else if (garage) {
  const raw = JSON.parse(readFileSync(garage, "utf8")) as unknown;
  const list = Array.isArray(raw) ? raw : (raw as { builds?: unknown[] }).builds ?? [];
  defs = list.map((b, i) => defFromBuild(normalizeBuild(b, stockBuild, `slot-${i}`)));
}

for (const d of defs) {
  const c = costOf(d.build);
  const s = derive(d.build);
  console.log(
    `${d.name.padEnd(12)} ${d.kind.padEnd(8)} ${c.total}/${BUDGET} pts  mass ${s.mass} (${s.weightClass})  hp ${s.hp}  armor ${Math.round(s.armor * 100)}%  speed ${s.maxSpeed}  accel ${s.accel}  turn ${s.turnRate}  think ${Math.round(s.cadence * 1000)}ms`,
  );
}
console.log();

const res = await quickSim(defs, {
  matches,
  seed: seed0,
  onMatch(i, r, w) {
    if (quiet) return;
    const st = w.result!;
    console.log(
      `match ${i + 1}: ${w.fightTime.toFixed(1)}s  winner=${st.winner} (${st.reason})  ` +
        st.standings.map((s) => `${s.id}:${s.hp}hp/${s.damageDealt}dmg${s.eliminated ? "(" + s.eliminated + ")" : ""}`).join("  "),
    );
  },
});
const L = res.lengths.slice().sort((a, b) => a - b);
console.log("\nwins", res.wins);
const dmg = Object.fromEntries(Object.entries(res.perBot).map(([k, v]) => [k, Math.round(v.damage / res.matches)]));
console.log("avg damage dealt", dmg);
console.log("per bot", Object.fromEntries(Object.entries(res.perBot).map(([k, v]) => [k, `survived ${v.survived} · pitted ${v.pitted} · destroyed ${v.destroyed}`])));
console.log("reasons", res.reasons, "eliminations", res.eliminations);
console.log(`length min=${L[0].toFixed(0)} median=${median(L).toFixed(0)} max=${L[L.length - 1].toFixed(0)} mean=${(L.reduce((a, b) => a + b, 0) / L.length).toFixed(0)}`);

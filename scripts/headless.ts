/**
 * Headless match runner: baseline brains only, no renderer, no Jev. Used to tune weapon numbers so
 * matches land in the 30–240 s window. Usage: npx tsx scripts/headless.ts [matches] [seed]
 */
import { BOT_DEFS } from "../shared/bots/index";
import { World } from "../src/sim/world";
import { sense } from "../src/sim/perception";

const matches = Number(process.argv[2] ?? 20);
const seed0 = Number(process.argv[3] ?? 1);
const DT = 1 / 60;
const CADENCE = 0.4;

const wins: Record<string, number> = {};
const lengths: number[] = [];
const reasons: Record<string, number> = {};
const elims: Record<string, number> = {};

for (let m = 0; m < matches; m++) {
  const order = Object.values(BOT_DEFS);
  // Rotate start slots so no kind always gets the same corner.
  const lineup = order.map((_, i) => order[(i + m) % order.length]);
  const w = new World(lineup, seed0 + m);
  const timers = new Map(w.bots.map((b) => [b.id, Math.random() * CADENCE]));
  let steps = 0;
  while (w.phase !== "ended" && steps < 60 * 400) {
    w.step(DT);
    steps++;
    if (w.phase !== "fighting") continue;
    for (const b of w.bots) {
      if (!b.alive) continue;
      const t = timers.get(b.id)! - DT;
      if (t <= 0) {
        timers.set(b.id, CADENCE);
        b.intent = b.def.baseline(sense(b, w.bots, w.fightTime, w.timeLeft));
      } else timers.set(b.id, t);
    }
    for (const e of w.drainEvents()) {
      if (e.type === "destroyed" || e.type === "pitted") {
        elims[e.type] = (elims[e.type] ?? 0) + 1;
        if (e.type === "pitted") console.log(`   ${w.fightTime.toFixed(1)}s ${e.bot} pitted by ${e.by ?? "itself"} at (${e.at.x.toFixed(1)},${e.at.y.toFixed(1)})`);
      }
    }
  }
  const r = w.result!;
  wins[r.winner ?? "draw"] = (wins[r.winner ?? "draw"] ?? 0) + 1;
  reasons[r.reason] = (reasons[r.reason] ?? 0) + 1;
  lengths.push(w.fightTime);
  console.log(
    `match ${m + 1}: ${w.fightTime.toFixed(1)}s  winner=${r.winner} (${r.reason})  ` +
      r.standings.map((s) => `${s.id}:${s.hp}hp/${s.damageDealt}dmg${s.eliminated ? "(" + s.eliminated + ")" : ""}`).join("  "),
  );
}
lengths.sort((a, b) => a - b);
console.log("\nwins", wins);
console.log("reasons", reasons, "eliminations", elims);
console.log(`length min=${lengths[0].toFixed(0)} median=${lengths[Math.floor(lengths.length / 2)].toFixed(0)} max=${lengths[lengths.length - 1].toFixed(0)} mean=${(lengths.reduce((a, b) => a + b, 0) / lengths.length).toFixed(0)}`);

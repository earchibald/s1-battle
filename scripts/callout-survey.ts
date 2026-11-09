/**
 * Callout survey: how many hits, crits and eliminations a match produces per weapon, and how many comic callouts
 * the callout director lets through. Used to keep callouts rare enough to follow.
 *
 *   npx tsx scripts/callout-survey.ts [seedsPerRoster]
 */
import { stockBuild } from "../shared/bots/index";
import { defFromBuild } from "../shared/logic";
import type { BotKind } from "../shared/types";
import { Driver, baselinePolicy } from "../src/sim/driver";
import type { SimEvent } from "../src/sim/events";
import { CalloutDirector } from "../src/ui/calloutPolicy";

const ROSTERS: BotKind[][] = [
  ["saw", "hammer", "grabber", "flipper"],
  ["spinner", "torch", "ram", "saw"],
  ["hammer", "flipper", "spinner", "torch"],
  ["ram", "grabber", "saw", "spinner"],
];
const seeds = Number(process.argv[2] ?? 8);
const amounts: Record<string, number[]> = {};
const crits: Record<string, number> = {};
const shown: Record<string, number> = {};
let elim = 0;
let seconds = 0;
let matches = 0;
let callouts = 0;
let legacy = 0;
/** The pre-0.2 shout rule from main.ts (random chances approximated with Math.random), with its 0.18 s rate limit. */
function legacyShout(e: SimEvent): boolean {
  if (e.type === "destroyed" || e.type === "pitted") return true;
  if (e.type !== "hit") return false;
  const { weapon: w, amount: a, crit } = e;
  if (w === "saw") return a >= 22 || crit;
  if (w === "hammer" || w === "flip") return true;
  if (w === "landing" || w === "wall") return a >= 14 || crit;
  if (w === "crush") return crit && Math.random() < 0.3;
  if (w === "spinner") return a >= 12 || crit;
  if (w === "torch") return crit || (e.power > 0.3 && Math.random() < 0.12);
  if (w === "ram") return a >= 10 || crit;
  return false;
}
for (const kinds of ROSTERS) {
  const defs = kinds.map((k, i) => defFromBuild({ ...stockBuild(k), id: `slot-${i}` }));
  for (let s = 1; s <= seeds; s++) {
    const d = Driver.start(defs, s, () => baselinePolicy);
    const director = new CalloutDirector();
    let legacyAt = -1;
    while (!d.over) {
      for (const e of d.step()) {
        if (e.type === "hit") {
          (amounts[e.weapon] ??= []).push(e.amount);
          if (e.crit) crits[e.weapon] = (crits[e.weapon] ?? 0) + 1;
        }
        if (e.type === "destroyed" || e.type === "pitted") elim++;
        if (legacyShout(e) && d.world.fightTime - legacyAt >= 0.18) {
          legacy++;
          legacyAt = d.world.fightTime;
        }
        const c = director.pick(e, d.world.fightTime);
        if (c) {
          callouts++;
          shown[c.kind] = (shown[c.kind] ?? 0) + 1;
        }
      }
    }
    seconds += d.world.fightTime;
    matches++;
  }
}
const q = (a: number[], p: number) => a.slice().sort((x, y) => x - y)[Math.floor((a.length - 1) * p)];
const f = (n: number) => (n / matches).toFixed(1).padStart(5);
console.log(`${matches} matches, ${(seconds / matches).toFixed(0)} s average, ${(elim / matches).toFixed(1)} eliminations per match\n`);
console.log("weapon    hits/m crits/m   p50   p90   max  >=14/m >=25/m");
for (const [w, a] of Object.entries(amounts)) {
  console.log(
    `${w.padEnd(8)} ${f(a.length)}   ${f(crits[w] ?? 0)} ${q(a, 0.5).toFixed(1).padStart(5)} ${q(a, 0.9).toFixed(1).padStart(5)} ${Math.max(...a).toFixed(0).padStart(5)}  ${f(a.filter((x) => x >= 14).length)}  ${f(a.filter((x) => x >= 25).length)}`,
  );
}
console.log(`\nold rule: ${f(legacy)} callouts per match (one every ${(seconds / Math.max(1, legacy)).toFixed(1)} s)`);
console.log(`callouts shown: ${f(callouts)} per match (one every ${(seconds / Math.max(1, callouts)).toFixed(1)} s)`);
console.log("by kind", Object.fromEntries(Object.entries(shown).map(([k, v]) => [k, +(v / matches).toFixed(2)])));

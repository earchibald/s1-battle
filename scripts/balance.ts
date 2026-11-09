/**
 * Balance sweep: runs several stock rosters through the headless sim and prints one compact table of wins,
 * average damage and median match length per roster. Use it after touching weapon numbers or stock builds.
 *
 *   npx tsx scripts/balance.ts [matchesPerRoster=36] [seed=1] [roster;roster;...]
 *
 * A roster is a comma-separated list of weapon kinds, e.g. "saw,hammer,grabber,flipper".
 */
import { BOT_DEFS, DEFAULT_ROSTER, stockBuild } from "../shared/bots/index";
import { defFromBuild } from "../shared/logic";
import { BOT_KINDS, type BotKind } from "../shared/types";
import { quickSim, median } from "../src/sim/quicksim";

const matches = Number(process.argv[2] ?? 36);
const seed = Number(process.argv[3] ?? 1);
const rosters: BotKind[][] = (
  process.argv[4]
    ? process.argv[4].split(";")
    : [
        DEFAULT_ROSTER.join(","),
        "spinner,torch,ram,saw",
        "spinner,torch,ram,hammer",
        "spinner,torch,ram,grabber",
        "spinner,torch,ram,flipper",
        "saw,spinner,hammer,ram",
        "torch,grabber,flipper,ram",
      ]
).map((r) => r.split(",").filter((k): k is BotKind => (BOT_KINDS as string[]).includes(k)));

const totals: Record<string, { wins: number; matches: number; damage: number }> = {};
for (const kinds of rosters) {
  const defs = kinds.map((k, i) => {
    const b = stockBuild(k);
    const dupes = kinds.slice(0, i).filter((x) => x === k).length;
    if (dupes) b.name = `${b.name} ${["II", "III", "IV"][dupes - 1]}`;
    return defFromBuild({ ...b, id: `slot-${i}` });
  });
  const res = await quickSim(defs, { matches, seed });
  const cells = defs.map((d) => {
    const w = res.wins[d.name] ?? 0;
    const t = (totals[d.kind] ??= { wins: 0, matches: 0, damage: 0 });
    t.wins += w;
    t.matches += matches;
    t.damage += res.perBot[d.name].damage;
    return `${d.name.padEnd(10)} ${String(w).padStart(2)}w ${String(Math.round(res.perBot[d.name].damage / matches)).padStart(4)}dmg`;
  });
  const judges = res.reasons.judges ?? 0;
  console.log(`${cells.join(" | ")}  | med ${median(res.lengths).toFixed(0)}s${judges ? ` judges ${judges}` : ""}`);
}
console.log("\nwin share by weapon system across all rosters it appeared in (25% is even):");
for (const k of BOT_KINDS) {
  const t = totals[k];
  if (!t) continue;
  console.log(`  ${BOT_DEFS[k].name.padEnd(10)} ${k.padEnd(8)} ${((t.wins / t.matches) * 100).toFixed(0).padStart(3)}%  avg dmg ${Math.round(t.damage / t.matches)}`);
}

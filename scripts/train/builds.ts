/**
 * Random but legal bot builds for training-data generation, so the trained brain sees the whole design space
 * the Garage allows (any weapon, any part levels within budget, any technique set) and not just the stock four.
 */
import { STOCK_ORDER, defaultTechniqueLogic, stockBuild } from "../../shared/bots/index";
import { BUDGET, MAX_LEVEL, PART_KEYS, TECHNIQUES, costOf, techniqueAllowed, type BotBuild } from "../../shared/build";
import type { BotKind } from "../../shared/types";
import type { Rng } from "../../src/sim/math";

export function randomBuild(kind: BotKind, rng: Rng, mutate = 0.75): BotBuild {
  const b = stockBuild(kind);
  if (rng.next() > mutate) return b;
  // Shuffle part levels with random +1/-1 moves that keep the build legal.
  const moves = 6 + Math.floor(rng.next() * 30);
  for (let i = 0; i < moves; i++) {
    const k = rng.pick(PART_KEYS);
    const delta = rng.next() < 0.5 ? -1 : 1;
    const lv = b.levels[k] + delta;
    if (lv < 0 || lv > MAX_LEVEL) continue;
    b.levels[k] = lv;
    if (costOf(b).total > BUDGET) b.levels[k] -= delta;
  }
  // Drop some optional techniques, add some installable ones.
  const optional = b.techniques.filter((m) => m !== "engage");
  for (const m of optional) if (rng.next() < 0.15) b.techniques = b.techniques.filter((x) => x !== m);
  for (const t of TECHNIQUES) {
    if (b.techniques.includes(t.m) || !techniqueAllowed(t.m, kind) || rng.next() > 0.35) continue;
    b.techniques.push(t.m);
    if (costOf(b).total > BUDGET) b.techniques.pop();
    else if (!b.logic.jev.techniques[t.m]) b.logic.jev.techniques[t.m] = defaultTechniqueLogic(t.m, kind);
  }
  return b;
}

/** Four bots; mostly distinct weapons, sometimes a duplicate, like a real roster. */
export function randomRoster(rng: Rng): BotBuild[] {
  const kinds: BotKind[] = [];
  while (kinds.length < 4) {
    const k = rng.pick(STOCK_ORDER);
    if (kinds.includes(k) && rng.next() > 0.12) continue;
    kinds.push(k);
  }
  return kinds.map((k, i) => {
    const b = randomBuild(k, rng);
    const dupes = kinds.slice(0, i).filter((x) => x === k).length;
    if (dupes) b.name = `${b.name} ${["II", "III", "IV"][dupes - 1]}`;
    return { ...b, id: `slot-${i}` };
  });
}

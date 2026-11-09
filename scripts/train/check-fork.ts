/**
 * Sanity check for World.clone / Driver.fork: a fork stepped alongside an independent copy of the original
 * must stay bit-identical, and so must a fork of a fork.
 *   npx tsx scripts/train/check-fork.ts [matches=20]
 */
import { BOT_DEFS, STOCK_ORDER } from "../../shared/bots/index";
import { Driver, baselinePolicy } from "../../src/sim/driver";
import type { World } from "../../src/sim/world";

const matches = Number(process.argv[2] ?? 20);
const snap = (w: World) =>
  JSON.stringify({
    t: w.fightTime,
    phase: w.phase,
    rng: w.rng.state(),
    bots: w.bots.map((b) => [b.p, b.vel, b.knock, b.heading, b.z, b.vz, b.hp, b.alive, b.stun, b.burn, b.heldBy?.id, b.holding?.id, b.weapon.spin, b.weapon.cooldown, b.weapon.hammerPhase, b.intent.maneuver, b.intent.target]),
  });

let checks = 0;
let bad = 0;
for (let m = 0; m < matches; m++) {
  const kinds = [0, 1, 2, 3].map((i) => STOCK_ORDER[(m * 3 + i * 2) % STOCK_ORDER.length]);
  const lineup = kinds.map((k, i) => ({ ...BOT_DEFS[k], name: `${BOT_DEFS[k].name}${i}` }));
  const d = Driver.start(lineup, 1000 + m, () => baselinePolicy, { nudges: true });
  let next = 300;
  while (!d.over) {
    d.step();
    if (d.steps < next) continue;
    next += 397;
    const f = d.fork();
    const g = f.fork();
    const o = d.fork();
    for (let i = 0; i < 240 && !o.over; i++) {
      f.step();
      g.step();
      o.step();
    }
    checks++;
    if (snap(f.world) !== snap(o.world) || snap(g.world) !== snap(o.world)) {
      bad++;
      console.log(`DIVERGED match ${m} step ${d.steps}`);
    }
  }
  // The main line must also match a straight re-run from the seed (forking must not disturb the original).
  const again = Driver.start(lineup, 1000 + m, () => baselinePolicy, { nudges: true });
  while (!again.over) again.step();
  checks++;
  if (snap(again.world) !== snap(d.world)) {
    bad++;
    console.log(`ORIGINAL DISTURBED match ${m}`);
  }
}
console.log(`${checks} fork checks, ${bad} diverged`);
process.exit(bad ? 1 : 0);

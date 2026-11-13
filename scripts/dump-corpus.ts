/**
 * Dump real decision moments from headless baseline matches, for comparing decision backends offline.
 * Each line: { kind, sense, questions, baseline, hitSoon } — hitSoon is ground truth for `in_danger`: did this bot
 * lose health (or get eliminated) within the next HORIZON seconds of sim time. Usage: npx tsx scripts/dump-corpus.ts [out] [matches] [every]
 */
import { writeFileSync } from "node:fs";
import { BOT_DEFS, buildQuestions } from "../shared/bots/index";
import { World } from "../src/sim/world";
import { sense } from "../src/sim/perception";

const out = process.argv[2] ?? "corpus.jsonl";
const matches = Number(process.argv[3] ?? 6);
const every = Number(process.argv[4] ?? 7);
const DT = 1 / 60;
const CADENCE = 0.4;
const HORIZON = 1.5;

const rows: Record<string, unknown>[] = [];
let n = 0;
for (let m = 0; m < matches; m++) {
  const order = Object.values(BOT_DEFS);
  const lineup = order.map((_, i) => order[(i + m) % order.length]);
  const w = new World(lineup, 100 + m);
  const timers = new Map(w.bots.map((b, i) => [b.id, (i / w.bots.length) * CADENCE]));
  const pending: { row: Record<string, unknown>; bot: (typeof w.bots)[number]; hp: number; until: number }[] = [];
  let steps = 0;
  while (w.phase !== "ended" && steps < 60 * 400) {
    w.step(DT);
    steps++;
    if (w.phase !== "fighting") continue;
    for (let i = pending.length - 1; i >= 0; i--) {
      const p = pending[i];
      if (p.bot.hp < p.hp - 0.5 || !p.bot.alive) p.row.hitSoon = true;
      else if (w.fightTime < p.until) continue;
      pending.splice(i, 1);
    }
    for (const b of w.bots) {
      if (!b.alive) continue;
      const t = timers.get(b.id)! - DT;
      if (t > 0) { timers.set(b.id, t); continue; }
      timers.set(b.id, CADENCE);
      const s = sense(b, w.bots, w.fightTime, w.timeLeft);
      b.intent = b.def.baseline(s);
      if (n++ % every === 0) {
        const row = { kind: b.def.kind, sense: s, questions: buildQuestions(b.def, s), baseline: b.intent, hitSoon: false };
        rows.push(row);
        pending.push({ row, bot: b, hp: b.hp, until: w.fightTime + HORIZON });
      }
    }
    w.drainEvents();
  }
}
writeFileSync(out, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
console.log(`${rows.length} moments (${rows.filter((r) => r.hitSoon).length} hit within ${HORIZON}s) from ${matches} matches (${n} decisions) → ${out}`);

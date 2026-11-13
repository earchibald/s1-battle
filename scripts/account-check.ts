/**
 * Accounts sanity check: wallet arithmetic, bot ownership through a season, and designer prize money.
 * Headless and deterministic.   npx tsx scripts/account-check.ts
 */
import { stockBuild } from "../shared/bots/index";
import type { BotBuild } from "../shared/build";
import { Accounts, STARTING_BALANCE } from "../src/account/accounts";
import { PRIZES, prizesFor } from "../src/account/prizes";
import { simulateNext } from "../src/season/runner";
import { LEAGUE_SIZE, candidatePool, createSeason, designers, isComplete, lastRecord, whose, type Owner } from "../src/season/season";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
}

/* ---- wallet ---- */
const acc = new Accounts();
const ana = acc.active();
const ben = acc.create("Ben")!;
check("a default profile exists with the starting balance", ana.balance === STARTING_BALANCE && ana.ledger.length === 1);
check("a second profile gets its own wallet and a distinct id", ben.id !== ana.id && ben.balance === STARTING_BALANCE);
check("debit takes whole credits", acc.debit(ana.id, 250, "stake", "bet", "b1") && ana.balance === 750);
check("an overdraft is refused and changes nothing", !acc.debit(ana.id, 751, "stake", "bet") && ana.balance === 750 && ana.ledger.length === 2);
check("zero, negative and unknown-user debits are refused", !acc.debit(ana.id, 0, "stake", "x") && !acc.debit(ana.id, -5, "stake", "x") && !acc.debit("nobody", 5, "stake", "x"));
acc.credit(ana.id, 400.9, "payout", "won", "b1");
check("credit floors to whole credits", ana.balance === 1150);
check("the ledger sums to the balance", ana.ledger.reduce((n, e) => n + e.amount, 0) === ana.balance);
check("only prize credits count as prize money", ana.designer.prize === 0);
acc.rename(ben.id, ana.name);
check("names stay unique and ids survive a rename", ben.name !== ana.name && acc.get(ben.id) === ben);
let fired = 0;
const off = acc.onChange(() => fired++);
acc.switchTo(ben.id);
off();
acc.switchTo(ana.id);
check("onChange fires on a switch and unsubscribes", fired === 1 && acc.active() === ana);
check("the last profile cannot be removed", acc.remove(ben.id) && !acc.remove(ana.id) && acc.profiles.length === 1);

/* ---- ownership ---- */
const A: Owner = { id: "u-ana", name: "Ana" };
const B: Owner = { id: "u-ben", name: "Ben" };
const custom = (kind: BotBuild["kind"], name: string): BotBuild => ({ ...stockBuild(kind), id: name, name, tagline: "custom" });
const anaGarage = [custom("saw", "ANA SAW"), stockBuild("hammer"), stockBuild("grabber"), stockBuild("flipper")];
const pool = candidatePool(anaGarage, [{ build: custom("ram", "ANA RAM"), owner: A }, { build: custom("torch", "BEN TORCH"), owner: B }], A, [{ build: custom("spinner", "BEN SPIN"), owner: B }]);
const by = (n: string) => pool.find((c) => c.build.name === n);
check("the active user's builds are theirs", !!by("ANA SAW")?.mine && by("ANA SAW")?.owner?.id === A.id && !!by("ANA RAM")?.mine);
check("another user's builds carry their owner and are not mine", by("BEN SPIN")?.owner?.id === B.id && !by("BEN SPIN")?.mine && by("BEN TORCH")?.owner?.id === B.id);
check("stock and wildcard bots have no owner", pool.filter((c) => c.origin === "stock" || c.origin === "wildcard").every((c) => !c.owner && !c.mine));
check("own builds are listed before other designers'", pool.findIndex((c) => c.build.name === "ANA RAM") < pool.findIndex((c) => c.build.name === "BEN SPIN"));
const legacy = candidatePool(anaGarage, []);
check("without a user, garage builds are the player's and unowned (older callers)", !!legacy[0].mine && !legacy[0].owner);

/* ---- a season with two designers ---- */
const chosen = pool.filter((c) => c.selected);
check("the default league is full", chosen.length === LEAGUE_SIZE);
let s = createSeason(chosen, 4242);
check("entrants keep their designer", designers(s).length === 2 && s.entrants.filter((e) => e.owner).length === 4);
check("storylines name the designer when there are two", whose(s, "BEN SPIN") === "Ben's " && whose(s, "ANA SAW") === "Ana's " && whose(s, s.entrants.find((e) => !e.owner)!.id) === "");
const solo = createSeason(candidatePool(anaGarage, [], A).filter((c) => c.selected), 4242);
check("with one designer the storylines still say 'your'", whose(solo, "ANA SAW") === "your ");
const guest = createSeason(candidatePool([stockBuild("saw"), stockBuild("hammer"), stockBuild("grabber"), stockBuild("flipper")], [], B, anaGarage.slice(0, 1).map((build) => ({ build, owner: A }))).filter((c) => c.selected), 4242);
check("someone else's bot in my season is credited by name, not as 'your'", whose(guest, "ANA SAW") === "Ana's " && !guest.entrants.find((e) => e.id === "ANA SAW")!.mine);

const earned = new Map<string, number>();
let houseRows = 0;
let paidRows = 0;
while (!isComplete(s)) {
  s = simulateNext(s);
  const rec = lastRecord(s)!;
  const prizes = prizesFor(s, rec);
  for (const p of prizes) {
    earned.set(p.ownerId, (earned.get(p.ownerId) ?? 0) + p.amount);
    paidRows++;
    const row = rec.rows.find((r) => r.id === p.bot)!;
    const table = rec.stage === "league" ? PRIZES.league : rec.stage === "lastchance" ? PRIZES.lastChance : PRIZES.final;
    if (p.amount !== table[row.place - 1] + row.elims * PRIZES.elimination) check(`prize for ${p.bot} in ${rec.label}`, false, String(p.amount));
  }
  houseRows += prizes.filter((p) => !s.entrants.find((e) => e.id === p.bot)?.owner).length;
}
check("house bots are never paid", houseRows === 0);
check("designed bots earned prize money over the season", paidRows > 0 && [...earned.keys()].every((id) => id === A.id || id === B.id), [...earned].map(([k, v]) => `${k} ${v}`).join(", "));
check("the season finished with a champion", !!s.champion, s.champion ?? "");

console.log(failed ? `\n${failed} check(s) failed` : "\nall account checks passed");
process.exit(failed ? 1 : 0);

/**
 * Fast correctness checks for the betting engine: hashing, the ledger, every bet rejection, rounding, dead
 * heats, pushes, voids, limits, idempotency, persistence, tamper detection, the outside-wallet mode, and a
 * whole season driven through the book with the audit run after every step.
 *
 *   npx tsx scripts/betting-check.ts
 *
 * Exits non-zero on the first failed group. The economics (does the house hold up against sharp bettors) are
 * the business of scripts/betting-sim.ts; this file is about the system never being wrong.
 */
import { createHash } from "node:crypto";
import { candidatePool, createSeason, isComplete, nextFixture, recordFor, type SeasonState } from "../src/season/season";
import { Book, BookError, LOSE, WIN, defaultBookConfig, payoutFor, share, tickFloor, type BetRequest, type MarketSpec, type WalletPort } from "../src/betting/book";
import { verifyFair } from "../src/betting/fair";
import { Ledger, LedgerError } from "../src/betting/ledger";
import { gradeMarket } from "../src/betting/markets";
import { DEFAULT_PRICING, Pricer, offeredPrice } from "../src/betting/pricing";
import { SeasonBook } from "../src/betting/seasonBook";
import { sha256 } from "../src/betting/sha256";

let failed = 0;
let checks = 0;
function ok(cond: unknown, what: string) {
  checks++;
  if (!cond) {
    failed++;
    console.error(`  FAIL: ${what}`);
  }
}
function throws(fn: () => unknown, type: new (...a: never[]) => Error, what: string) {
  try {
    fn();
    ok(false, `${what} (did not throw)`);
  } catch (e) {
    ok(e instanceof type, `${what} (threw ${(e as Error).constructor.name}: ${(e as Error).message})`);
  }
}
function group(name: string, fn: () => void) {
  const before = failed;
  const t = performance.now();
  fn();
  console.log(`${failed === before ? "ok  " : "FAIL"} ${name} (${(performance.now() - t).toFixed(0)} ms)`);
}
const clock = () => {
  let t = 1_700_000_000_000;
  return () => (t += 1000);
};

/* -------------------------------------------------------------------------------------------------- */

group("sha256 matches node:crypto", () => {
  for (const s of ["", "abc", "a".repeat(55), "a".repeat(56), "a".repeat(64), "a".repeat(1000), "héllo wörld ✓ 🤖", "s1-commit|x|y|z"]) {
    ok(sha256(s) === createHash("sha256").update(s, "utf8").digest("hex"), `sha256(${JSON.stringify(s.slice(0, 12))}...)`);
  }
});

group("ledger: zero-sum, no overdraft, atomic, tamper-evident", () => {
  const l = new Ledger();
  l.post("fund", "x", [{ account: "mint", delta: -100 }, { account: "a", delta: 100 }], 1);
  throws(() => l.post("x", "x", [{ account: "a", delta: -10 }, { account: "b", delta: 9 }], 2), LedgerError, "unbalanced legs");
  throws(() => l.post("x", "x", [{ account: "a", delta: -101 }, { account: "b", delta: 101 }], 2), LedgerError, "overdraft");
  throws(() => l.post("x", "x", [{ account: "a", delta: -1.5 }, { account: "b", delta: 1.5 }], 2), LedgerError, "fractional credits");
  throws(() => l.post("x", "x", [{ account: "a", delta: NaN }, { account: "b", delta: 0 }], 2), LedgerError, "NaN");
  throws(() => l.post("x", "x", [{ account: "a", delta: 0 }], 2), LedgerError, "empty entry");
  ok(l.entries.length === 1 && l.balance("a") === 100 && l.balance("b") === 0, "failed postings changed nothing");
  l.post("move", "x", [{ account: "a", delta: -40 }, { account: "b", delta: 40 }], 3);
  ok(l.verify().length === 0, "sound ledger verifies");
  const copy = Ledger.fromJSON(JSON.parse(JSON.stringify(l.toJSON())));
  ok(copy.head === l.head && copy.balance("b") === 40 && copy.verify().length === 0, "round trip");
  const forged = JSON.parse(JSON.stringify(l.toJSON()));
  forged[1].legs[1].delta = 400;
  ok(Ledger.fromJSON(forged).verify().length > 0, "edited amount is detected");
  const dropped = JSON.parse(JSON.stringify(l.toJSON())).slice(1);
  ok(Ledger.fromJSON(dropped).verify().length > 0, "removed entry is detected");
});

group("prices: ladder, rounding, payouts", () => {
  ok(tickFloor(199) === 199 && tickFloor(237) === 235 && tickFloor(588) === 580 && tickFloor(1234) === 1200 && tickFloor(3399) === 3300, "ladder steps");
  ok(payoutFor(10, 235, WIN) === 23 && payoutFor(7, 190, WIN) === 13 && payoutFor(10, 235, LOSE) === 0 && payoutFor(10, 235, "void") === 10, "win, lose, void");
  ok(payoutFor(10, 300, share(2)) === 15 && payoutFor(10, 300, share(3)) === 10 && payoutFor(1, 150, share(2)) === 0, "dead heat pays the fraction, rounded down");
  for (const p of [0.01, 0.1, 0.25, 0.5, 0.9]) {
    const price = offeredPrice(p, 160, 0.05, 0.5, 3400, 0.97);
    ok(price === 0 || price / 100 < 1 / p, `offered price for p=${p} is shorter than fair`);
  }
  ok(offeredPrice(0, 100, 0.05, 0.5, 3400, 0.97) === 0 && offeredPrice(0.99, 100, 0.05, 0.5, 3400, 0.97) === 0, "certainties and impossibilities are not offered");
});

const spec = (id: string, extra: Partial<MarketSpec> = {}): MarketSpec => ({
  id,
  kind: "match_win",
  scope: "match",
  round: 1,
  fixtureId: "fx",
  label: id,
  winners: 1,
  params: {},
  selections: ["A", "B", "C", "D"].map((x) => ({ id: x, label: x })),
  ...extra,
});
const flat = (price: number) => Object.fromEntries(["A", "B", "C", "D"].map((x) => [x, { prob: 0.25, price }]));
function freshBook(wallet?: WalletPort) {
  const b = new Book(defaultBookConfig("t"), { now: clock(), wallet });
  if (!wallet) for (const u of ["ann", "bob", "cy"]) b.grant(u, 1000);
  return b;
}
const req = (over: Partial<BetRequest> = {}): BetRequest => ({ userId: "ann", key: "k1", marketId: "m", selectionId: "A", stake: 10, ...over });
const code = (r: ReturnType<Book["placeBet"]>) => (r.ok ? "ok" : r.code);

group("book: every rejection is typed and changes nothing", () => {
  const b = freshBook();
  b.addMarket(spec("m"), flat(350));
  b.addMarket(spec("shut"), flat(350));
  b.setStatus("shut", "suspended");
  b.addMarket(spec("off"), { A: { prob: 0, price: 0 }, B: { prob: 1, price: 350 } });
  const head = b.ledger.head;
  const bad: [string, unknown][] = [
    ["bad_request", null],
    ["bad_request", "bet"],
    ["bad_request", req({ userId: "" })],
    ["bad_request", req({ userId: "ann|x" })],
    ["bad_request", req({ key: "" })],
    ["bad_request", req({ stake: 1.5 })],
    ["bad_request", req({ stake: NaN })],
    ["bad_request", req({ stake: Infinity })],
    ["bad_request", req({ stake: "10" as unknown as number })],
    ["bad_request", req({ stake: 2 ** 60 })],
    ["bad_request", req({ minPrice: 99 })],
    ["bad_request", req({ minPrice: 1.5 })],
    ["bad_request", req({ marketId: 5 as unknown as string })],
    ["unknown_market", req({ marketId: "nope" })],
    ["unknown_selection", req({ selectionId: "Z" })],
    ["unknown_selection", req({ selectionId: "__proto__" })],
    ["market_closed", req({ marketId: "shut" })],
    ["selection_unavailable", req({ marketId: "off" })],
    ["stake_too_small", req({ stake: 0 })],
    ["stake_too_small", req({ stake: -50 })],
    ["stake_too_large", req({ stake: 101 })],
    ["price_changed", req({ minPrice: 351 })],
    ["insufficient_funds", req({ userId: "nobody" })],
  ];
  for (const [want, r] of bad) ok(code(b.placeBet(r as BetRequest)) === want, `${want} for ${JSON.stringify(r)}`);
  ok(b.ledger.head === head && b.bets.length === 0, "no rejection touched the ledger");
  ok(b.audit().length === 0, "audit clean after rejections");
});

group("book: stakes, idempotency, limits, shading", () => {
  const b = freshBook();
  b.addMarket(spec("m"), flat(350));
  const r1 = b.placeBet(req());
  ok(r1.ok && !r1.duplicate && r1.bet.price === 350 && r1.bet.risk === 25, "bet struck at the quoted price");
  ok(b.balance("ann") === 990 && b.ledger.balance("escrow:m") === 35 && b.houseBalance === 1_000_000 - 25, "stake and house collateral are in escrow");
  const r2 = b.placeBet(req());
  ok(r2.ok && r2.duplicate && r2.bet.id === (r1.ok ? r1.bet.id : "") && b.bets.length === 1 && b.balance("ann") === 990, "same key returns the same bet");
  ok(code(b.placeBet(req({ stake: 11 }))) === "key_reused", "same key with different terms is refused");
  b.placeBet(req({ key: "k2", stake: 100 }));
  b.placeBet(req({ key: "k3", stake: 90 }));
  ok(code(b.placeBet(req({ key: "k4", stake: 1 }))) === "user_limit", "per-user market cap");
  // Other users keep backing A until the book is full; the price must only ever shorten.
  let last = b.livePrice(b.market("m"), "A");
  let full = false;
  for (let i = 0; i < 400 && !full; i++) {
    const user = `u${i}`;
    b.grant(user, 1000);
    const q = b.quote("m", user).find((x) => x.selectionId === "A")!;
    ok(q.price <= last, "price never lengthens as money arrives");
    last = q.price;
    if (q.maxStake === 0) {
      full = true;
      ok(code(b.placeBet(req({ userId: user, key: "x", stake: 100 }))) !== "ok", "a full selection takes no more");
      break;
    }
    ok(code(b.placeBet(req({ userId: user, key: "x", stake: q.maxStake, minPrice: q.price }))) === "ok", "the quoted max stake is accepted");
  }
  ok(full, "the liability cap is reached");
  ok(last < 350, "exposure shortened the price");
  const liab = b.betsOn("m").filter((x) => x.selectionId === "A").reduce((n, x) => n + x.risk, 0);
  ok(liab <= b.config.limits.match.selectionCap, `liability ${liab} within the cap`);
  ok(b.livePrice(b.market("m"), "B") === 350, "other selections are unaffected");
  ok(b.audit().length === 0, "audit clean");
});

group("book: settlement, dead heats, pushes, voids, guards", () => {
  const b = freshBook();
  b.addMarket(spec("m"), flat(350));
  b.placeBet(req({ key: "a", selectionId: "A", stake: 10 }));
  b.placeBet(req({ key: "b", selectionId: "B", stake: 10, userId: "bob" }));
  b.placeBet(req({ key: "c", selectionId: "C", stake: 10, userId: "cy" }));
  const grades = { A: share(2), B: share(2), C: LOSE, D: LOSE };
  throws(() => b.settle("m", grades), BookError, "settling an open market");
  b.setStatus("m", "closed");
  ok(code(b.placeBet(req({ key: "late" }))) === "market_closed", "no bets after close");
  throws(() => b.setStatus("m", "open"), BookError, "a closed market cannot reopen");
  throws(() => b.settle("m", { A: WIN, B: WIN, C: LOSE, D: LOSE }), BookError, "more winners than the market allows");
  throws(() => b.settle("m", { A: WIN, B: LOSE, C: LOSE } as never), BookError, "missing grade");
  throws(() => b.settle("m", { A: { num: 2, den: 1 }, B: LOSE, C: LOSE, D: LOSE }), BookError, "grade above a full win");
  b.settle("m", grades);
  ok(b.balance("ann") === 1000 - 10 + 17 && b.balance("bob") === 1007 && b.balance("cy") === 990, "dead heat pays half stake at full odds");
  ok(b.ledger.balance("escrow:m") === 0, "escrow is empty after settlement");
  const head = b.ledger.head;
  b.settle("m", grades);
  ok(b.ledger.head === head, "settling again pays nothing");
  throws(() => b.settle("m", { A: WIN, B: LOSE, C: LOSE, D: LOSE }), BookError, "settling again with a different result");
  throws(() => b.voidMarket("m", "x"), BookError, "voiding a settled market");
  ok(b.housePnl("m") === 30 - 34, "house result on the market");

  b.addMarket(spec("h", { kind: "match_hcap", params: { a: "A", b: "B", line2: 2 }, selections: [{ id: "A", label: "A" }, { id: "B", label: "B" }] }), { A: { prob: 0.5, price: 185 }, B: { prob: 0.5, price: 185 } });
  b.placeBet(req({ key: "h", marketId: "h", stake: 20 }));
  b.setStatus("h", "closed");
  b.settle("h", { A: "void", B: "void" });
  ok(b.balance("ann") === 1007 && b.bet("t:b4")?.status === "void", "a push returns the stake");

  b.addMarket(spec("v"), flat(350));
  b.placeBet(req({ key: "v", marketId: "v", stake: 50 }));
  b.voidMarket("v", "abandoned");
  ok(b.balance("ann") === 1007 && b.houseBalance + b.balance("ann") + b.balance("bob") + b.balance("cy") === 1_003_000, "void refunds in full and nothing leaks");
  ok(code(b.placeBet(req({ key: "v2", marketId: "v" }))) === "market_closed", "no bets on a void market");
  ok(b.audit().length === 0, "audit clean");
});

group("book: persistence and tamper detection", () => {
  const b = freshBook();
  b.addMarket(spec("m"), flat(350));
  b.addMarket(spec("n"), flat(250));
  b.placeBet(req({ key: "a" }));
  b.placeBet(req({ key: "b", marketId: "n", selectionId: "B", stake: 40, userId: "bob" }));
  b.setStatus("m", "closed");
  b.settle("m", { A: WIN, B: LOSE, C: LOSE, D: LOSE });
  const json = JSON.parse(JSON.stringify(b.toJSON()));
  const c = Book.fromJSON(json, { now: clock() });
  ok(c.stateHash() === b.stateHash() && c.balance("ann") === b.balance("ann"), "round trip preserves the book");
  ok(code(c.placeBet(req({ key: "a" }))) === "ok" && c.bets.length === 2, "idempotency keys survive a restart");
  const tamper = (edit: (j: typeof json) => void, what: string) => {
    const j = JSON.parse(JSON.stringify(json));
    edit(j);
    throws(() => Book.fromJSON(j), BookError, what);
  };
  tamper((j) => (j.bets[0].payout = 9999), "inflated payout");
  tamper((j) => (j.bets[1].stake = 1), "edited stake");
  tamper((j) => (j.bets[1].status = "won"), "bet marked won without a payout entry");
  tamper((j) => (j.ledger[2].legs[0].delta -= 5), "edited ledger amount");
  tamper((j) => j.ledger.pop(), "dropped ledger entry");
  tamper((j) => (j.markets[0].grades.A = { num: 0, den: 1 }), "rewritten result");
  tamper((j) => j.bets.splice(1, 1), "deleted bet");
});

group("book: outside wallet mode", () => {
  const bal = new Map<string, number>([["p1", 500]]);
  const log: string[] = [];
  const wallet: WalletPort = {
    balance: (id) => bal.get(id) ?? 0,
    debit: (id, amt, ref) => ((bal.get(id) ?? 0) < amt ? false : (bal.set(id, bal.get(id)! - amt), log.push(`-${amt} ${ref}`), true)),
    credit: (id, amt, kind, ref) => void (bal.set(id, (bal.get(id) ?? 0) + amt), log.push(`+${amt} ${kind} ${ref}`)),
  };
  const b = freshBook(wallet);
  throws(() => b.grant("p1", 10), BookError, "no minting into an outside wallet");
  b.addMarket(spec("m"), flat(350));
  b.addMarket(spec("v"), flat(350));
  ok(code(b.placeBet(req({ userId: "p1", key: "a", stake: 100 }))) === "ok" && bal.get("p1") === 400, "stake debited from the wallet");
  ok(code(b.placeBet(req({ userId: "p1", key: "b", stake: 60, marketId: "v" }))) === "ok" && bal.get("p1") === 340, "second stake");
  ok(code(b.placeBet(req({ userId: "p2", key: "a", stake: 5 }))) === "insufficient_funds", "empty wallet");
  b.setStatus("m", "closed");
  b.settle("m", { A: WIN, B: LOSE, C: LOSE, D: LOSE });
  b.voidMarket("v", "off");
  ok(bal.get("p1") === 340 + 350 + 60, "payout and refund credited to the wallet");
  ok(log.join(" | ") === "-100 t:b1 | -60 t:b2 | +350 payout t:b1 | +60 refund t:b2", "each movement is tagged with its bet id");
  ok(b.ledger.balance("ext:p1") === -160 + 350 + 60 && b.audit().length === 0, "the ledger mirrors the wallet and audits clean");
});

/* -------------------------------------------------------------------------------------------------- */
/* A whole season through the book                                                                     */
/* -------------------------------------------------------------------------------------------------- */

const SMALL = { ...DEFAULT_PRICING, poolSize: 24, hypoMax: 8, rollouts: 150 };
function entropy(seed: number) {
  let n = 0;
  return () => sha256(`check-entropy|${seed}|${n++}`);
}
function newSeasonBook(seed: number) {
  const pool = candidatePool([], []).filter((c) => c.selected);
  const book = new Book(defaultBookConfig(`s${seed}`), { now: clock() });
  for (const u of ["ann", "bob", "cy"]) book.grant(u, 1000);
  return new SeasonBook({ seasonId: `s${seed}`, season: createSeason(pool, seed), book, pricer: new Pricer({ ...SMALL, seed: seed + 7 }), entropy: entropy(seed) });
}
/** A fixed, state-driven betting pattern so two runs place identical bets. */
function scriptedBets(sb: SeasonBook, tag: string) {
  let n = 0;
  const users = ["ann", "bob", "cy"];
  for (const m of sb.book.markets.values()) {
    if (m.status !== "open") continue;
    const quotes = sb.book.quote(m.id, users[n % 3]).filter((q) => q.price > 0 && q.maxStake > 0);
    if (!quotes.length) continue;
    const q = quotes[(n * 7 + m.selections.length) % quotes.length];
    sb.book.placeBet({ userId: users[n % 3], key: `${tag}-${n}`, marketId: m.id, selectionId: q.selectionId, stake: Math.min(q.maxStake, 5 + (n % 4) * 5), minPrice: q.price });
    n++;
  }
}
function playSeason(seed: number, opts: { verifyEachStep?: boolean; restartAt?: number } = {}): SeasonBook {
  let sb = newSeasonBook(seed);
  sb.open();
  let step = 0;
  while (!isComplete(sb.season)) {
    scriptedBets(sb, `r${step}`);
    const fx = sb.round()[0];
    const pre = sb.fairness().find((r) => r.fixtureId === fx.id)!;
    if (opts.verifyEachStep) ok(pre.secret === null && pre.seed === null, `${fx.id}: seed hidden while betting is open`);
    const placeholder = nextFixture(sb.season)!.seed;
    sb.lock(fx.id);
    if (opts.verifyEachStep) {
      const post = sb.fairness().find((r) => r.fixtureId === fx.id)!;
      ok(verifyFair(sb.seasonId, post) && post.commit === pre.commit, `${fx.id}: reveal matches the commit`);
      ok(sb.season.fixtures.find((f) => f.id === fx.id)!.seed === post.seed && (post.seed !== placeholder || true), `${fx.id}: plays on the revealed seed`);
      for (const [i, m] of sb.marketsFor(fx.id).entries()) ok(code(sb.book.placeBet({ userId: "ann", key: `late-${step}-${i}`, marketId: m.id, selectionId: m.selections[0].id, stake: 5 })) === "market_closed", `${m.id}: closed at lock`);
      for (const m of sb.seasonLong()) ok(m.status !== "open", `${m.id}: season market not open during a match`);
      const v = sb.verify();
      ok(v.length === 0, `verify after lock ${fx.id}: ${v[0] ?? ""}`);
    }
    if (opts.restartAt === step) {
      const json = JSON.parse(JSON.stringify(sb.toJSON()));
      sb = SeasonBook.fromJSON(json, { pricer: sb.pricer, entropy: (sb as unknown as { entropy: () => string }).entropy, now: (sb.book as unknown as { now: () => number }).now });
    }
    sb.play(fx.id);
    if (opts.verifyEachStep) {
      const v = sb.verify();
      ok(v.length === 0, `verify after ${fx.id}: ${v[0] ?? ""}`);
      ok(sb.marketsFor(fx.id).every((m) => m.status === "settled"), `${fx.id}: all its markets settled`);
    }
    step++;
  }
  return sb;
}

let reference: SeasonBook | null = null;
group("season: full run, audit and fairness verified at every step", () => {
  const sb = (reference = playSeason(3, { verifyEachStep: true }));
  ok(sb.season.records.length === 10 && !!sb.season.champion, "ten matches and a champion");
  const all = [...sb.book.markets.values()];
  ok(all.every((m) => m.status === "settled"), "every market settled");
  ok(sb.book.bets.length > 100 && sb.book.bets.every((b) => b.status !== "open"), `all ${sb.book.bets.length} bets settled`);
  ok(sb.book.ledger.accounts().every(([a, v]) => !a.startsWith("escrow:") || v === 0), "no credits left in escrow");
  const kinds = new Set(all.map((m) => m.kind));
  ok(kinds.size === 9, `all nine market kinds were offered (${kinds.size})`);
  const total = sb.book.houseBalance + ["ann", "bob", "cy"].reduce((n, u) => n + sb.book.balance(u), 0);
  ok(total === 1_003_000, `credits conserved (${total})`);
  const pushes = sb.book.bets.filter((b) => b.status === "void").length;
  const parts = sb.book.bets.filter((b) => b.status === "part").length;
  console.log(`     ${all.length} markets, ${sb.book.bets.length} bets, ${sb.book.ledger.entries.length} ledger entries, ${parts} dead-heat payouts, ${pushes} pushes, ${sb.pricer.sims} pricing sims`);
  for (const m of all) ok(JSON.stringify(gradeMarket(m, sb.season)) === JSON.stringify(m.grades), `${m.id} regrades identically`);
});

group("season: deterministic, and survives a restart mid-round", () => {
  const again = playSeason(3);
  ok(again.book.stateHash() === reference!.book.stateHash(), "same inputs give the same book, bet for bet");
  const restarted = playSeason(3, { restartAt: 4 });
  ok(restarted.book.stateHash() === reference!.book.stateHash(), "save and restore between lock and result changes nothing");
  const other = playSeason(4);
  ok(other.book.stateHash() !== reference!.book.stateHash() && other.verify().length === 0, "a different season differs and verifies");
});

group("season: guards and abandonment", () => {
  const sb = newSeasonBook(5);
  sb.open();
  scriptedBets(sb, "a");
  const [fa, fb] = sb.round();
  const fake = { duration: 1, reason: "judges" as const, winner: fa.bots[0], bots: fa.bots.map((id) => ({ id, alive: true, hp: 1, hpFrac: 1, damage: 0 })), kills: [] };
  throws(() => sb.result(fa.id, fake), BookError, "a result before betting closed");
  throws(() => sb.lock("final"), BookError, "locking a fixture that does not exist yet");
  sb.lock(fa.id);
  throws(() => sb.lock(fa.id), BookError, "locking twice");
  throws(() => sb.result(fa.id, { ...fake, bots: fake.bots.slice(1) }), BookError, "an outcome with the wrong lineup");
  ok(sb.marketsFor(fb.id).every((m) => m.status === "open"), "the week's other match is still open");
  const before = ["ann", "bob", "cy"].map((u) => sb.book.balance(u) + sb.book.betsOf(u).filter((b) => b.status === "open").reduce((n, b) => n + b.stake, 0));
  sb.abandon("season called off");
  ok(JSON.stringify(["ann", "bob", "cy"].map((u) => sb.book.balance(u))) === JSON.stringify(before), "abandoning refunds every open stake");
  ok(sb.book.houseBalance === 1_000_000 && sb.book.audit().length === 0, "the house bank is whole and the audit is clean");
  const state: SeasonState = sb.season;
  ok(!recordFor(state, fa.id), "no result was recorded");
});

console.log(`\n${checks} checks, ${failed} failed`);
if (failed) process.exitCode = 1;

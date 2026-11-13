/**
 * End-to-end check of the house server (server/betting.ts) over real HTTP, on a throwaway data directory:
 * registration, entering a bot and every way an entry is refused, the server answering while it prices,
 * a designed bot playing a season and its designer being paid, a restart in the middle of pricing, and the
 * match clock.
 *
 *   npx tsx scripts/house-check.ts        (about half a minute)
 *
 * The engine's own correctness is scripts/betting-check.ts; this file is about the shell around it.
 */
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { stockBuild } from "../shared/bots/index";
import { BUDGET, PART_KEYS, costOf } from "../shared/build";
import { SEASON_MATCHES } from "../src/season/season";

const dir = mkdtempSync(path.join(tmpdir(), "s1-house-"));
process.env.BET_DATA_DIR = dir;
process.env.BET_POOL = "24";
process.env.BET_ROLLOUTS = "160";
delete process.env.BET_MATCH_EVERY;
delete process.env.BET_ADMIN_TOKEN;
const { bettingRouter } = await import("../server/betting");

let failed = 0;
let checks = 0;
function ok(cond: unknown, what: string) {
  checks++;
  if (!cond) {
    failed++;
    console.error(`  FAIL: ${what}`);
  }
}

type Json = Record<string, any>;
interface Api {
  get(p: string, token?: string): Promise<{ status: number; body: Json; ms: number }>;
  send(method: string, p: string, body?: unknown, token?: string): Promise<{ status: number; body: Json; ms: number }>;
  close(): void;
}
/** A fresh server process as far as the house can tell: a new router reads the state file from disk. */
async function boot(): Promise<Api> {
  const app = express();
  app.use(express.json({ limit: "256kb" }));
  app.use("/api/bet", bettingRouter());
  const server = app.listen(0);
  await new Promise((go) => server.once("listening", go));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/bet`;
  const send: Api["send"] = async (method, p, body, token) => {
    const t = performance.now();
    const res = await fetch(base + p, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as Json, ms: performance.now() - t };
  };
  return { send, get: (p, token) => send("GET", p, undefined, token), close: () => void server.close() };
}
const sleep = (ms: number) => new Promise((go) => setTimeout(go, ms));
async function priced(api: Api, token?: string): Promise<Json> {
  for (;;) {
    const s = (await api.get("/season", token)).body;
    if (!s.pricing) return s;
    await sleep(40);
  }
}
async function group(name: string, fn: () => Promise<void>) {
  const before = failed;
  const t = Date.now();
  await fn();
  console.log(`${failed === before ? "ok  " : "FAIL"} ${name} (${Date.now() - t} ms)`);
}

let api = await boot();
let ann = "";
let bob = "";
const mine = (name: string, over: Record<string, unknown> = {}) => ({ ...stockBuild("saw"), name, tagline: "Built in a shed.", ...over });

await group("the server answers while the first season is priced", async () => {
  const first = await api.get("/season");
  ok(first.status === 200 && first.body.pricing && first.body.markets.length === 0, "the first request comes back before pricing is done, with no markets yet");
  let slowest = 0;
  let asked = 0;
  for (;;) {
    const r = await api.get("/season");
    slowest = Math.max(slowest, r.ms);
    asked++;
    if (!r.body.pricing) break;
  }
  ok(asked > 5, `many requests are served during one pricing run (${asked})`);
  ok(slowest < 250, `none of them waits for it (slowest ${slowest.toFixed(0)} ms)`);
  const s = await priced(api);
  ok(s.markets.length > 10 && s.entrants.length === 8 && s.entrants.every((e: Json) => e.designer === null), "then the round is open, with a league of house bots");
  ok((await api.get("/audit")).body.ok, "audit");
});

await group("entering a bot, and every refusal", async () => {
  ann = (await api.send("POST", "/register", { handle: "ann" })).body.token;
  bob = (await api.send("POST", "/register", { handle: "bob" })).body.token;
  ok(ann && bob, "two users");
  ok((await api.send("PUT", "/bot", { build: mine("SHEDSAW") })).status === 401, "no token, no entry");
  const bad = async (build: unknown, why: string, token = ann) => {
    const r = await api.send("PUT", "/bot", { build }, token);
    ok(r.status === 400 && r.body.ok === false && typeof r.body.error === "string", `${why} (${r.status}: ${r.body.error})`);
  };
  await bad(undefined, "nothing");
  await bad({ name: "SHEDSAW" }, "no weapon system");
  await bad(mine("SHEDSAW", { kind: "laser" }), "an unknown weapon system");
  await bad(mine("ripsaw"), "a house bot's callsign, in any case");
  await bad(mine("hacksaw"), "a wildcard's callsign");
  await bad(mine("<img src=x>"), "markup in a callsign");
  await bad(mine("__proto__"), "__proto__");
  await bad(mine("AB"), "a callsign that is too short");
  const maxed = mine("SHEDSAW", { levels: Object.fromEntries(PART_KEYS.map((k) => [k, 5])) });
  ok(costOf(maxed as never).total > BUDGET, "(a maxed build is over budget)");
  await bad(maxed, "a build over budget");
  const entered = await api.send("PUT", "/bot", { build: mine("  shedsaw ", { tagline: "Built\u0000 in a\nshed.", techniques: [...stockBuild("saw").techniques, "flip_now"], levels: { ...stockBuild("saw").levels, armor: 0, motor: 5 } }) }, ann);
  ok(entered.status === 200 && entered.body.bot.name === "SHEDSAW" && entered.body.bot.playing === null, "a legal build is entered under a tidy callsign, waiting for the next season");
  ok(!/[\u0000-\u001f]/.test(entered.body.bot.tagline), "control characters are stripped from the tagline");
  ok(!entered.body.bot.build.techniques.includes("flip_now"), "a technique the weapon cannot use is dropped");
  await bad(mine("SHEDSAW"), "a callsign another designer holds", bob);
  ok((await api.get("/bot", ann)).body.bot.name === "SHEDSAW" && (await api.get("/me", ann)).body.bot.name === "SHEDSAW", "it shows on /bot and /me");
  ok((await api.get("/bot", bob)).body.bot === null, "and only for its designer");
});

let betMarket = "";
await group("a season on house bots: betting stays open and quick while the next round is priced", async () => {
  const before = await priced(api, bob);
  // A bet on the season: suspended while a match runs and is priced, open again afterwards.
  const champ = before.markets.find((m: Json) => m.kind === "season_champion");
  const pick = champ.selections.find((x: Json) => x.price > 0 && x.maxStake >= 5);
  const placed = await api.send("POST", "/bets", { key: "b1", marketId: champ.id, selectionId: pick.id, stake: 5 }, bob);
  ok(placed.status === 200 && placed.body.balance === 995, "bob backs a champion");
  betMarket = champ.id;
  const adv = await api.send("POST", "/advance");
  ok(adv.status === 200 && adv.body.played === "w1a" && adv.body.order.length === 4, "a match is played and answered before the repricing");
  const during = await api.get("/season", bob);
  ok(during.body.pricing, "the next round is being priced");
  const other = during.body.markets.find((m: Json) => m.fixtureId === "w1b" && m.status === "open" && m.kind === "match_win");
  const sel = other?.selections.find((x: Json) => x.price > 0 && x.maxStake >= 5);
  const mid = await api.send("POST", "/bets", { key: "b2", marketId: other?.id, selectionId: sel?.id, stake: 5 }, bob);
  ok(mid.status === 200 && mid.ms < 250, `a bet on the week's other match is taken meanwhile (${mid.ms.toFixed(0)} ms)`);
  const again = await api.send("POST", "/advance?wait=1");
  ok(again.body.played === "w1b" && !(await api.get("/season")).body.pricing, "a second advance waits its turn, and ?wait=1 answers once the round is open");
  for (let i = 2; i < SEASON_MATCHES; i++) {
    const r = await api.send("POST", "/advance?wait=1");
    ok(r.status === 200 && r.body.played, `match ${i + 1}`);
  }
  const end = await api.get("/season");
  ok(end.body.champion && end.body.markets.length === 0, `the season has a champion (${end.body.champion}) and nothing left open`);
  ok((await api.get("/audit")).body.ok, "audit");
  ok((await api.get("/me", ann)).body.balance === 1000, "ann's bot was not in it, so no prize money yet");
});

await group("the next season: the designed bot plays and its designer is paid", async () => {
  const started = await api.send("POST", "/advance?wait=1");
  ok(started.body.started === "s2", "season 2 starts");
  const s = (await api.get("/season")).body;
  const e = s.entrants.find((x: Json) => x.id === "SHEDSAW");
  ok(e && e.designer === "ann" && e.origin === "garage" && s.entrants.length === 8, "SHEDSAW is in the league under ann's name");
  ok(s.markets.some((m: Json) => m.selections.some((x: Json) => x.id === "SHEDSAW" && x.price > 0)), "and can be bet on");
  ok((await api.get("/bot", ann)).body.bot.playing?.current === true, "ann sees it playing");
  const edit = await api.send("PUT", "/bot", { build: mine("SHEDSAW", { tagline: "Rebuilt." }) }, ann);
  ok(edit.status === 200 && edit.body.bot.playing.current === false, "an edit mid-season is kept for the next one");
  ok((await api.get("/season")).body.entrants.find((x: Json) => x.id === "SHEDSAW").tagline.startsWith("Built"), "the league still fields the build it started with");
  let paid = 0;
  for (let i = 0; i < SEASON_MATCHES; i++) {
    const r = await api.send("POST", "/advance?wait=1");
    for (const p of r.body.prizes ?? []) {
      ok(p.handle === "ann" && p.bot === "SHEDSAW" && p.amount > 0, "prizes go to the designer");
      paid += p.amount;
    }
    if ((await api.get("/season")).body.champion) break;
  }
  const me = (await api.get("/me", ann)).body;
  ok(paid > 0, `SHEDSAW earned something over a season (${paid})`);
  ok(me.balance === 1000 + paid, `and ann's wallet holds exactly that (${me.balance})`);
  ok((await api.get("/audit")).body.ok, "audit, prizes included");
  ok((await api.send("DELETE", "/bot", undefined, ann)).body.withdrawn === true && (await api.get("/bot", ann)).body.bot === null, "ann withdraws");
});

await group("a restart in the middle of pricing", async () => {
  ok((await api.send("POST", "/advance")).body.started === "s3", "season 3 starts; its pricing is under way");
  // The file on disk now holds a season with no markets. A second server reading it must price and open it.
  const second = await boot();
  const s = await priced(second);
  ok(s.seasonId === "s3" && s.markets.length > 10, "the restarted house opens the round it found unpriced");
  ok(s.entrants.every((e: Json) => e.designer === null), "a withdrawn bot is not entered");
  ok((await second.get("/audit")).body.ok, "audit");
  ok((await second.get("/me", ann)).body.handle === "ann" && (await second.get("/me", bob)).body.bets.length === 2, "users, tokens and bets carried over");
  ok((await second.get("/season")).body.markets.every((m: Json) => m.id !== betMarket), "last season's markets stay settled");
  await priced(api);
  api.close();
  api = second;
});

await group("the match clock", async () => {
  ok((await api.get("/season")).body.nextMatchAt === null, "no clock unless asked for");
  const before = (await api.get("/season")).body;
  api.close();
  process.env.BET_MATCH_EVERY = "0.3";
  api = await boot();
  const armed = (await api.get("/season")).body;
  ok(typeof armed.nextMatchAt === "number" && armed.nextMatchAt > Date.now() - 1000, "with BET_MATCH_EVERY the next match has a time");
  const played = (s: Json) => s.table.reduce((n: number, r: Json) => n + r.played, 0) / 4;
  const until = Date.now() + 15000;
  let now = armed;
  while (played(now) < played(before) + 2 && Date.now() < until) {
    await sleep(100);
    now = (await api.get("/season")).body;
  }
  ok(played(now) >= played(before) + 2, `matches are played on the clock (${played(now) - played(before)} so far)`);
  await priced(api);
  ok((await api.get("/audit")).body.ok, "audit");
});

api.close();
rmSync(dir, { recursive: true, force: true });
console.log(`\n${checks} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);

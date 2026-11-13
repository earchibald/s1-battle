import { Router, type Request, type Response } from "express";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { stockBuild, STOCK_ORDER } from "../shared/bots/index";
import { costOf, normalizeBuild, validateBuild, type BotBuild } from "../shared/build";
import { prizesFor } from "../src/account/prizes";
import { simulateOutcome } from "../src/season/runner";
import { LEAGUE_SIZE, candidatePool, createSeason, isComplete, seasonPhase, standings, wildcardBuilds, type SeasonState } from "../src/season/season";
import { Book, defaultBookConfig, type Market } from "../src/betting/book";
import { selectionText } from "../src/betting/markets";
import { DEFAULT_PRICING, Pricer } from "../src/betting/pricing";
import { SeasonBook, type SeasonBookJSON } from "../src/betting/seasonBook";
import { sha256 } from "../src/betting/sha256";

/**
 * The house, as a local server: one long-lived book, one season at a time, and the smallest registration that
 * can carry a wallet. Everything here is a thin shell around src/betting; the rules live there.
 *
 *   POST /api/bet/register   { handle }                       -> { userId, token, balance }   (token shown once)
 *   GET  /api/bet/me         (Bearer token)                   -> wallet, open and settled bets
 *   GET  /api/bet/season                                      -> table, fixtures, fairness records, live markets
 *   POST /api/bet/bets       (Bearer) { key, marketId, selectionId, stake, minPrice? }
 *   GET  /api/bet/bot        (Bearer)                         -> your entered bot, if any
 *   PUT  /api/bet/bot        (Bearer) { build }               -> enter (or replace) your bot for the next season
 *   DELETE /api/bet/bot      (Bearer)                         -> withdraw it from future seasons
 *   GET  /api/bet/leaderboard
 *   GET  /api/bet/audit                                       -> the full audit, run on request
 *   POST /api/bet/advance    (dev) lock, play and settle the next match; starts a new season after the final.
 *                            Add ?wait=1 to answer only once the next round is priced and open.
 *
 * REGISTRATION  A handle and a server-issued bearer token; only the token's hash is stored. That is enough to
 *               own a wallet. Email or OAuth can later attach to the same user id without touching the book.
 * PERSISTENCE   The whole state is rewritten atomically (temp file, then rename) after every change, and on
 *               start-up it is reloaded through the same audit that guards every book. A file that fails the
 *               audit stops the server rather than being trusted.
 * TIMING        Pricing a new round simulates a few thousand matches. It runs in slices of a few milliseconds
 *               between other requests (Pricer.rolloutsAsync, the path the browser uses), so the server keeps
 *               answering while it prices; a round's markets open when its prices are ready. Season steps
 *               (a match, a new season, a pricing run) go through one queue, so they never overlap.
 * SCHEDULE      Set BET_MATCH_EVERY (seconds) and the house plays the next match on that clock, with
 *               BET_SEASON_GAP seconds between a Grand Final and the next season. Unset, the season moves only
 *               on POST /advance.
 * DESIGNERS     A user may enter one bot. Entries are frozen into a season when it starts: the users who have
 *               waited longest go first, and the house's stock bots and wildcards fill the rest of the league.
 *               A designed bot pays its designer the same prize money as in the local game (src/account/prizes),
 *               minted into the wallet they bet from.
 */

const DIR = path.resolve(process.env.BET_DATA_DIR ?? "data/betting");
const STATE_FILE = path.join(DIR, "state.json");
const START_GRANT = 1000;
/** A bettor with nothing left and nothing riding is topped up to this at the start of each season. */
const SEASON_STIPEND = 100;
const HANDLE = /^[A-Za-z0-9_-]{3,16}$/;
/** A callsign on the server: 3 to 16 capitals, digits, spaces or hyphens, starting and ending on a letter or digit. */
const CALLSIGN = /^[A-Z0-9][A-Z0-9 -]{1,14}[A-Z0-9]$/;
const SLICE_MS = 8;
const seconds = (name: string) => Math.max(0, Number(process.env[name] ?? 0) || 0);
const BEARER = /^Bearer ([0-9a-f]{64})$/;

interface User {
  id: string;
  handle: string;
  tokenHash: string;
  createdAt: number;
}
/** A user's bot, waiting for (or playing in) a season. One per user. */
interface Entry {
  userId: string;
  build: BotBuild;
  submittedAt: number;
  /** The last season this entry was in the league (0: not yet). */
  lastSeason: number;
}
interface StateFile {
  v: 1;
  seasonNo: number;
  users: User[];
  current: SeasonBookJSON;
  /** Absent in files written before designers could enter. */
  entries?: Entry[];
}
type Advance = { started: string } | { played: string; label: string; order: string[]; headlines: string[]; champion: string | null; prizes: { handle: string; bot: string; amount: number }[] };
const reservedNames = () => new Set([...STOCK_ORDER.map((k) => stockBuild(k).name), ...wildcardBuilds().map((b) => b.name)].map((n) => n.trim().toUpperCase()));

const pricingConfig = () => ({ ...DEFAULT_PRICING, poolSize: Number(process.env.BET_POOL ?? 96), rollouts: Number(process.env.BET_ROLLOUTS ?? 800), seed: randomBytes(4).readUInt32BE(0) });
const entropy = () => randomBytes(32).toString("hex");

class House {
  users: User[] = [];
  seasonNo = 0;
  book!: Book;
  sb!: SeasonBook;
  entries: Entry[] = [];
  /** Progress (0..1) of the pricing run in hand, or null when the round's markets are up to date. */
  pricing: { progress: number } | null = null;
  /** When the clock will play the next match (ms since the epoch), or null when there is no clock. */
  nextMatchAt: number | null = null;
  private pricer = new Pricer(pricingConfig());
  private byToken = new Map<string, User>();
  /** Season steps run one at a time, in the order they were asked for. */
  private queue: Promise<void> = Promise.resolve();

  constructor() {
    if (existsSync(STATE_FILE)) {
      const file = JSON.parse(readFileSync(STATE_FILE, "utf8")) as StateFile;
      if (file.v !== 1) throw new Error("unknown betting state format");
      this.users = file.users;
      this.entries = Array.isArray(file.entries) ? file.entries : [];
      this.seasonNo = file.seasonNo;
      // fromJSON audits the book and throws if anything in the file does not add up.
      this.sb = SeasonBook.fromJSON(file.current, { pricer: this.pricer, entropy });
      this.book = this.sb.book;
      const bad = this.sb.verify();
      if (bad.length) throw new Error(`betting state fails verification: ${bad.slice(0, 3).join("; ")}`);
    } else {
      this.book = new Book(defaultBookConfig("house"));
      this.newSeason();
    }
    for (const u of this.users) this.byToken.set(u.tokenHash, u);
    // A new season, or a restart that caught the house between a result and its repricing.
    if (this.needsOpen()) {
      // Marked here, not when the queue gets to it, so the very first request already sees the run.
      this.pricing = { progress: 0 };
      this.enqueue(() => this.reopen());
    }
  }

  private enqueue(job: () => Promise<void>) {
    this.queue = this.queue.then(job).catch((e) => console.error("[betting]", e));
  }
  /** Resolves when every season step asked for so far has finished, pricing included. */
  idle(): Promise<void> {
    return this.queue;
  }

  private needsOpen(): boolean {
    const sb = this.sb;
    if (isComplete(sb.season)) return false;
    const committed = new Set(sb.fairness().map((r) => r.fixtureId));
    const round = sb.round();
    return round.some((f) => !committed.has(f.id)) || (!round.some((f) => sb.isLocked(f.id)) && sb.seasonLong().some((m) => m.status === "suspended"));
  }

  /** Price what comes next in slices, then open it. Bets on markets already open keep being taken meanwhile. */
  private async reopen(): Promise<void> {
    const sb = this.sb;
    if (isComplete(sb.season)) return;
    const state = (this.pricing ??= { progress: 0 });
    try {
      const finals = await this.pricer.rolloutsAsync(
        sb.season,
        (p) => {
          state.progress = p;
          return new Promise<boolean>((go) => setImmediate(() => go(true)));
        },
        SLICE_MS,
      );
      if (finals) {
        sb.open(finals);
        this.save();
      }
    } finally {
      this.pricing = null;
    }
  }

  save() {
    mkdirSync(DIR, { recursive: true });
    const file: StateFile = { v: 1, seasonNo: this.seasonNo, users: this.users, current: this.sb.toJSON(), entries: this.entries };
    const tmp = `${STATE_FILE}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(file));
    renameSync(tmp, STATE_FILE);
  }

  newSeason() {
    this.seasonNo++;
    // Designers who have waited longest enter first; the house fills the rest. `me` is nobody, so no bot is "yours".
    const waiting = this.entries
      .filter((e) => this.users.some((u) => u.id === e.userId))
      .sort((a, b) => a.lastSeason - b.lastSeason || a.submittedAt - b.submittedAt)
      .slice(0, LEAGUE_SIZE);
    const designed = waiting.map((e) => ({ build: e.build, owner: { id: e.userId, name: this.users.find((u) => u.id === e.userId)!.handle } }));
    const entrants = candidatePool([], [], { id: "house", name: "the house" }, designed).filter((c) => c.selected);
    for (const e of waiting) if (entrants.some((c) => c.owner?.id === e.userId)) e.lastSeason = this.seasonNo;
    const season = createSeason(entrants, randomBytes(4).readUInt32BE(0) % 1_000_000, Date.now());
    for (const u of this.users) {
      const riding = this.book.betsOf(u.id).some((b) => b.status === "open");
      const short = SEASON_STIPEND - this.book.balance(u.id);
      if (!riding && short > 0) this.book.grant(u.id, short, `stipend:s${this.seasonNo}`);
    }
    this.sb = new SeasonBook({ seasonId: `s${this.seasonNo}`, season, book: this.book, pricer: this.pricer, entropy });
    this.save();
  }

  entryOf(userId: string): Entry | undefined {
    return this.entries.find((e) => e.userId === userId);
  }

  /** How an entry stands: in this season's league, or waiting for the next one. */
  entryView(e: Entry) {
    const playing = this.sb.season.entrants.find((x) => x.owner?.id === e.userId);
    const cost = costOf(e.build);
    return {
      name: e.build.name,
      kind: e.build.kind,
      tagline: e.build.tagline,
      cost: cost.total,
      submittedAt: e.submittedAt,
      lastSeason: e.lastSeason || null,
      // The league holds a copy frozen at season start, so an edit made since then plays from the next season.
      playing: playing ? { seasonId: this.sb.seasonId, as: playing.id, current: JSON.stringify({ ...playing.build, id: "" }) === JSON.stringify({ ...e.build, id: "" }) } : null,
      build: e.build,
    };
  }

  /** Enter or replace a user's bot. Returns the entry, or what is wrong with the build. */
  submit(user: User, raw: unknown): Entry | string[] {
    const r = (raw && typeof raw === "object" ? raw : null) as Partial<BotBuild> | null;
    if (!r || typeof r.name !== "string" || typeof r.kind !== "string") return ["expected { build } with at least a name and a kind"];
    const build = normalizeBuild({ ...r, name: r.name.trim().toUpperCase() }, stockBuild, `entry-${user.id}`);
    build.tagline = build.tagline.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
    if (build.kind !== r.kind) return [`unknown weapon system "${String(r.kind).slice(0, 24)}"`];
    if (!CALLSIGN.test(build.name)) return ["the callsign must be 3 to 16 capitals, digits, spaces or hyphens"];
    if (reservedNames().has(build.name)) return [`${build.name} is a house bot's callsign`];
    if (this.entries.some((e) => e.userId !== user.id && e.build.name === build.name)) return [`another designer already has a bot called ${build.name}`];
    const errors = validateBuild(build).filter((p) => p.level === "error").map((p) => p.text);
    if (errors.length) return errors;
    const old = this.entryOf(user.id);
    const entry: Entry = { userId: user.id, build, submittedAt: old?.submittedAt ?? Date.now(), lastSeason: old?.lastSeason ?? 0 };
    this.entries = [...this.entries.filter((e) => e.userId !== user.id), entry];
    this.save();
    return entry;
  }

  withdraw(user: User): boolean {
    const had = this.entries.length;
    this.entries = this.entries.filter((e) => e.userId !== user.id);
    if (this.entries.length !== had) this.save();
    return this.entries.length !== had;
  }

  register(handle: string): { user: User; token: string } | string {
    if (typeof handle !== "string" || !HANDLE.test(handle)) return "handle must be 3 to 16 letters, digits, - or _";
    if (this.users.some((u) => u.handle.toLowerCase() === handle.toLowerCase())) return "that handle is taken";
    const token = randomBytes(32).toString("hex");
    const user: User = { id: `u-${randomBytes(6).toString("hex")}`, handle, tokenHash: sha256(token), createdAt: Date.now() };
    this.users.push(user);
    this.byToken.set(user.tokenHash, user);
    this.book.grant(user.id, START_GRANT, "registration");
    this.save();
    return { user, token };
  }

  auth(req: Request): User | null {
    const m = (req.get("authorization") ?? "").match(BEARER);
    return m ? (this.byToken.get(sha256(m[1])) ?? null) : null;
  }

  /**
   * Lock, play and settle the next match; after the Grand Final, the next call starts a new season. Resolves as
   * soon as that is done and saved. Pricing what comes next follows in the queue, ahead of any later step.
   */
  advance(): Promise<Advance> {
    return new Promise<Advance>((resolve, reject) => {
      this.enqueue(async () => {
        try {
          resolve(this.step());
        } catch (e) {
          reject(e);
          return;
        }
        await this.reopen();
      });
    });
  }

  private step(): Advance {
    if (isComplete(this.sb.season)) {
      this.newSeason();
      return { started: this.sb.seasonId };
    }
    const sb = this.sb;
    const fx = sb.round()[0];
    // Lock and persist first: if the process dies mid-match the fixture is still locked on restart, never reopened.
    if (!sb.isLocked(fx.id)) sb.lock(fx.id);
    this.save();
    // Reopening is the pricing run that follows, so the result is recorded without it.
    const locked = sb.season.fixtures.find((f) => f.id === fx.id)!;
    const rec = sb.result(fx.id, simulateOutcome(sb.season, locked), true, false);
    // Prizes go out in the same step as the result, before the one save, so a match can never pay twice.
    const prizes = prizesFor(sb.season, rec).filter((p) => this.users.some((u) => u.id === p.ownerId));
    for (const p of prizes) this.book.grant(p.ownerId, p.amount, `prize:${sb.seasonId}:${rec.fixtureId}:${p.bot}`);
    this.save();
    return {
      played: fx.id,
      label: rec.label,
      order: rec.rows.map((r) => r.id),
      headlines: rec.headlines,
      champion: sb.season.champion,
      prizes: prizes.map((p) => ({ handle: this.users.find((u) => u.id === p.ownerId)!.handle, bot: p.bot, amount: p.amount })),
    };
  }

  /** Play on a clock: the next match every `every` seconds, and `gap` seconds between seasons. */
  schedule(every: number, gap: number) {
    const arm = (s: number) => {
      this.nextMatchAt = Date.now() + s * 1000;
      setTimeout(tick, s * 1000).unref();
    };
    const tick = () => {
      this.advance()
        .catch((e) => console.error("[betting] scheduled match failed:", e))
        // The clock for the next match starts once this one's markets have had their time to open.
        .then(() => this.idle())
        .then(() => arm(isComplete(this.sb.season) ? gap : every));
    };
    arm(every);
  }

  marketView(m: Market, userId?: string) {
    return {
      id: m.id,
      kind: m.kind,
      scope: m.scope,
      round: m.round,
      fixtureId: m.fixtureId,
      label: m.label,
      status: m.status,
      version: m.version,
      params: m.params,
      grades: m.grades,
      selections: this.book.quote(m.id, userId).map((q) => ({ id: q.selectionId, text: selectionText(m, q.selectionId), price: q.price, maxStake: q.maxStake })),
    };
  }
}

/** A small per-key rate limit: `burst` requests, refilled at `perSecond`. */
function limiter(burst: number, perSecond: number) {
  const buckets = new Map<string, { n: number; t: number }>();
  return (key: string): boolean => {
    const now = Date.now();
    const b = buckets.get(key) ?? { n: burst, t: now };
    b.n = Math.min(burst, b.n + ((now - b.t) / 1000) * perSecond);
    b.t = now;
    buckets.set(key, b);
    if (b.n < 1) return false;
    b.n -= 1;
    return true;
  };
}

export function bettingRouter(): Router {
  // Without a clock the house is built on the first betting request, so a server nobody bets on prices nothing.
  let house!: House;
  const open = () => (house ??= new House());
  const every = seconds("BET_MATCH_EVERY");
  if (every > 0) open().schedule(every, seconds("BET_SEASON_GAP") || every);
  const r = Router();
  r.use((_req, _res, next) => {
    open();
    next();
  });
  const betLimit = limiter(20, 2);
  const botLimit = limiter(20, 0.2);
  const regLimit = limiter(5, 0.05);
  const table = (s: SeasonState) => standings(s).map((x) => ({ id: x.id, rank: x.rank, played: x.played, points: x.points, wins: x.wins }));
  const needUser = "register first, then send Authorization: Bearer <token>";

  r.post("/register", (req: Request, res: Response) => {
    if (!regLimit(req.ip ?? "?")) return void res.status(429).json({ ok: false, error: "too many registrations from this address" });
    const out = house.register((req.body as { handle?: string })?.handle ?? "");
    if (typeof out === "string") return void res.status(400).json({ ok: false, error: out });
    res.json({ ok: true, userId: out.user.id, handle: out.user.handle, token: out.token, balance: house.book.balance(out.user.id) });
  });

  r.get("/me", (req, res) => {
    const u = house.auth(req);
    if (!u) return void res.status(401).json({ ok: false, error: needUser });
    const e = house.entryOf(u.id);
    res.json({ ok: true, userId: u.id, handle: u.handle, balance: house.book.balance(u.id), bot: e ? house.entryView(e) : null, bets: house.book.betsOf(u.id).slice(-200) });
  });

  r.get("/bot", (req, res) => {
    const u = house.auth(req);
    if (!u) return void res.status(401).json({ ok: false, error: needUser });
    const e = house.entryOf(u.id);
    res.json({ ok: true, bot: e ? house.entryView(e) : null });
  });

  r.put("/bot", (req, res) => {
    const u = house.auth(req);
    if (!u) return void res.status(401).json({ ok: false, error: needUser });
    if (!botLimit(u.id)) return void res.status(429).json({ ok: false, error: "slow down" });
    const out = house.submit(u, (req.body as { build?: unknown })?.build);
    if (Array.isArray(out)) return void res.status(400).json({ ok: false, error: out[0], problems: out });
    res.json({ ok: true, bot: house.entryView(out) });
  });

  r.delete("/bot", (req, res) => {
    const u = house.auth(req);
    if (!u) return void res.status(401).json({ ok: false, error: needUser });
    res.json({ ok: true, withdrawn: house.withdraw(u) });
  });

  r.get("/season", (req, res) => {
    const u = house.auth(req);
    const sb = house.sb;
    const live = [...house.book.markets.values()].filter((m) => m.id.startsWith(`${sb.seasonId}/`));
    res.json({
      ok: true,
      seasonId: sb.seasonId,
      phase: seasonPhase(sb.season),
      champion: sb.season.champion,
      table: table(sb.season),
      entrants: sb.season.entrants.map((e) => ({ id: e.id, kind: e.build.kind, tagline: e.build.tagline, origin: e.origin, designer: e.owner?.name ?? null })),
      pricing: house.pricing,
      nextMatchAt: house.nextMatchAt,
      round: sb.round().map((f) => ({ id: f.id, label: f.label, bots: f.bots, locked: sb.isLocked(f.id) })),
      fairness: sb.fairness(),
      markets: live.filter((m) => m.status === "open" || m.status === "suspended").map((m) => house.marketView(m, u?.id)),
      settled: live.filter((m) => m.status === "settled" || m.status === "void").length,
    });
  });

  r.post("/bets", (req, res) => {
    const u = house.auth(req);
    if (!u) return void res.status(401).json({ ok: false, error: needUser });
    if (!betLimit(u.id)) return void res.status(429).json({ ok: false, code: "rate_limited", message: "slow down" });
    const b = (req.body ?? {}) as Record<string, unknown>;
    const result = house.book.placeBet({ userId: u.id, key: b.key as string, marketId: b.marketId as string, selectionId: b.selectionId as string, stake: b.stake as number, minPrice: b.minPrice as number | undefined });
    if (result.ok && !result.duplicate) house.save();
    res.status(result.ok ? 200 : result.code === "bad_request" ? 400 : 409).json(result.ok ? { ...result, balance: house.book.balance(u.id) } : result);
  });

  r.get("/leaderboard", (_req, res) => {
    res.json({ ok: true, board: house.users.map((u) => ({ handle: u.handle, balance: house.book.balance(u.id), bets: house.book.betsOf(u.id).length })).sort((a, b) => b.balance - a.balance) });
  });

  r.get("/audit", (_req, res) => {
    const violations = house.sb.verify();
    res.json({ ok: violations.length === 0, violations, ledgerHead: house.book.ledger.head, ledgerEntries: house.book.ledger.entries.length, bets: house.book.bets.length, houseBalance: house.book.houseBalance });
  });

  r.post("/advance", async (req, res) => {
    const admin = process.env.BET_ADMIN_TOKEN;
    if (process.env.NODE_ENV === "production" && !admin) return void res.status(403).json({ ok: false, error: "set BET_ADMIN_TOKEN to drive the season in production" });
    if (admin && req.get("x-admin-token") !== admin) return void res.status(403).json({ ok: false, error: "bad admin token" });
    try {
      const out = await house.advance();
      if (req.query.wait) await house.idle();
      res.json({ ok: true, ...out });
    } catch (e) {
      res.status(500).json({ ok: false, error: (e as Error).message });
    }
  });

  return r;
}

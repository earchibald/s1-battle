import { Router, type Request, type Response } from "express";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { candidatePool, createSeason, isComplete, seasonPhase, standings, type SeasonState } from "../src/season/season";
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
 *   GET  /api/bet/leaderboard
 *   GET  /api/bet/audit                                       -> the full audit, run on request
 *   POST /api/bet/advance    (dev) lock, play and settle the next match; starts a new season after the final
 *
 * REGISTRATION  A handle and a server-issued bearer token; only the token's hash is stored. That is enough to
 *               own a wallet. Email or OAuth can later attach to the same user id without touching the book.
 * PERSISTENCE   The whole state is rewritten atomically (temp file, then rename) after every change, and on
 *               start-up it is reloaded through the same audit that guards every book. A file that fails the
 *               audit stops the server rather than being trusted.
 * TIMING        Pricing a new round simulates a few thousand matches and blocks the event loop for some
 *               seconds. Fine for local development; a deployed house should price in a worker thread.
 */

const DIR = path.resolve(process.env.BET_DATA_DIR ?? "data/betting");
const STATE_FILE = path.join(DIR, "state.json");
const START_GRANT = 1000;
/** A bettor with nothing left and nothing riding is topped up to this at the start of each season. */
const SEASON_STIPEND = 100;
const HANDLE = /^[A-Za-z0-9_-]{3,16}$/;
const BEARER = /^Bearer ([0-9a-f]{64})$/;

interface User {
  id: string;
  handle: string;
  tokenHash: string;
  createdAt: number;
}
interface StateFile {
  v: 1;
  seasonNo: number;
  users: User[];
  current: SeasonBookJSON;
}

const pricingConfig = () => ({ ...DEFAULT_PRICING, poolSize: Number(process.env.BET_POOL ?? 96), rollouts: Number(process.env.BET_ROLLOUTS ?? 800), seed: randomBytes(4).readUInt32BE(0) });
const entropy = () => randomBytes(32).toString("hex");

class House {
  users: User[] = [];
  seasonNo = 0;
  book!: Book;
  sb!: SeasonBook;
  private pricer = new Pricer(pricingConfig());
  private byToken = new Map<string, User>();

  constructor() {
    if (existsSync(STATE_FILE)) {
      const file = JSON.parse(readFileSync(STATE_FILE, "utf8")) as StateFile;
      if (file.v !== 1) throw new Error("unknown betting state format");
      this.users = file.users;
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
  }

  save() {
    mkdirSync(DIR, { recursive: true });
    const file: StateFile = { v: 1, seasonNo: this.seasonNo, users: this.users, current: this.sb.toJSON() };
    const tmp = `${STATE_FILE}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(file));
    renameSync(tmp, STATE_FILE);
  }

  newSeason() {
    this.seasonNo++;
    const entrants = candidatePool([], []).filter((c) => c.selected);
    const season = createSeason(entrants, randomBytes(4).readUInt32BE(0) % 1_000_000, Date.now());
    for (const u of this.users) {
      const riding = this.book.betsOf(u.id).some((b) => b.status === "open");
      const short = SEASON_STIPEND - this.book.balance(u.id);
      if (!riding && short > 0) this.book.grant(u.id, short, `stipend:s${this.seasonNo}`);
    }
    this.sb = new SeasonBook({ seasonId: `s${this.seasonNo}`, season, book: this.book, pricer: this.pricer, entropy });
    this.sb.open();
    this.save();
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

  /** Lock, play and settle the next match. After the Grand Final, the next call starts a new season. */
  advance() {
    if (isComplete(this.sb.season)) {
      this.newSeason();
      return { started: this.sb.seasonId };
    }
    const fx = this.sb.round()[0];
    // Lock and persist first: if the process dies mid-match the fixture is still locked on restart, never reopened.
    if (!this.sb.isLocked(fx.id)) this.sb.lock(fx.id);
    this.save();
    const rec = this.sb.play(fx.id);
    this.save();
    return { played: fx.id, label: rec.label, order: rec.rows.map((r) => r.id), headlines: rec.headlines, champion: this.sb.season.champion };
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
  // The house is built on the first betting request, not at boot: opening a season prices a few thousand matches.
  let house!: House;
  const r = Router();
  r.use((_req, _res, next) => {
    house ??= new House();
    next();
  });
  const betLimit = limiter(20, 2);
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
    res.json({ ok: true, userId: u.id, handle: u.handle, balance: house.book.balance(u.id), bets: house.book.betsOf(u.id).slice(-200) });
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

  r.post("/advance", (req, res) => {
    const admin = process.env.BET_ADMIN_TOKEN;
    if (process.env.NODE_ENV === "production" && !admin) return void res.status(403).json({ ok: false, error: "set BET_ADMIN_TOKEN to drive the season in production" });
    if (admin && req.get("x-admin-token") !== admin) return void res.status(403).json({ ok: false, error: "bad admin token" });
    res.json({ ok: true, ...house.advance() });
  });

  return r;
}

import { Ledger, MINT, type Entry } from "./ledger";
import { sha256 } from "./sha256";

/**
 * The book: markets, bets and settlement over the ledger. Pure and synchronous (no DOM, no clock of its own,
 * no randomness), so the same code runs in the browser, in the simulator and on a server.
 *
 * MONEY     Whole credits. Prices are decimal odds in hundredths ("centi-odds": 235 is 2.35), so a payout is
 *           floor(stake * price / 100) and every division rounds toward the house. No floats touch a balance.
 *
 * SOLVENCY  A bet is accepted only if it can be fully collateralised on the spot: the stake leaves the bettor
 *           and the bet's maximum profit leaves the house bank, and both sit in that market's escrow account
 *           until the market is settled or voided. A payout can therefore never fail, the house can never owe
 *           more than it holds, and the worst case on any market is bounded by its per-selection liability cap.
 *
 * LIFECYCLE open <-> suspended -> closed -> settled | void. Bets are taken only while open. A closed market
 *           never reopens. Settlement needs a closed market and a grade for every selection, pays each bet
 *           exactly once, and is safe to repeat. A void market refunds every stake in full.
 *
 * REQUESTS  placeBet never throws on bad input: it returns a typed rejection and changes nothing. Each request
 *           carries a caller-chosen key; repeating a key returns the original bet instead of placing another.
 */

export class BookError extends Error {}

export type Scope = "match" | "round" | "season";
export type MarketKind = "match_win" | "match_top2" | "match_hcap" | "match_kos" | "round_top" | "season_champion" | "season_finalist" | "season_league" | "season_hcap";
export type MarketStatus = "open" | "suspended" | "closed" | "settled" | "void";

/** How a selection finished: the fraction of a full win it is paid at (1/1 win, 0/1 lose, 1/n dead heat), or void (stake back). */
export type Grade = "void" | { num: number; den: number };
export const WIN: Grade = { num: 1, den: 1 };
export const LOSE: Grade = { num: 0, den: 1 };
export const share = (n: number): Grade => ({ num: 1, den: n });

export interface MarketParams {
  /** Handicap pair: the line is added to `a`'s score. */
  a?: string;
  b?: string;
  /** A handicap or total line in half points (so 3 is 1.5), kept integral. */
  line2?: number;
  /** Season handicap league: whole league points added to each bot. */
  handicaps?: Record<string, number>;
}

export interface MarketSpec {
  id: string;
  kind: MarketKind;
  scope: Scope;
  /** The season week this market belongs to; 0 for season-long markets. */
  round: number;
  fixtureId: string | null;
  label: string;
  /** The most selections that can be paid as winners at once (a risk bound, checked at settlement). */
  winners: number;
  params: MarketParams;
  selections: { id: string; label: string }[];
}

export interface Selection {
  id: string;
  label: string;
  /** The model's fair probability at the last pricing (informational). */
  prob: number;
  /** Base price in centi-odds before exposure shading; 0 means not offered. */
  price: number;
}

export interface Market extends Omit<MarketSpec, "selections"> {
  selections: Selection[];
  status: MarketStatus;
  /** Bumped on every reprice. */
  version: number;
  grades: Record<string, Grade> | null;
  note: string;
}

export type BetStatus = "open" | "won" | "part" | "lost" | "void";

export interface Bet {
  id: string;
  key: string;
  userId: string;
  marketId: string;
  selectionId: string;
  stake: number;
  /** Centi-odds the bet was struck at. */
  price: number;
  /** The house's collateral: the most this bet can win beyond its stake. */
  risk: number;
  placedAt: number;
  status: BetStatus;
  payout: number;
  settledAt: number | null;
}

export interface ScopeLimits {
  minStake: number;
  maxStake: number;
  /** The most one user may stake on one market in total. */
  userMarketCap: number;
  /** The most the house may stand to lose on one selection of one market. */
  selectionCap: number;
}

export interface BookConfig {
  id: string;
  /** Credits minted into the house bank when the book is created. */
  houseBank: number;
  limits: Record<Scope, ScopeLimits>;
  /** Exposure shading: a selection at its liability cap is priced as if (1 + shade) times as likely. */
  shade: number;
}

export const DEFAULT_LIMITS: Record<Scope, ScopeLimits> = {
  match: { minStake: 1, maxStake: 100, userMarketCap: 200, selectionCap: 3000 },
  round: { minStake: 1, maxStake: 100, userMarketCap: 200, selectionCap: 3000 },
  season: { minStake: 1, maxStake: 100, userMarketCap: 300, selectionCap: 6000 },
};

export const defaultBookConfig = (id: string): BookConfig => ({ id, houseBank: 1_000_000, limits: DEFAULT_LIMITS, shade: 0.25 });

/** User money held somewhere else (the browser's profile wallet). Whole credits, synchronous. */
export interface WalletPort {
  balance(userId: string): number;
  /** Take `amount`; false (and no change) when the balance is short. */
  debit(userId: string, amount: number, ref: string): boolean;
  credit(userId: string, amount: number, kind: "payout" | "refund", ref: string): void;
}

export interface BetRequest {
  userId: string;
  /** Idempotency key, unique per user per intended bet. */
  key: string;
  marketId: string;
  selectionId: string;
  stake: number;
  /** The worst price the bettor accepts (centi-odds). Omit to take the current price whatever it is. */
  minPrice?: number;
}

export type RejectCode =
  | "bad_request"
  | "unknown_market"
  | "unknown_selection"
  | "market_closed"
  | "selection_unavailable"
  | "stake_too_small"
  | "stake_too_large"
  | "user_limit"
  | "insufficient_funds"
  | "price_changed"
  | "liability_limit"
  | "house_limit"
  | "key_reused";

export type BetResult = { ok: true; bet: Bet; duplicate: boolean } | { ok: false; code: RejectCode; message: string; price?: number; maxStake?: number };

export interface Quote {
  selectionId: string;
  label: string;
  prob: number;
  /** Live price in centi-odds after exposure shading; 0 when not offered right now. */
  price: number;
  /** The largest stake this user could place on it right now (0 when none). */
  maxStake: number;
}

export interface BookJSON {
  v: 1;
  config: BookConfig;
  markets: Market[];
  bets: Bet[];
  ledger: Entry[];
}

export const HOUSE = "house";
export const MIN_PRICE = 101;
const ID = /^[A-Za-z0-9_.:@-]{1,64}$/;

/** Round a price down to the odds ladder: finer steps at short prices, coarser at long ones. */
export function tickFloor(price: number): number {
  const step = price < 200 ? 1 : price < 500 ? 5 : price < 1000 ? 10 : price < 2000 ? 50 : 100;
  return Math.floor(price / step) * step;
}

/** What a settled bet returns to the bettor. Dead heats pay the winning fraction of the stake at full odds. */
export function payoutFor(stake: number, price: number, grade: Grade): number {
  if (grade === "void") return stake;
  if (grade.num <= 0) return 0;
  return Math.floor((stake * price * grade.num) / (100 * grade.den));
}

const validGrade = (g: Grade | undefined): g is Grade => g === "void" || (!!g && Number.isSafeInteger(g.num) && Number.isSafeInteger(g.den) && g.den >= 1 && g.num >= 0 && g.num <= g.den);
const sameGrade = (a: Grade, b: Grade) => (a === "void" || b === "void" ? a === b : a.num * b.den === b.num * a.den);

export class Book {
  readonly config: BookConfig;
  readonly ledger: Ledger;
  readonly markets = new Map<string, Market>();
  readonly bets: Bet[] = [];
  private byId = new Map<string, Bet>();
  private byKey = new Map<string, Bet>();
  private byMarket = new Map<string, Bet[]>();
  /** Open house liability per market selection, and open stakes per market user. */
  private liability = new Map<string, number>();
  private staked = new Map<string, number>();
  private wallet: WalletPort | null;
  private now: () => number;

  constructor(config: BookConfig, opts: { wallet?: WalletPort; now?: () => number; restore?: BookJSON } = {}) {
    this.config = config;
    this.wallet = opts.wallet ?? null;
    this.now = opts.now ?? (() => Date.now());
    if (opts.restore) {
      this.ledger = Ledger.fromJSON(opts.restore.ledger);
      for (const m of opts.restore.markets) this.markets.set(m.id, structuredClone(m));
      for (const b of opts.restore.bets) this.index({ ...b });
    } else {
      if (!Number.isSafeInteger(config.houseBank) || config.houseBank <= 0) throw new BookError("the house needs a bank");
      this.ledger = new Ledger();
      this.ledger.post("fund", HOUSE, [{ account: MINT, delta: -config.houseBank }, { account: HOUSE, delta: config.houseBank }], this.now());
    }
  }

  /* ---------------------------------------------------------------------------------------------- */
  /* Accounts                                                                                        */
  /* ---------------------------------------------------------------------------------------------- */

  /** The ledger account a user's stakes come from: their own, or a mirror of the outside wallet. */
  private acct(userId: string): string {
    return this.wallet ? `ext:${userId}` : `user:${userId}`;
  }
  private escrow(marketId: string): string {
    return `escrow:${marketId}`;
  }

  balance(userId: string): number {
    return this.wallet ? this.wallet.balance(userId) : this.ledger.balance(`user:${userId}`);
  }
  get houseBalance(): number {
    return this.ledger.balance(HOUSE);
  }

  /** Mint credits to a user (the registration grant, a top-up). Only for books that hold the wallets themselves. */
  grant(userId: string, amount: number, ref = "grant"): void {
    if (this.wallet) throw new BookError("wallets live outside this book");
    if (!ID.test(userId)) throw new BookError("bad user id");
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new BookError("bad grant amount");
    this.ledger.post("grant", ref, [{ account: MINT, delta: -amount }, { account: `user:${userId}`, delta: amount }], this.now());
  }

  /* ---------------------------------------------------------------------------------------------- */
  /* Markets                                                                                         */
  /* ---------------------------------------------------------------------------------------------- */

  market(id: string): Market {
    const m = this.markets.get(id);
    if (!m) throw new BookError(`no market ${id}`);
    return m;
  }

  betsOn(marketId: string): Bet[] {
    return this.byMarket.get(marketId) ?? [];
  }
  betsOf(userId: string): Bet[] {
    return this.bets.filter((b) => b.userId === userId);
  }
  bet(id: string): Bet | undefined {
    return this.byId.get(id);
  }

  addMarket(spec: MarketSpec, prices: Record<string, { prob: number; price: number }>, status: "open" | "suspended" = "open"): Market {
    if (this.markets.has(spec.id)) throw new BookError(`market ${spec.id} already exists`);
    if (!spec.selections.length || new Set(spec.selections.map((s) => s.id)).size !== spec.selections.length) throw new BookError(`market ${spec.id} needs distinct selections`);
    if (!Number.isSafeInteger(spec.winners) || spec.winners < 1 || spec.winners > spec.selections.length) throw new BookError(`market ${spec.id}: bad winners bound`);
    const m: Market = { ...spec, params: structuredClone(spec.params), selections: spec.selections.map((s) => ({ id: s.id, label: s.label, prob: 0, price: 0 })), status, version: 0, grades: null, note: "" };
    this.markets.set(m.id, m);
    this.applyPrices(m, prices);
    return m;
  }

  /** New prices for a market that is still taking (or may again take) bets. Struck bets keep their price. */
  reprice(marketId: string, prices: Record<string, { prob: number; price: number }>): void {
    const m = this.market(marketId);
    if (m.status !== "open" && m.status !== "suspended") throw new BookError(`market ${marketId} is ${m.status}`);
    this.applyPrices(m, prices);
  }

  private applyPrices(m: Market, prices: Record<string, { prob: number; price: number }>) {
    for (const s of m.selections) {
      const p = prices[s.id];
      const price = p ? p.price : 0;
      if (!Number.isSafeInteger(price) || (price !== 0 && price < MIN_PRICE)) throw new BookError(`market ${m.id}: bad price for ${s.id}`);
      s.price = price;
      s.prob = p && Number.isFinite(p.prob) ? p.prob : 0;
    }
    m.version++;
  }

  setStatus(marketId: string, status: "open" | "suspended" | "closed"): void {
    const m = this.market(marketId);
    if (m.status === status) return;
    if (m.status !== "open" && m.status !== "suspended") throw new BookError(`market ${marketId} is ${m.status} and cannot become ${status}`);
    m.status = status;
  }

  /** The price a new bet on this selection would be struck at right now; 0 when it is not on offer. */
  livePrice(m: Market, selectionId: string): number {
    const s = m.selections.find((x) => x.id === selectionId);
    if (!s || s.price < MIN_PRICE) return 0;
    const cap = this.config.limits[m.scope].selectionCap;
    const held = this.liability.get(`${m.id}|${selectionId}`) ?? 0;
    const shaded = tickFloor(Math.floor(s.price / (1 + (this.config.shade * held) / cap)));
    return shaded >= MIN_PRICE ? shaded : 0;
  }

  /** The largest stake the user could place on a selection at `price`, by every limit at once. */
  private headroom(m: Market, selectionId: string, userId: string, price: number): number {
    if (price < MIN_PRICE) return 0;
    const lim = this.config.limits[m.scope];
    const perCredit = price - 100; // profit per 100 staked
    const liabilityLeft = lim.selectionCap - (this.liability.get(`${m.id}|${selectionId}`) ?? 0);
    const byLiability = Math.floor((liabilityLeft * 100) / perCredit);
    const byHouse = Math.floor((this.houseBalance * 100) / perCredit);
    const byUser = lim.userMarketCap - (this.staked.get(`${m.id}|${userId}`) ?? 0);
    let max = Math.max(0, Math.min(lim.maxStake, byUser, byLiability, byHouse, this.balance(userId)));
    // Flooring the payout can leave a credit of slack; step down until the collateral really fits.
    while (max > 0 && Math.floor((max * price) / 100) - max > Math.min(liabilityLeft, this.houseBalance)) max--;
    return max;
  }

  quote(marketId: string, userId?: string): Quote[] {
    const m = this.market(marketId);
    return m.selections.map((s) => {
      const price = m.status === "open" ? this.livePrice(m, s.id) : 0;
      return { selectionId: s.id, label: s.label, prob: s.prob, price, maxStake: userId && ID.test(userId) ? this.headroom(m, s.id, userId, price) : 0 };
    });
  }

  /* ---------------------------------------------------------------------------------------------- */
  /* Bets                                                                                            */
  /* ---------------------------------------------------------------------------------------------- */

  placeBet(req: BetRequest): BetResult {
    const no = (code: RejectCode, message: string, extra: { price?: number; maxStake?: number } = {}): BetResult => ({ ok: false, code, message, ...extra });
    if (!req || typeof req !== "object") return no("bad_request", "not a bet request");
    const { userId, key, marketId, selectionId, stake, minPrice } = req;
    if (typeof userId !== "string" || !ID.test(userId)) return no("bad_request", "bad user id");
    if (typeof key !== "string" || !ID.test(key)) return no("bad_request", "bad idempotency key");
    if (typeof marketId !== "string" || typeof selectionId !== "string") return no("bad_request", "bad market or selection");
    if (typeof stake !== "number" || !Number.isSafeInteger(stake)) return no("bad_request", "stake must be a whole number of credits");
    if (minPrice !== undefined && (typeof minPrice !== "number" || !Number.isSafeInteger(minPrice) || minPrice < MIN_PRICE)) return no("bad_request", "bad minimum price");

    const prior = this.byKey.get(`${userId}|${key}`);
    if (prior) {
      if (prior.marketId === marketId && prior.selectionId === selectionId && prior.stake === stake) return { ok: true, bet: prior, duplicate: true };
      return no("key_reused", "that key was already used for a different bet");
    }

    const m = this.markets.get(marketId);
    if (!m) return no("unknown_market", "no such market");
    if (!m.selections.some((s) => s.id === selectionId)) return no("unknown_selection", "no such selection");
    if (m.status !== "open") return no("market_closed", `betting is ${m.status === "suspended" ? "suspended" : "closed"} on this market`);
    const price = this.livePrice(m, selectionId);
    if (price < MIN_PRICE) return no("selection_unavailable", "no price on that selection right now");
    if (minPrice !== undefined && price < minPrice) return no("price_changed", "the price has shortened", { price });

    const lim = this.config.limits[m.scope];
    const maxStake = this.headroom(m, selectionId, userId, price);
    if (stake < lim.minStake) return no("stake_too_small", `the minimum stake is ${lim.minStake}`, { price, maxStake });
    if (stake > lim.maxStake) return no("stake_too_large", `the maximum stake is ${lim.maxStake}`, { price, maxStake });
    if (stake + (this.staked.get(`${m.id}|${userId}`) ?? 0) > lim.userMarketCap) return no("user_limit", `you may stake ${lim.userMarketCap} in total on this market`, { price, maxStake });
    if (stake > this.balance(userId)) return no("insufficient_funds", "not enough credits", { price, maxStake });
    const risk = Math.floor((stake * price) / 100) - stake;
    if (risk < 1) return no("stake_too_small", "that stake is too small to return a profit at this price", { price, maxStake });
    if (risk + (this.liability.get(`${m.id}|${selectionId}`) ?? 0) > lim.selectionCap) return no("liability_limit", "the book is full on that selection", { price, maxStake });
    if (risk > this.houseBalance) return no("house_limit", "the house cannot cover that bet", { price, maxStake });

    const id = `${this.config.id}:b${this.bets.length + 1}`;
    if (this.wallet && !this.wallet.debit(userId, stake, id)) return no("insufficient_funds", "not enough credits", { price, maxStake });
    const t = this.now();
    try {
      this.ledger.post(
        "stake",
        id,
        [
          { account: this.acct(userId), delta: -stake },
          { account: HOUSE, delta: -risk },
          { account: this.escrow(m.id), delta: stake + risk },
        ],
        t,
      );
    } catch (e) {
      this.wallet?.credit(userId, stake, "refund", id);
      throw e;
    }
    const bet: Bet = { id, key, userId, marketId, selectionId, stake, price, risk, placedAt: t, status: "open", payout: 0, settledAt: null };
    this.index(bet);
    return { ok: true, bet, duplicate: false };
  }

  private index(bet: Bet) {
    this.bets.push(bet);
    this.byId.set(bet.id, bet);
    this.byKey.set(`${bet.userId}|${bet.key}`, bet);
    let list = this.byMarket.get(bet.marketId);
    if (!list) this.byMarket.set(bet.marketId, (list = []));
    list.push(bet);
    if (bet.status === "open") this.hold(bet, 1);
  }

  private hold(bet: Bet, sign: 1 | -1) {
    const lk = `${bet.marketId}|${bet.selectionId}`;
    const sk = `${bet.marketId}|${bet.userId}`;
    this.liability.set(lk, (this.liability.get(lk) ?? 0) + sign * bet.risk);
    this.staked.set(sk, (this.staked.get(sk) ?? 0) + sign * bet.stake);
  }

  /* ---------------------------------------------------------------------------------------------- */
  /* Settlement                                                                                      */
  /* ---------------------------------------------------------------------------------------------- */

  /**
   * Pay out a closed market. Every selection needs a grade, and the grades may not pay more winners than the
   * market allows. Each bet is paid in its own ledger entry; a repeat call with the same grades pays nothing
   * new, and a call with different grades on a settled market is refused.
   */
  settle(marketId: string, grades: Record<string, Grade>): void {
    const m = this.market(marketId);
    let paid = 0;
    for (const s of m.selections) {
      const g = grades[s.id];
      if (!validGrade(g)) throw new BookError(`market ${marketId}: no valid grade for ${s.id}`);
      if (g !== "void") paid += g.num / g.den;
    }
    if (paid > m.winners + 1e-9) throw new BookError(`market ${marketId}: grades pay ${paid} winners, the market allows ${m.winners}`);
    if (m.status === "settled") {
      if (m.selections.every((s) => sameGrade(m.grades![s.id], grades[s.id]))) return;
      throw new BookError(`market ${marketId} is already settled with a different result`);
    }
    if (m.status !== "closed") throw new BookError(`market ${marketId} is ${m.status}: close it before settling`);
    if (m.grades && !m.selections.every((s) => sameGrade(m.grades![s.id], grades[s.id]))) throw new BookError(`market ${marketId}: settlement already began with a different result`);
    m.grades = Object.fromEntries(m.selections.map((s) => [s.id, grades[s.id]]));
    for (const bet of this.betsOn(marketId)) {
      if (bet.status !== "open") continue;
      const g = m.grades[bet.selectionId];
      const payout = payoutFor(bet.stake, bet.price, g);
      this.release(bet, payout, g === "void" ? "refund" : "settle");
      bet.status = g === "void" ? "void" : payout === 0 ? "lost" : g.num === g.den ? "won" : "part";
    }
    m.status = "settled";
  }

  /** Call the market off: every open bet gets its stake back. For abandoned fixtures and aborted seasons. */
  voidMarket(marketId: string, note: string): void {
    const m = this.market(marketId);
    if (m.status === "void") return;
    if (m.status === "settled") throw new BookError(`market ${marketId} is already settled`);
    for (const bet of this.betsOn(marketId)) {
      if (bet.status !== "open") continue;
      this.release(bet, bet.stake, "refund");
      bet.status = "void";
    }
    m.status = "void";
    m.note = note;
  }

  /** Empty a bet's escrow: `payout` to the bettor, the rest to the house. */
  private release(bet: Bet, payout: number, kind: "settle" | "refund") {
    const held = bet.stake + bet.risk;
    if (payout < 0 || payout > held) throw new BookError(`bet ${bet.id}: payout ${payout} exceeds its escrow ${held}`);
    const t = this.now();
    this.ledger.post(
      kind,
      bet.id,
      [
        { account: this.escrow(bet.marketId), delta: -held },
        { account: this.acct(bet.userId), delta: payout },
        { account: HOUSE, delta: held - payout },
      ],
      t,
    );
    this.hold(bet, -1);
    bet.payout = payout;
    bet.settledAt = t;
    if (payout > 0) this.wallet?.credit(bet.userId, payout, kind === "refund" ? "refund" : "payout", bet.id);
  }

  /* ---------------------------------------------------------------------------------------------- */
  /* Audit and persistence                                                                           */
  /* ---------------------------------------------------------------------------------------------- */

  /**
   * Check the whole book against itself from first principles: the ledger chain, every bet against its ledger
   * entries, every payout against its market's grades, every escrow against the bets it should be holding,
   * and every limit. Returns what is wrong (empty = sound). Cheap enough to run after every operation in tests.
   */
  audit(): string[] {
    const bad = this.ledger.verify();
    const byRef = new Map<string, Entry[]>();
    for (const e of this.ledger.entries) {
      let l = byRef.get(e.ref);
      if (!l) byRef.set(e.ref, (l = []));
      l.push(e);
    }
    const leg = (e: Entry, account: string) => e.legs.find((x) => x.account === account)?.delta ?? 0;
    const escrowDue = new Map<string, number>();
    const liability = new Map<string, number>();
    const staked = new Map<string, number>();
    const keys = new Set<string>();
    this.bets.forEach((b, i) => {
      const m = this.markets.get(b.marketId);
      if (b.id !== `${this.config.id}:b${i + 1}`) bad.push(`bet ${b.id}: out of sequence`);
      if (keys.has(`${b.userId}|${b.key}`)) bad.push(`bet ${b.id}: key ${b.key} used twice`);
      keys.add(`${b.userId}|${b.key}`);
      if (!m) return void bad.push(`bet ${b.id}: market ${b.marketId} is missing`);
      if (!m.selections.some((s) => s.id === b.selectionId)) bad.push(`bet ${b.id}: selection ${b.selectionId} is not in its market`);
      if (!Number.isSafeInteger(b.stake) || b.stake < 1 || b.price < MIN_PRICE || b.risk !== Math.floor((b.stake * b.price) / 100) - b.stake || b.risk < 1) bad.push(`bet ${b.id}: stake, price and risk do not agree`);
      const entries = byRef.get(b.id) ?? [];
      const stakes = entries.filter((e) => e.kind === "stake");
      const outs = entries.filter((e) => e.kind === "settle" || e.kind === "refund");
      const esc = this.escrow(b.marketId);
      const user = this.acct(b.userId);
      if (stakes.length !== 1 || leg(stakes[0], user) !== -b.stake || leg(stakes[0], HOUSE) !== -b.risk || leg(stakes[0], esc) !== b.stake + b.risk) bad.push(`bet ${b.id}: stake entry missing or wrong`);
      if (b.status === "open") {
        if (outs.length) bad.push(`bet ${b.id}: open but already paid`);
        if (m.status === "settled" || m.status === "void") bad.push(`bet ${b.id}: open on a ${m.status} market`);
        escrowDue.set(esc, (escrowDue.get(esc) ?? 0) + b.stake + b.risk);
        liability.set(`${b.marketId}|${b.selectionId}`, (liability.get(`${b.marketId}|${b.selectionId}`) ?? 0) + b.risk);
        staked.set(`${b.marketId}|${b.userId}`, (staked.get(`${b.marketId}|${b.userId}`) ?? 0) + b.stake);
        return;
      }
      if (outs.length !== 1) return void bad.push(`bet ${b.id}: ${outs.length} payout entries`);
      const out = outs[0];
      const viaVoid = m.status === "void";
      const g: Grade | undefined = viaVoid ? "void" : m.grades?.[b.selectionId];
      if (!g) return void bad.push(`bet ${b.id}: settled without a grade`);
      const due = payoutFor(b.stake, b.price, g);
      const want: BetStatus = g === "void" ? "void" : due === 0 ? "lost" : g.num === g.den ? "won" : "part";
      if (b.payout !== due || b.status !== want) bad.push(`bet ${b.id}: paid ${b.payout} as ${b.status}, should be ${due} as ${want}`);
      if (leg(out, esc) !== -(b.stake + b.risk) || leg(out, user) !== b.payout || leg(out, HOUSE) !== b.stake + b.risk - b.payout) bad.push(`bet ${b.id}: payout entry wrong`);
      if ((out.kind === "refund") !== (g === "void")) bad.push(`bet ${b.id}: entry kind ${out.kind} does not match its grade`);
    });
    for (const m of this.markets.values()) {
      const esc = this.escrow(m.id);
      if (this.ledger.balance(esc) !== (escrowDue.get(esc) ?? 0)) bad.push(`${esc}: holds ${this.ledger.balance(esc)}, open bets need ${escrowDue.get(esc) ?? 0}`);
      const lim = this.config.limits[m.scope];
      for (const s of m.selections) {
        const l = liability.get(`${m.id}|${s.id}`) ?? 0;
        if (l > lim.selectionCap) bad.push(`market ${m.id}: liability ${l} on ${s.id} is over the cap`);
        if ((this.liability.get(`${m.id}|${s.id}`) ?? 0) !== l) bad.push(`market ${m.id}: cached liability on ${s.id} is stale`);
      }
      if (m.status === "settled") {
        if (!m.grades) bad.push(`market ${m.id}: settled without grades`);
        else if (m.selections.reduce((n, s) => n + (m.grades![s.id] === "void" ? 0 : (m.grades![s.id] as { num: number; den: number }).num / (m.grades![s.id] as { num: number; den: number }).den), 0) > m.winners + 1e-9) bad.push(`market ${m.id}: paid more winners than allowed`);
      }
    }
    for (const [k, v] of staked) {
      const [marketId] = k.split("|");
      const m = this.markets.get(marketId);
      if (m && v > this.config.limits[m.scope].userMarketCap) bad.push(`market ${marketId}: a user has ${v} staked, over the cap`);
      if ((this.staked.get(k) ?? 0) !== v) bad.push(`market ${marketId}: cached user stake is stale`);
    }
    for (const [account, v] of this.ledger.accounts()) {
      if (account.startsWith("escrow:") && !this.markets.has(account.slice(7)) && v !== 0) bad.push(`${account}: escrow for an unknown market`);
    }
    // Everything ever minted is in a wallet, the house bank or an escrow: nothing leaks.
    const minted = -this.ledger.balance(MINT);
    let held = 0;
    for (const [account, v] of this.ledger.accounts()) if (account !== MINT) held += v;
    if (minted !== held) bad.push(`minted ${minted} but accounts hold ${held}`);
    return bad;
  }

  /** The house's net result on a market so far: stakes kept minus payouts made, over settled bets. */
  housePnl(marketId: string): number {
    let pnl = 0;
    for (const b of this.betsOn(marketId)) if (b.status !== "open") pnl += b.stake - b.payout;
    return pnl;
  }

  toJSON(): BookJSON {
    return { v: 1, config: this.config, markets: [...this.markets.values()], bets: this.bets, ledger: this.ledger.entries };
  }

  /** Rebuild a book from its saved form and refuse it if the audit finds anything wrong. */
  static fromJSON(json: BookJSON, opts: { wallet?: WalletPort; now?: () => number } = {}): Book {
    if (!json || json.v !== 1) throw new BookError("unknown book format");
    const book = new Book(json.config, { ...opts, restore: structuredClone(json) });
    const bad = book.audit();
    if (bad.length) throw new BookError(`saved book fails its audit: ${bad.slice(0, 3).join("; ")}`);
    return book;
  }

  /** One hash over the whole book, for replay and determinism checks. */
  stateHash(): string {
    return sha256(JSON.stringify({ markets: [...this.markets.values()], bets: this.bets, head: this.ledger.head }));
  }
}

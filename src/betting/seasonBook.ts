import { LEAGUE_WEEKS, applyResult, isComplete, nextFixture, recordFor, type Fixture, type MatchOutcome, type MatchRecord, type SeasonState } from "../season/season";
import { simulateOutcome } from "../season/runner";
import { Book, BookError, type BookJSON, type Market, type WalletPort } from "./book";
import { commitOf, seedOf, verifyFair, type FairRecord } from "./fair";
import { gradeMarket, matchMarkets, roundMarket, seasonMarkets } from "./markets";
import type { Pricer, Simulate } from "./pricing";

/**
 * A season with a book on it: the one place that moves the season and its markets forward together.
 *
 *   open()               Price and open the markets for the next round, and reprice the season-long markets.
 *   lock(fixtureId)      Betting on that match closes; the week's round market closes with its first match;
 *                        season markets are suspended; the match seed is revealed (fair.ts).
 *   result(id, outcome)  The match is recorded, every market it decides is settled, and open() runs again.
 *
 * A round is one season week: two matches in a league week, then Last Chance, then the Grand Final. Season
 * markets stay open between matches and are closed for good just before the match that decides them starts:
 * the league markets with the last league match, "to reach the final" with Last Chance, "champion" with the
 * Grand Final.
 */

export interface SeasonBookJSON {
  v: 1;
  seasonId: string;
  season: SeasonState;
  fair: FairRecord[];
  /** Secrets not yet revealed. Server-private: never send this field to a client. */
  secrets: Record<string, string>;
  locked: string[];
  book: BookJSON;
}

export interface SeasonBookOptions {
  seasonId: string;
  season: SeasonState;
  book: Book;
  pricer: Pricer;
  /** A fresh unguessable string per call (hex from a CSPRNG on a server; a seeded stream in simulations). */
  entropy: () => string;
  /** How matches are played when the book runs them itself; must be the brain the pricer simulates. */
  simulate?: Simulate;
}

export class SeasonBook {
  readonly seasonId: string;
  season: SeasonState;
  readonly book: Book;
  readonly pricer: Pricer;
  private entropy: () => string;
  private simulate: Simulate;
  private fair = new Map<string, FairRecord>();
  private secrets = new Map<string, string>();
  private locked = new Set<string>();

  constructor(o: SeasonBookOptions) {
    this.seasonId = o.seasonId;
    this.season = o.season;
    this.book = o.book;
    this.pricer = o.pricer;
    this.entropy = o.entropy;
    this.simulate = o.simulate ?? simulateOutcome;
  }

  /* ---------------------------------------------------------------------------------------------- */
  /* Queries                                                                                         */
  /* ---------------------------------------------------------------------------------------------- */

  /** The unplayed fixtures of the round in progress (empty when the season is over). */
  round(): Fixture[] {
    const next = nextFixture(this.season);
    return next ? this.season.fixtures.filter((f) => f.week === next.week && !recordFor(this.season, f.id)) : [];
  }
  isLocked(fixtureId: string): boolean {
    return this.locked.has(fixtureId);
  }
  marketsFor(fixtureId: string): Market[] {
    return [...this.book.markets.values()].filter((m) => m.fixtureId === fixtureId);
  }
  seasonLong(): Market[] {
    return [...this.book.markets.values()].filter((m) => m.scope === "season");
  }
  private roundMarketOf(week: number): Market | undefined {
    return this.book.markets.get(`${this.seasonId}/w${week}/top`);
  }
  /** The public fairness records: commits for open fixtures, full reveals for locked and played ones. */
  fairness(): FairRecord[] {
    return [...this.fair.values()].map((r) => ({ ...r }));
  }

  /* ---------------------------------------------------------------------------------------------- */
  /* Lifecycle                                                                                       */
  /* ---------------------------------------------------------------------------------------------- */

  open(): void {
    const next = nextFixture(this.season);
    if (!next) return;
    const finals = this.pricer.rollouts(this.season);
    for (const fx of this.season.fixtures.filter((f) => f.week === next.week)) {
      if (recordFor(this.season, fx.id) || this.fair.has(fx.id)) continue;
      const secret = this.entropy();
      if (typeof secret !== "string" || secret.length < 16) throw new BookError("entropy source is too weak");
      this.secrets.set(fx.id, secret);
      this.fair.set(fx.id, { fixtureId: fx.id, commit: commitOf(this.seasonId, fx.id, secret), anchor: null, secret: null, seed: null });
      for (const spec of matchMarkets(this.seasonId, fx)) {
        const fitted = this.pricer.fit(spec, finals);
        this.book.addMarket(fitted, this.pricer.price(fitted, finals));
      }
    }
    if (next.stage === "league" && !this.roundMarketOf(next.week)) {
      const spec = roundMarket(this.seasonId, this.season, next.week);
      this.book.addMarket(spec, this.pricer.price(spec, finals));
    }
    const live = this.locked.size ? "suspended" : "open";
    const existing = this.seasonLong();
    if (!existing.length) {
      for (const spec of seasonMarkets(this.seasonId, this.season)) {
        const fitted = this.pricer.fit(spec, finals);
        this.book.addMarket(fitted, this.pricer.price(fitted, finals), live);
      }
    } else {
      for (const m of existing) {
        if (m.status !== "open" && m.status !== "suspended") continue;
        this.book.reprice(m.id, this.pricer.price(m, finals));
        this.book.setStatus(m.id, live);
      }
    }
  }

  /** Close betting on a fixture and reveal its seed. The fixture must be in the round in progress. */
  lock(fixtureId: string): number {
    const fx = this.round().find((f) => f.id === fixtureId);
    const rec = this.fair.get(fixtureId);
    const secret = this.secrets.get(fixtureId);
    if (!fx || !rec || secret === undefined) throw new BookError(`fixture ${fixtureId} is not open for betting`);
    if (this.locked.has(fixtureId)) throw new BookError(`fixture ${fixtureId} is already locked`);
    for (const m of this.marketsFor(fixtureId)) this.book.setStatus(m.id, "closed");
    const rm = this.roundMarketOf(fx.week);
    if (rm && (rm.status === "open" || rm.status === "suspended")) this.book.setStatus(rm.id, "closed");
    const lastOfLeague = fx.stage === "league" && this.season.fixtures.filter((f) => f.stage === "league" && f.id !== fixtureId).every((f) => recordFor(this.season, f.id) || this.locked.has(f.id)) && fx.week === LEAGUE_WEEKS;
    for (const m of this.seasonLong()) {
      if (m.status !== "open" && m.status !== "suspended") continue;
      const decidedNow = (lastOfLeague && (m.kind === "season_league" || m.kind === "season_hcap")) || (fx.stage === "lastchance" && m.kind === "season_finalist") || (fx.stage === "final" && m.kind === "season_champion");
      // A finalist market must also stop when Last Chance starts even if the league ran long; same rule.
      this.book.setStatus(m.id, decidedNow ? "closed" : "suspended");
    }
    const anchor = this.book.ledger.head;
    const seed = seedOf(secret, anchor);
    this.fair.set(fixtureId, { ...rec, anchor, secret, seed });
    this.secrets.delete(fixtureId);
    this.locked.add(fixtureId);
    this.season = { ...this.season, fixtures: this.season.fixtures.map((f) => (f.id === fixtureId ? { ...f, seed } : f)) };
    return seed;
  }

  /** Record a locked fixture's outcome, settle what it decides, and open what comes next. */
  result(fixtureId: string, outcome: MatchOutcome, simulated = false): MatchRecord {
    if (!this.locked.has(fixtureId)) throw new BookError(`fixture ${fixtureId} is not locked: betting must close before a result`);
    const fx = this.season.fixtures.find((f) => f.id === fixtureId)!;
    const ids = new Set(outcome.bots.map((b) => b.id));
    if (ids.size !== fx.bots.length || fx.bots.some((id) => !ids.has(id))) throw new BookError(`outcome for ${fixtureId} does not match its lineup`);
    const next = applyResult(this.season, fixtureId, outcome, simulated);
    const rec = recordFor(next, fixtureId);
    if (!rec || next === this.season) throw new BookError(`fixture ${fixtureId} could not be recorded`);
    this.season = next;
    this.locked.delete(fixtureId);
    for (const m of this.marketsFor(fixtureId)) this.settleIfDecided(m);
    const rm = this.roundMarketOf(fx.week);
    if (rm) this.settleIfDecided(rm);
    for (const m of this.seasonLong()) this.settleIfDecided(m);
    this.open();
    return rec;
  }

  private settleIfDecided(m: Market) {
    if (m.status === "settled" || m.status === "void") return;
    const grades = gradeMarket(m, this.season);
    if (!grades) return;
    this.book.setStatus(m.id, "closed");
    this.book.settle(m.id, grades);
  }

  /** Lock (if needed), run and record one fixture on the book's own simulator. */
  play(fixtureId: string): MatchRecord {
    if (!this.locked.has(fixtureId)) this.lock(fixtureId);
    const fx = this.season.fixtures.find((f) => f.id === fixtureId)!;
    return this.result(fixtureId, this.simulate(this.season, fx), true);
  }

  /** Play every fixture of the round in progress, in order. */
  playRound(): MatchRecord[] {
    return this.round().map((f) => this.play(f.id));
  }

  /** Call the rest of the season off: every unsettled market is voided and all open stakes go back. */
  abandon(note: string): void {
    for (const m of this.book.markets.values()) if (m.status !== "settled" && m.status !== "void") this.book.voidMarket(m.id, note);
    this.locked.clear();
    this.secrets.clear();
  }

  /* ---------------------------------------------------------------------------------------------- */
  /* Verification and persistence                                                                    */
  /* ---------------------------------------------------------------------------------------------- */

  /**
   * Everything a sceptic would check: the book's own audit, every revealed seed against its commit, every
   * simulated result against a replay from its seed, every settled market against a fresh grading, and that
   * no market is still taking bets on a match that has started. Returns what is wrong (empty = sound).
   */
  verify(): string[] {
    const bad = this.book.audit();
    for (const r of this.fair.values()) {
      const fx = this.season.fixtures.find((f) => f.id === r.fixtureId);
      const rec = recordFor(this.season, r.fixtureId);
      const started = rec || this.locked.has(r.fixtureId);
      if (!fx) {
        bad.push(`fairness record for unknown fixture ${r.fixtureId}`);
        continue;
      }
      if (started) {
        if (!verifyFair(this.seasonId, r)) bad.push(`fixture ${r.fixtureId}: seed does not follow from its commit`);
        if (fx.seed !== r.seed) bad.push(`fixture ${r.fixtureId}: played on seed ${fx.seed}, revealed ${r.seed}`);
        for (const m of this.marketsFor(r.fixtureId)) if (m.status === "open" || m.status === "suspended") bad.push(`market ${m.id}: still open after its match started`);
      } else if (r.secret !== null || r.seed !== null) bad.push(`fixture ${r.fixtureId}: seed revealed before betting closed`);
      if (rec?.simulated) {
        const again = applyResult({ ...this.season, records: this.season.records.filter((x) => x.fixtureId !== r.fixtureId) }, r.fixtureId, this.simulate(this.season, fx), true);
        const replay = recordFor(again, r.fixtureId);
        if (!replay || JSON.stringify(replay.rows) !== JSON.stringify(rec.rows)) bad.push(`fixture ${r.fixtureId}: recorded result does not replay from its seed`);
      }
    }
    for (const rec of this.season.records) if (!this.fair.has(rec.fixtureId)) bad.push(`fixture ${rec.fixtureId}: played without a commit`);
    for (const m of this.book.markets.values()) {
      const grades = gradeMarket(m, this.season);
      if (m.status === "settled") {
        if (!grades) bad.push(`market ${m.id}: settled but the season does not decide it yet`);
        else if (JSON.stringify(grades) !== JSON.stringify(m.grades)) bad.push(`market ${m.id}: settled grades differ from the season's result`);
      } else if (m.status !== "void" && grades) bad.push(`market ${m.id}: decided but not settled`);
    }
    return bad;
  }

  toJSON(): SeasonBookJSON {
    return { v: 1, seasonId: this.seasonId, season: this.season, fair: this.fairness(), secrets: Object.fromEntries(this.secrets), locked: [...this.locked], book: this.book.toJSON() };
  }

  static fromJSON(json: SeasonBookJSON, o: { pricer: Pricer; entropy: () => string; simulate?: Simulate; wallet?: WalletPort; now?: () => number }): SeasonBook {
    if (!json || json.v !== 1) throw new BookError("unknown season book format");
    const sb = new SeasonBook({ seasonId: json.seasonId, season: structuredClone(json.season), book: Book.fromJSON(json.book, { wallet: o.wallet, now: o.now }), pricer: o.pricer, entropy: o.entropy, simulate: o.simulate });
    for (const r of json.fair) sb.fair.set(r.fixtureId, { ...r });
    for (const [k, v] of Object.entries(json.secrets)) sb.secrets.set(k, v);
    for (const id of json.locked) sb.locked.add(id);
    return sb;
  }
}

export { isComplete };

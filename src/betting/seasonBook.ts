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
 *   adopt(season)        The same settlement for a season that is advanced elsewhere (the browser's arena).
 *
 * A round is one season week: two matches in a league week, then Last Chance, then the Grand Final. Season
 * markets stay open between matches and are closed for good just before the match that decides them starts:
 * the league markets with the last league match, "to reach the final" with Last Chance, "champion" with the
 * Grand Final.
 *
 * A book may outlive a season (the server keeps one book and its wallets for ever), so a SeasonBook only ever
 * touches the markets whose ids start with its own season id.
 */

export interface SeasonBookJSON {
  v: 1;
  seasonId: string;
  season: SeasonState;
  fair: FairRecord[];
  /** Secrets not yet revealed. Server-private: never send this field to a client. */
  secrets: Record<string, string>;
  locked: string[];
  /** Matches already played when the book was opened on the season (0 for a book that saw the whole season). */
  from: number;
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
  private from: number;

  constructor(o: SeasonBookOptions) {
    this.seasonId = o.seasonId;
    this.season = o.season;
    this.book = o.book;
    this.pricer = o.pricer;
    this.entropy = o.entropy;
    this.simulate = o.simulate ?? simulateOutcome;
    this.from = o.season.records.length;
  }

  /* ---------------------------------------------------------------------------------------------- */
  /* Queries                                                                                         */
  /* ---------------------------------------------------------------------------------------------- */

  /** This season's markets (the book may hold other seasons' too). */
  markets(): Market[] {
    const prefix = `${this.seasonId}/`;
    return [...this.book.markets.values()].filter((m) => m.id.startsWith(prefix));
  }
  /** The unplayed fixtures of the round in progress (empty when the season is over). */
  round(): Fixture[] {
    const next = nextFixture(this.season);
    return next ? this.season.fixtures.filter((f) => f.week === next.week && !recordFor(this.season, f.id)) : [];
  }
  isLocked(fixtureId: string): boolean {
    return this.locked.has(fixtureId);
  }
  marketsFor(fixtureId: string): Market[] {
    return this.markets().filter((m) => m.fixtureId === fixtureId);
  }
  seasonLong(): Market[] {
    return this.markets().filter((m) => m.scope === "season");
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

  private commit(fixtureId: string) {
    const secret = this.entropy();
    if (typeof secret !== "string" || secret.length < 16) throw new BookError("entropy source is too weak");
    this.secrets.set(fixtureId, secret);
    this.fair.set(fixtureId, { fixtureId, commit: commitOf(this.seasonId, fixtureId, secret), anchor: null, secret: null, seed: null });
  }

  /**
   * Open the next round's markets and reprice the season-long ones. `finals` are rollouts of the season as it
   * stands (Pricer.rollouts); pass them when they were computed elsewhere, such as in slices in a browser.
   */
  open(finals: SeasonState[] = this.pricer.rollouts(this.season)): void {
    const next = nextFixture(this.season);
    if (!next) return;
    for (const fx of this.season.fixtures.filter((f) => f.week === next.week)) {
      if (recordFor(this.season, fx.id) || this.fair.has(fx.id)) continue;
      this.commit(fx.id);
      for (const spec of matchMarkets(this.seasonId, fx)) {
        const fitted = this.pricer.fit(spec, finals);
        this.book.addMarket(fitted, this.pricer.price(fitted, finals));
      }
    }
    // The week's market is offered only before any of the week's matches has started.
    const weekStarted = this.season.fixtures.some((f) => f.week === next.week && (recordFor(this.season, f.id) || this.locked.has(f.id)));
    if (next.stage === "league" && !weekStarted && !this.roundMarketOf(next.week)) {
      const spec = roundMarket(this.seasonId, this.season, next.week);
      this.book.addMarket(spec, this.pricer.price(spec, finals));
    }
    const live = this.locked.size ? "suspended" : "open";
    const existing = this.seasonLong();
    if (!existing.length) {
      for (const spec of seasonMarkets(this.seasonId, this.season)) {
        const fitted = this.pricer.fit(spec, finals);
        if (gradeMarket(fitted, this.season)) continue; // already decided when the book arrived
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

  /** Close betting on a fixture of the round in progress and reveal its seed. */
  lock(fixtureId: string): number {
    const fx = this.round().find((f) => f.id === fixtureId);
    if (!fx) throw new BookError(`fixture ${fixtureId} is not in the round in progress`);
    if (this.locked.has(fixtureId)) throw new BookError(`fixture ${fixtureId} is already locked`);
    return this.seal(fx);
  }

  private seal(fx: Fixture): number {
    // A fixture whose markets were never opened (it started before its prices were ready) still gets a seed
    // nobody could have known: commit and reveal in one step.
    if (!this.fair.has(fx.id)) this.commit(fx.id);
    const rec = this.fair.get(fx.id)!;
    const secret = this.secrets.get(fx.id);
    if (secret === undefined) throw new BookError(`fixture ${fx.id} has no secret to reveal`);
    for (const m of this.marketsFor(fx.id)) if (m.status === "open" || m.status === "suspended") this.book.setStatus(m.id, "closed");
    const rm = this.roundMarketOf(fx.week);
    if (rm && (rm.status === "open" || rm.status === "suspended")) this.book.setStatus(rm.id, "closed");
    const lastOfLeague = fx.stage === "league" && fx.week === LEAGUE_WEEKS && this.season.fixtures.filter((f) => f.stage === "league" && f.id !== fx.id).every((f) => recordFor(this.season, f.id) || this.locked.has(f.id));
    for (const m of this.seasonLong()) {
      if (m.status !== "open" && m.status !== "suspended") continue;
      const decidedByThis = (lastOfLeague && (m.kind === "season_league" || m.kind === "season_hcap")) || (fx.stage === "lastchance" && m.kind === "season_finalist") || (fx.stage === "final" && m.kind === "season_champion");
      this.book.setStatus(m.id, decidedByThis ? "closed" : "suspended");
    }
    const anchor = this.book.ledger.head;
    const seed = seedOf(secret, anchor);
    this.fair.set(fx.id, { ...rec, anchor, secret, seed });
    this.secrets.delete(fx.id);
    this.locked.add(fx.id);
    this.season = { ...this.season, fixtures: this.season.fixtures.map((f) => (f.id === fx.id ? { ...f, seed } : f)) };
    return seed;
  }

  /** Record a locked fixture's outcome, settle what it decides, and (unless told not to) open what comes next. */
  result(fixtureId: string, outcome: MatchOutcome, simulated = false, reopen = true): MatchRecord {
    if (!this.locked.has(fixtureId)) throw new BookError(`fixture ${fixtureId} is not locked: betting must close before a result`);
    const fx = this.season.fixtures.find((f) => f.id === fixtureId)!;
    const ids = new Set(outcome.bots.map((b) => b.id));
    if (ids.size !== fx.bots.length || fx.bots.some((id) => !ids.has(id))) throw new BookError(`outcome for ${fixtureId} does not match its lineup`);
    const next = applyResult(this.season, fixtureId, outcome, simulated);
    const rec = recordFor(next, fixtureId);
    if (!rec || next === this.season) throw new BookError(`fixture ${fixtureId} could not be recorded`);
    this.adopt(next);
    if (reopen) this.open();
    return rec;
  }

  /**
   * Take on a season that was advanced elsewhere: it must be this season with zero or more further results.
   * Any newly played fixture that was somehow still open is closed first, then every market the season now
   * decides is settled. Does not open new markets; call open() for that.
   */
  adopt(next: SeasonState): MatchRecord[] {
    const mine = this.season;
    if (next.seed !== mine.seed || next.entrants.length !== mine.entrants.length || next.entrants.some((e, i) => e.id !== mine.entrants[i].id)) throw new BookError("that is a different season");
    if (next.records.length < mine.records.length || mine.records.some((r, i) => next.records[i].fixtureId !== r.fixtureId)) throw new BookError("that season does not continue this one");
    const fresh = next.records.slice(mine.records.length);
    for (const rec of fresh) {
      const fx = next.fixtures.find((f) => f.id === rec.fixtureId);
      if (fx && !this.locked.has(fx.id)) this.seal(fx);
      this.locked.delete(rec.fixtureId);
    }
    // Keep the revealed seed on any fixture that is locked but not yet played.
    this.season = { ...next, fixtures: next.fixtures.map((f) => (this.locked.has(f.id) && this.fair.get(f.id)?.seed != null ? { ...f, seed: this.fair.get(f.id)!.seed! } : f)) };
    for (const m of this.markets()) this.settleIfDecided(m);
    return fresh;
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
    for (const m of this.markets()) if (m.status !== "settled" && m.status !== "void") this.book.voidMarket(m.id, note);
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
        const again = applyResult({ ...this.season, records: this.season.records.filter((x) => x.fixtureId !== r.fixtureId) }, r.fixtureId, this.simulate(this.season, fx), true, true);
        const replay = recordFor(again, r.fixtureId);
        if (!replay || JSON.stringify(replay.rows) !== JSON.stringify(rec.rows)) bad.push(`fixture ${r.fixtureId}: recorded result does not replay from its seed`);
      }
    }
    this.season.records.forEach((rec, i) => {
      if (i >= this.from && !this.fair.has(rec.fixtureId)) bad.push(`fixture ${rec.fixtureId}: played without a commit`);
    });
    for (const m of this.markets()) {
      const grades = gradeMarket(m, this.season);
      if (m.status === "settled") {
        if (!grades) bad.push(`market ${m.id}: settled but the season does not decide it yet`);
        else if (JSON.stringify(grades) !== JSON.stringify(m.grades)) bad.push(`market ${m.id}: settled grades differ from the season's result`);
      } else if (m.status !== "void" && grades) bad.push(`market ${m.id}: decided but not settled`);
    }
    return bad;
  }

  toJSON(): SeasonBookJSON {
    return { v: 1, seasonId: this.seasonId, season: this.season, fair: this.fairness(), secrets: Object.fromEntries(this.secrets), locked: [...this.locked], from: this.from, book: this.book.toJSON() };
  }

  static fromJSON(json: SeasonBookJSON, o: { pricer: Pricer; entropy: () => string; simulate?: Simulate; wallet?: WalletPort; now?: () => number; describe?: (m: Market, selectionId: string) => string }): SeasonBook {
    if (!json || json.v !== 1) throw new BookError("unknown season book format");
    const sb = new SeasonBook({ seasonId: json.seasonId, season: structuredClone(json.season), book: Book.fromJSON(json.book, { wallet: o.wallet, now: o.now, describe: o.describe }), pricer: o.pricer, entropy: o.entropy, simulate: o.simulate });
    for (const r of json.fair) sb.fair.set(r.fixtureId, { ...r });
    for (const [k, v] of Object.entries(json.secrets)) sb.secrets.set(k, v);
    for (const id of json.locked) sb.locked.add(id);
    sb.from = Number.isSafeInteger(json.from) ? json.from : 0;
    return sb;
  }
}

export { isComplete };

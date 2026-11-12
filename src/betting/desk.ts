import { accounts } from "../account/accounts";
import { isComplete, type MatchRecord, type SeasonState } from "../season/season";
import { Book, defaultBookConfig, type BetResult, type Bet, type Market, type WalletPort } from "./book";
import { selectionText } from "./markets";
import { DEFAULT_PRICING, Pricer } from "./pricing";
import { SeasonBook, type SeasonBookJSON } from "./seasonBook";

/**
 * The betting desk: the browser's glue between the season being played on this machine, the book, and the
 * users' wallets (src/account). One book per season, saved in localStorage beside the season itself.
 *
 * The desk follows the season rather than driving it. SeasonMode stays in charge of fixtures and results and
 * tells the desk three things: a season started, a fixture is about to be fought (betting on it closes and it
 * gets its revealed seed), and a result was recorded (bets settle, the next prices are worked out).
 *
 * Pricing simulates a few hundred matches, so it runs in slices between frames and reports progress; the
 * season never waits for it. A match started before its prices were ready simply has no markets.
 *
 * On this machine the player owns the storage the secrets live in, so the commit-reveal scheme is a rehearsal
 * here, not a defence. It becomes one when the same SeasonBook runs on a server (server/betting.ts).
 */

const KEY = "s1.betting.v1";
/** Smaller than the server's: this runs on the main thread of a browser. */
export const BROWSER_PRICING = { ...DEFAULT_PRICING, poolSize: 48, hypoMax: 16, rollouts: 500 };
/** A user with less than this at the start of a season is topped up to it, so nobody is locked out for good. */
export const SEASON_STIPEND = 100;

const entropy = () => {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
};
const sameSeason = (a: SeasonState, b: SeasonState) => a.seed === b.seed && a.startedAt === b.startedAt && a.entrants.length === b.entrants.length && a.entrants.every((e, i) => e.id === b.entrants[i].id);

const wallet: WalletPort = {
  balance: (id) => accounts.get(id)?.balance ?? 0,
  debit: (id, amount, ref, note) => accounts.debit(id, amount, "stake", note, ref),
  credit: (id, amount, kind, ref, note) => accounts.credit(id, amount, kind, note, ref),
};

export class BettingDesk {
  sb: SeasonBook | null = null;
  status: "off" | "pricing" | "ready" = "off";
  /** 0..1 while pricing. */
  progress = 0;
  private pricer = new Pricer({ ...BROWSER_PRICING, seed: (Date.now() ^ (Math.random() * 2 ** 31)) >>> 0 });
  private job = 0;

  /** `notify` is called whenever what the betting panel shows may have moved. */
  constructor(private notify: (what: "state" | "progress") => void) {}

  private changed(what: "state" | "progress" = "state") {
    this.notify(what);
  }

  private describe = (m: Market, selectionId: string) => `${selectionText(m, selectionId)} · ${m.label}`;

  private newBook(s: SeasonState) {
    const seasonId = `s${s.startedAt.toString(36)}-${s.seed}`;
    const book = new Book(defaultBookConfig(seasonId), { wallet, describe: this.describe });
    this.sb = new SeasonBook({ seasonId, season: s, book, pricer: this.pricer, entropy });
  }

  /** At start-up: pick the saved book back up if it belongs to the saved season, otherwise wind it up. */
  attach(s: SeasonState | null): void {
    let json: SeasonBookJSON | null = null;
    try {
      const raw = localStorage.getItem(KEY);
      json = raw ? (JSON.parse(raw) as SeasonBookJSON) : null;
    } catch {
      json = null;
    }
    if (json) {
      try {
        // fromJSON audits the saved book; a file that does not add up is refused, never patched.
        const sb = SeasonBook.fromJSON(json, { pricer: this.pricer, entropy, wallet, describe: this.describe });
        if (s && sameSeason(s, sb.season)) {
          this.sb = sb;
          sb.adopt(s);
        } else {
          sb.abandon("the season ended");
          this.sb = null;
        }
      } catch {
        this.sb = null;
      }
    }
    if (!this.sb && s && !isComplete(s)) this.newBook(s);
    this.save();
    if (this.sb && !isComplete(this.sb.season)) void this.reprice();
  }

  /** A new season: refund anything riding on the old one, stake the broke, open a fresh book. */
  start(s: SeasonState): void {
    this.end("a new season started");
    for (const p of accounts.profiles) if (p.balance < SEASON_STIPEND) accounts.credit(p.id, SEASON_STIPEND - p.balance, "grant", "House stake for the new season");
    this.newBook(s);
    this.save();
    void this.reprice();
  }

  /** The season was abandoned or replaced: every unsettled bet is void and its stake returned. */
  end(reason: string): void {
    this.job++;
    this.sb?.abandon(reason);
    this.sb = null;
    this.status = "off";
    this.save();
  }

  /**
   * The season must never wait on, or be broken by, its book. If the book and the season ever disagree, the
   * book is wound up (every open stake refunded) and the season carries on without betting.
   */
  private guard<T>(fallback: T, fn: () => T): T {
    try {
      return fn();
    } catch (e) {
      console.error("[betting] the book fell out of step with the season and was closed:", e);
      try {
        this.end("the book fell out of step with the season");
      } catch {
        this.sb = null;
        this.status = "off";
      }
      this.changed();
      return fallback;
    }
  }

  /** A fixture is about to be fought: betting on it closes for good. Returns the season to play, seed revealed. */
  beforeFixture(s: SeasonState, fixtureId: string): SeasonState {
    return this.guard(s, () => {
      const sb = this.sb;
      if (!sb || !sameSeason(s, sb.season)) return s;
      if (!sb.isLocked(fixtureId)) {
        sb.adopt(s);
        sb.lock(fixtureId);
        this.save();
        this.changed();
      }
      const seed = sb.season.fixtures.find((f) => f.id === fixtureId)?.seed;
      return seed === undefined ? s : { ...s, fixtures: s.fixtures.map((f) => (f.id === fixtureId ? { ...f, seed } : f)) };
    });
  }

  /** A result was recorded: settle what it decides, then price what comes next. */
  onResult(s: SeasonState, _rec: MatchRecord): void {
    this.guard(undefined, () => {
      const sb = this.sb;
      if (!sb || !sameSeason(s, sb.season)) return;
      sb.adopt(s);
      this.save();
      this.changed();
      if (!isComplete(s)) void this.reprice();
      else this.status = "ready";
    });
  }

  place(userId: string, marketId: string, selectionId: string, stake: number, minPrice: number): BetResult {
    if (!this.sb) return { ok: false, code: "market_closed", message: "there is no season to bet on" };
    const r = this.sb.book.placeBet({ userId, key: `ui-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`, marketId, selectionId, stake, minPrice });
    if (r.ok) this.save();
    return r;
  }

  betsOf(userId: string): Bet[] {
    return this.sb ? this.sb.book.betsOf(userId) : [];
  }

  private save() {
    try {
      if (this.sb) localStorage.setItem(KEY, JSON.stringify(this.sb.toJSON()));
      else localStorage.removeItem(KEY);
    } catch {
      /* private mode: the book lives for this session only */
    }
  }

  /** Work out the next prices in slices. A newer call supersedes an older one still running. */
  private async reprice(): Promise<void> {
    const sb = this.sb;
    if (!sb) return;
    const job = ++this.job;
    this.status = "pricing";
    this.progress = 0;
    this.changed();
    let shown = 0;
    let failed = false;
    const finals = await this.pricer
      .rolloutsAsync(sb.season, async (frac) => {
        await new Promise((r) => setTimeout(r, 0));
        if (job !== this.job) return false;
        this.progress = frac;
        if (frac - shown >= 0.04) {
          shown = frac;
          this.changed("progress");
        }
        return true;
      })
      .catch((e) => {
        console.error("[betting] pricing failed:", e);
        failed = true;
        return null;
      });
    if (failed && job === this.job) {
      // No new prices: whatever was already open stays as it was, and the panel stops saying "pricing".
      this.status = "ready";
      this.changed();
    }
    if (!finals || job !== this.job || this.sb !== sb) return;
    this.guard(undefined, () => {
      sb.open(finals);
      this.status = "ready";
      this.progress = 1;
      this.save();
      this.changed();
    });
  }
}

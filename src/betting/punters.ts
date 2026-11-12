import type { BetRequest, Market, Quote, RejectCode } from "./book";
import type { Prices } from "./pricing";
import type { SeasonBook } from "./seasonBook";

/**
 * A simulated betting public, for developing the book before real people use it. Each punter is a small
 * policy that looks at the open markets and places bets through the same placeBet() a real client would.
 *
 *   mug        Bets at random.
 *   favourite  Backs the shortest price in every match.
 *   longshot   Backs the longest price in every match and for the title.
 *   fan        Backs one bot whenever it fights, and for the title.
 *   handicap   Plays the handicap and fight-length lines, picking sides at random.
 *   sharp      Has its own, better-sampled model of the game and bets only where the offered price beats it.
 *              Several sharps share one model: a syndicate spreading stakes over accounts.
 *   whale      Many accounts all hammering the favourite at the maximum stake, to drive a selection into its
 *              liability cap.
 *   fuzzer     Sends malformed, stale, duplicate and out-of-range requests. None of them may ever be accepted.
 */

export type Style = "mug" | "favourite" | "longshot" | "fan" | "handicap" | "sharp" | "whale" | "fuzzer";

export interface PunterStats {
  requests: number;
  accepted: number;
  staked: number;
  rejected: Partial<Record<RejectCode, number>>;
  /** Fuzzer only: requests that were invalid by construction but were accepted anyway. Must stay 0. */
  breaches: number;
}

export interface Window {
  sb: SeasonBook;
  rand: () => number;
  /** A counter that makes idempotency keys unique per betting window. */
  n: number;
  /** The sharps' own model: fair probabilities per market selection. */
  view?: Map<string, Prices>;
}

export class Punter {
  readonly stats: PunterStats = { requests: 0, accepted: 0, staked: 0, rejected: {}, breaches: 0 };
  private seq = 0;
  private done = new Set<string>();

  constructor(
    readonly id: string,
    readonly style: Style,
    private fav: string | null = null,
  ) {}

  private place(w: Window, m: Market, q: Quote, stake: number): boolean {
    const s = Math.max(1, Math.min(Math.floor(stake), q.maxStake));
    if (q.maxStake < 1) return false;
    return this.send(w, { userId: this.id, key: `w${w.n}-${this.seq++}`, marketId: m.id, selectionId: q.selectionId, stake: s, minPrice: q.price });
  }

  private send(w: Window, req: BetRequest): boolean {
    this.stats.requests++;
    const r = w.sb.book.placeBet(req);
    if (r.ok) {
      if (!r.duplicate) {
        this.stats.accepted++;
        this.stats.staked += r.bet.stake;
      }
      return true;
    }
    this.stats.rejected[r.code] = (this.stats.rejected[r.code] ?? 0) + 1;
    return false;
  }

  act(w: Window): void {
    const book = w.sb.book;
    const bank = book.balance(this.id);
    const open = [...book.markets.values()].filter((m) => m.status === "open");
    const offers = (m: Market) => book.quote(m.id, this.id).filter((q) => q.price > 0 && q.maxStake > 0);
    const pick = <T>(xs: T[]) => xs[Math.floor(w.rand() * xs.length)];
    const once = (m: Market) => (this.done.has(m.id) ? false : (this.done.add(m.id), true));
    if (this.style === "fuzzer") return this.fuzz(w, open);
    if (bank < 1) return;

    switch (this.style) {
      case "mug": {
        if (w.rand() < 0.4 || !open.length) return;
        for (let i = 1 + Math.floor(w.rand() * 3); i > 0; i--) {
          const m = pick(open);
          const qs = offers(m);
          if (qs.length) this.place(w, m, pick(qs), bank * (0.01 + w.rand() * 0.04));
        }
        return;
      }
      case "favourite":
      case "longshot": {
        for (const m of open) {
          const wanted = m.kind === "match_win" || (this.style === "longshot" && m.kind === "season_champion");
          if (!wanted || !once(m)) continue;
          const qs = offers(m).sort((a, b) => (this.style === "favourite" ? a.price - b.price : b.price - a.price));
          if (qs.length) this.place(w, m, qs[0], bank * (this.style === "favourite" ? 0.04 : 0.015));
        }
        return;
      }
      case "fan": {
        for (const m of open) {
          if (!["match_win", "match_top2", "season_champion", "season_finalist"].includes(m.kind) || !once(m)) continue;
          const q = offers(m).find((x) => x.selectionId === this.fav);
          if (q) this.place(w, m, q, bank * 0.03);
        }
        return;
      }
      case "handicap": {
        for (const m of open) {
          if (!["match_hcap", "match_time", "season_hcap", "round_top"].includes(m.kind) || !once(m) || w.rand() < 0.5) continue;
          const qs = offers(m);
          if (qs.length) this.place(w, m, pick(qs), bank * 0.03);
        }
        return;
      }
      case "sharp": {
        // Bet where our probability times the offered odds is clearly above 1; stake half-Kelly.
        for (const m of open) {
          const view = w.view?.get(m.id);
          if (!view) continue;
          for (const q of offers(m)) {
            const p = view[q.selectionId]?.prob ?? 0;
            const odds = q.price / 100;
            const edge = p * odds - 1;
            if (edge < 0.04) continue;
            this.place(w, m, q, (bank * 0.5 * edge) / (odds - 1));
          }
        }
        return;
      }
      case "whale": {
        for (const m of open) {
          if (m.kind !== "match_win") continue;
          const qs = offers(m).sort((a, b) => a.price - b.price);
          if (qs.length) this.place(w, m, qs[0], qs[0].maxStake);
        }
        return;
      }
    }
  }

  /** Every request here is invalid by construction; count any that gets through. */
  private fuzz(w: Window, open: Market[]) {
    const book = w.sb.book;
    const all = [...book.markets.values()];
    const shut = all.filter((m) => m.status !== "open");
    const head = book.ledger.head;
    const bets = book.bets.length;
    const m = open[Math.floor(w.rand() * open.length)];
    const sel = m?.selections[0].id ?? "x";
    const base: BetRequest = { userId: this.id, key: `f${w.n}-${this.seq++}`, marketId: m?.id ?? "none", selectionId: sel, stake: 10 };
    const price = m ? book.livePrice(m, sel) : 0;
    const junk: unknown[] = [
      { ...base, stake: -10 },
      { ...base, stake: 0 },
      { ...base, stake: 0.5 },
      { ...base, stake: NaN },
      { ...base, stake: Infinity },
      { ...base, stake: 1e15 },
      { ...base, stake: "10" },
      { ...base, stake: 10_000_000 },
      { ...base, stake: book.balance(this.id) + 1 },
      { ...base, userId: "house" + "|x" },
      { ...base, userId: "" },
      { ...base, key: "" },
      { ...base, key: {} },
      { ...base, marketId: "no-such-market" },
      { ...base, marketId: null },
      { ...base, selectionId: "no-such-selection" },
      { ...base, selectionId: "constructor" },
      { ...base, minPrice: price + 5000 },
      { ...base, minPrice: -1 },
      null,
      [],
      "bet",
    ];
    if (shut.length) junk.push({ ...base, marketId: shut[Math.floor(w.rand() * shut.length)].id, selectionId: shut[0].selections[0].id });
    for (const j of junk) {
      this.stats.requests++;
      const r = book.placeBet(j as BetRequest);
      if (r.ok) this.stats.breaches++;
      else this.stats.rejected[r.code] = (this.stats.rejected[r.code] ?? 0) + 1;
    }
    if (book.ledger.head !== head || book.bets.length !== bets) this.stats.breaches++;
    // One real bet, then the same key again (must return the same bet) and the same key with other terms (must be refused).
    if (m && price > 0 && book.balance(this.id) >= 2) {
      const first = book.placeBet({ ...base, stake: 2 });
      if (first.ok) {
        this.stats.accepted++;
        this.stats.staked += 2;
        const again = book.placeBet({ ...base, stake: 2 });
        if (!again.ok || !again.duplicate || again.bet.id !== first.bet.id) this.stats.breaches++;
        if (book.placeBet({ ...base, stake: 3 }).ok) this.stats.breaches++;
      }
    }
  }
}

/** The default crowd: 40 accounts across every style. `bots` are the season's callsigns (one fan each). */
export function defaultCrowd(bots: string[]): Punter[] {
  const out: Punter[] = [];
  const add = (style: Style, n: number) => {
    for (let i = 1; i <= n; i++) out.push(new Punter(`${style}-${i}`, style));
  };
  add("mug", 12);
  add("favourite", 4);
  add("longshot", 4);
  bots.forEach((b, i) => out.push(new Punter(`fan-${i + 1}`, "fan", b)));
  add("handicap", 4);
  add("sharp", 3);
  add("whale", 6);
  add("fuzzer", 1);
  return out;
}

import { accounts, fmtCredits } from "../account/accounts";
import { nextFixture, type SeasonState } from "../season/season";
import type { Bet, Market, RejectCode } from "./book";
import type { BettingDesk } from "./desk";
import { KIND_LABEL, selectionText } from "./markets";
import "./betting.css";

/**
 * The betting panel inside the season hub. SeasonMode owns the screen; it asks this for a block of markup
 * (render) and hands it any click whose action starts with "bet-" (act). Everything a user can type or name
 * (callsigns, market labels built from them) goes through esc() before it reaches the page.
 */

type Tab = "round" | "season" | "mine";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const odds = (price: number) => (price / 100).toFixed(2);

const WHY: Record<RejectCode, string> = {
  bad_request: "That is not a valid stake.",
  unknown_market: "That market has gone.",
  unknown_selection: "That selection has gone.",
  market_closed: "Betting has closed on that market.",
  selection_unavailable: "There is no price on that right now.",
  stake_too_small: "That stake is too small.",
  stake_too_large: "That is over the maximum stake.",
  user_limit: "You have reached your limit on this market.",
  insufficient_funds: "Not enough credits.",
  price_changed: "The price moved. Check the new price and try again.",
  liability_limit: "The book is full on that selection.",
  house_limit: "The house cannot cover that bet.",
  key_reused: "That bet was already placed.",
};

export class BettingPanel {
  private tab: Tab = "round";
  private pick: { marketId: string; selectionId: string } | null = null;
  private stake = 10;
  private msg: { text: string; ok: boolean } | null = null;

  constructor(private desk: BettingDesk) {}

  /** Pricing progress moves many times a second: poke the bar instead of repainting the hub under the user's cursor. */
  progress(): boolean {
    const bar = document.querySelector<HTMLElement>(".bt-progress i");
    if (!bar) return false;
    bar.style.width = `${Math.round(this.desk.progress * 100)}%`;
    return true;
  }

  act(act: string, id: string): boolean {
    if (!act.startsWith("bet-")) return false;
    const typed = Number((document.getElementById("bt-stake") as HTMLInputElement | null)?.value);
    if (Number.isFinite(typed) && typed > 0) this.stake = Math.floor(typed);
    switch (act) {
      case "bet-tab":
        this.tab = id as Tab;
        this.pick = null;
        this.msg = null;
        break;
      case "bet-pick": {
        const cut = id.lastIndexOf("|");
        const m = this.desk.sb?.book.markets.get(id.slice(0, cut));
        const sel = m?.selections[Number(id.slice(cut + 1))];
        this.pick = m && sel ? { marketId: m.id, selectionId: sel.id } : null;
        this.msg = null;
        break;
      }
      case "bet-stake":
        this.stake = Math.max(1, Math.floor(Number(id)) || 1);
        break;
      case "bet-clear":
        this.pick = null;
        this.msg = null;
        break;
      case "bet-place": {
        const sb = this.desk.sb;
        if (!sb || !this.pick) break;
        const me = accounts.active();
        const m = sb.book.markets.get(this.pick.marketId);
        const q = m ? sb.book.quote(m.id, me.id).find((x) => x.selectionId === this.pick!.selectionId) : undefined;
        if (!m || !q) break;
        const r = this.desk.place(me.id, m.id, q.selectionId, this.stake, q.price);
        if (r.ok) {
          this.msg = { ok: true, text: `Bet placed: ${fmtCredits(r.bet.stake)} on ${selectionText(m, q.selectionId)} at ${odds(r.bet.price)}. Returns ${fmtCredits(r.bet.stake + r.bet.risk)} if it wins.` };
          this.pick = null;
        } else {
          this.msg = { ok: false, text: WHY[r.code] + (r.code === "stake_too_large" || r.code === "user_limit" || r.code === "liability_limit" ? ` The most you can stake here is ${fmtCredits(r.maxStake ?? 0)}.` : "") };
        }
        break;
      }
    }
    return true;
  }

  render(s: SeasonState): string {
    const sb = this.desk.sb;
    const me = accounts.active();
    if (!sb) return "";
    const tabs: [Tab, string][] = [
      ["round", nextFixture(s)?.stage === "league" ? "This week" : "Next match"],
      ["season", "Season"],
      ["mine", `My bets${this.desk.betsOf(me.id).some((b) => b.status === "open") ? " •" : ""}`],
    ];
    const head = `
      <header class="bt-head">
        <h2>Betting</h2>
        <div class="bt-tabs">${tabs.map(([t, label]) => `<button class="${this.tab === t ? "on" : ""}" data-act="bet-tab" data-id="${t}">${esc(label)}</button>`).join("")}</div>
        <span class="bt-wallet" title="${esc(me.name)}'s wallet">${esc(me.name)} · <b>${fmtCredits(me.balance)}</b></span>
      </header>`;
    const pricing = this.desk.status === "pricing" ? `<div class="bt-pricing"><span>The bookmaker is simulating the season to set prices…</span><div class="bt-progress"><i style="width:${Math.round(this.desk.progress * 100)}%"></i></div></div>` : "";
    const body = this.tab === "mine" ? this.renderMine(me.id) : this.tab === "season" ? this.renderMarkets(sb.seasonLong(), me.id, "Season markets reopen with new prices after every match.") : this.renderRound(s, me.id);
    return `<section class="sz-panel bt">${head}${pricing}${this.msg ? `<p class="bt-msg ${this.msg.ok ? "ok" : "no"}">${esc(this.msg.text)}</p>` : ""}${body}${this.renderSlip(me.id)}</section>`;
  }

  private renderRound(s: SeasonState, userId: string): string {
    const sb = this.desk.sb!;
    const next = nextFixture(s);
    if (!next) return `<p class="sz-note">The season is over. Every bet has been settled.</p>`;
    const blocks = s.fixtures
      .filter((f) => f.week === next.week)
      .map((f) => {
        const fair = sb.fairness().find((x) => x.fixtureId === f.id);
        const markets = sb.marketsFor(f.id);
        const state = sb.isLocked(f.id) ? "betting closed, match under way" : !markets.length ? (this.desk.status === "pricing" ? "prices on the way" : "no markets") : markets.every((m) => m.status === "settled") ? "settled" : "";
        const proof = fair ? (fair.seed !== null ? `seed ${fair.seed} revealed, commit ${fair.commit.slice(0, 10)}…` : `seed sealed, commit ${fair.commit.slice(0, 10)}…`) : "";
        return `<h3>${esc(f.label)} <small>${esc([state, proof].filter(Boolean).join(" · "))}</small></h3>${this.renderMarkets(markets.filter((m) => m.status === "open"), userId, "")}`;
      });
    const week = [...sb.book.markets.values()].filter((m) => m.kind === "round_top" && m.round === next.week && m.id.startsWith(`${sb.seasonId}/`) && m.status === "open");
    return blocks.join("") + (week.length ? this.renderMarkets(week, userId, "") : "");
  }

  private renderMarkets(markets: Market[], userId: string, note: string): string {
    const sb = this.desk.sb!;
    const open = markets.filter((m) => m.status === "open");
    const shut = markets.filter((m) => m.status === "suspended" || m.status === "closed");
    const rows = open
      .map((m) => {
        const quotes = sb.book.quote(m.id, userId);
        const cells = quotes
          .map((q, i) => {
            const on = this.pick?.marketId === m.id && this.pick.selectionId === q.selectionId;
            return `<button class="bt-sel ${on ? "on" : ""}" data-act="bet-pick" data-id="${esc(`${m.id}|${i}`)}" ${q.price ? "" : "disabled"}><span>${esc(selectionText(m, q.selectionId))}</span><b>${q.price ? odds(q.price) : "—"}</b></button>`;
          })
          .join("");
        const title = m.kind === "match_hcap" ? "Handicap" : KIND_LABEL[m.kind];
        return `<div class="bt-market k-${m.kind}"><span class="bt-kind" title="${esc(m.label)}">${esc(title)}</span><div class="bt-sels n${quotes.length}">${cells}</div></div>`;
      })
      .join("");
    const waiting = shut.length && !open.length ? `<p class="sz-note">${shut.some((m) => m.status === "suspended") ? "Suspended while a match is being fought or prices are being worked out." : "Betting has closed."}</p>` : "";
    return `${rows}${waiting}${note && open.length ? `<p class="sz-note">${esc(note)}</p>` : ""}`;
  }

  private renderSlip(userId: string): string {
    const sb = this.desk.sb!;
    if (!this.pick) return "";
    const m = sb.book.markets.get(this.pick.marketId);
    const q = m && m.status === "open" ? sb.book.quote(m.id, userId).find((x) => x.selectionId === this.pick!.selectionId) : undefined;
    if (!m || !q || !q.price) return `<div class="bt-slip"><p class="sz-note">That price is no longer on offer.</p><button data-act="bet-clear">Clear</button></div>`;
    const stake = Math.max(1, Math.min(this.stake, Math.max(1, q.maxStake)));
    const chips = [10, 25, 50]
      .filter((n) => n < q.maxStake)
      .map((n) => `<button data-act="bet-stake" data-id="${n}" class="${stake === n ? "on" : ""}">${n}</button>`)
      .join("");
    return `
      <div class="bt-slip">
        <div class="bt-slip-what"><b>${esc(selectionText(m, q.selectionId))}</b><small>${esc(m.label)}</small></div>
        <span class="bt-slip-price">${odds(q.price)}</span>
        <div class="bt-slip-stake">
          <input id="bt-stake" type="number" min="1" max="${q.maxStake}" step="1" value="${stake}" aria-label="Stake" />
          ${chips}<button data-act="bet-stake" data-id="${q.maxStake}" ${q.maxStake ? "" : "disabled"}>Max ${q.maxStake}</button>
        </div>
        <span class="bt-slip-ret">returns <b>${fmtCredits(Math.floor((stake * q.price) / 100))}</b></span>
        <button class="sz-primary" data-act="bet-place" ${q.maxStake ? "" : "disabled"}>Place bet</button>
        <button data-act="bet-clear" title="Clear the slip">✕</button>
      </div>`;
  }

  private renderMine(userId: string): string {
    const sb = this.desk.sb!;
    const bets = this.desk.betsOf(userId).slice().reverse();
    if (!bets.length) return `<p class="sz-note">No bets yet this season. Pick a price to start a slip.</p>`;
    const staked = bets.reduce((n, b) => n + b.stake, 0);
    const back = bets.filter((b) => b.status !== "open").reduce((n, b) => n + b.payout, 0);
    const riding = bets.filter((b) => b.status === "open").reduce((n, b) => n + b.stake, 0);
    const outcome = (b: Bet) =>
      b.status === "open" ? `<em class="open">open · to return ${fmtCredits(b.stake + b.risk)}</em>` : b.status === "won" ? `<em class="won">won ${fmtCredits(b.payout)}</em>` : b.status === "part" ? `<em class="won">dead heat ${fmtCredits(b.payout)}</em>` : b.status === "void" ? `<em class="void">stake returned</em>` : `<em class="lost">lost</em>`;
    const rows = bets
      .map((b) => {
        const m = sb.book.markets.get(b.marketId);
        return `<li><span><b>${esc(m ? selectionText(m, b.selectionId) : b.selectionId)}</b><small>${esc(m?.label ?? "")}</small></span><span>${fmtCredits(b.stake)} at ${odds(b.price)}</span>${outcome(b)}</li>`;
      })
      .join("");
    return `<p class="sz-note">Staked ${fmtCredits(staked)} · returned ${fmtCredits(back)} · still riding ${fmtCredits(riding)}</p><ul class="bt-bets">${rows}</ul>`;
  }
}

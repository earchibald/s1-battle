import type { BotBuild } from "@shared/build";
import { candidatePool, standings, zoneOf, type SeasonState } from "../season/season";
import { WEAPON_ICON } from "../ui/hud";
import { Library } from "../ui/library";
import { MAX_PROFILES, NAME_MAX, STARTING_BALANCE, accounts, fmtCredits, type LedgerEntry, type Profile } from "./accounts";
import { removeRosterFor } from "./garage";
import { PRIZES, SEASON_TOP_PRIZE } from "./prizes";
import "./account.css";

/**
 * The Users screen: who is at the controls, their wallet, and their record as a bot designer. One user is both
 * a bettor and a designer, so the two halves sit side by side and share one balance.
 *
 * Built as HTML strings like the season screens (and on their shell styles); every piece of text a person typed
 * (user names, callsigns, ledger notes) goes through esc() first.
 */

export interface AccountHost {
  /** The active user's Garage roster (live reference). */
  roster: BotBuild[];
  season(): SeasonState | null;
  openGarage(): void;
  openSeason(): void;
  toast(text: string): void;
  click?(): void;
}

const hex = (n: number) => "#" + n.toString(16).padStart(6, "0");
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
function paint(el: HTMLElement, markup: string) {
  el.replaceChildren(document.createRange().createContextualFragment(markup));
}
const KIND_LABEL: Record<LedgerEntry["kind"], string> = { grant: "GRANT", stake: "BET", payout: "WON", refund: "REFUND", prize: "PRIZE" };
const ORD = ["", "1st", "2nd", "3rd", "4th", "5th", "6th", "7th", "8th"];

export class AccountPanel {
  open = false;
  private root: HTMLElement;
  /** Profile id whose delete button has been clicked once. */
  private confirmDelete = "";

  constructor(private host: AccountHost) {
    this.root = document.createElement("div");
    this.root.className = "sz ac hidden";
    document.body.appendChild(this.root);
    this.root.addEventListener("click", (ev) => {
      const el = (ev.target as HTMLElement).closest<HTMLElement>("[data-act]");
      if (el) this.act(el.dataset.act!, el.dataset.id ?? "");
    });
    this.root.addEventListener("keydown", (ev) => {
      const input = ev.target as HTMLElement;
      if (ev.key === "Escape") this.hide();
      else if (ev.key === "Enter" && input instanceof HTMLInputElement && input.dataset.enter) this.act(input.dataset.enter, "");
    });
    accounts.onChange(() => this.render());
  }

  show() {
    this.open = true;
    this.confirmDelete = "";
    this.root.classList.remove("hidden");
    this.render();
  }
  hide() {
    this.open = false;
    this.root.classList.add("hidden");
  }
  toggle() {
    if (this.open) this.hide();
    else this.show();
  }

  private input(id: string): string {
    return this.root.querySelector<HTMLInputElement>(`#${id}`)?.value ?? "";
  }

  private act(act: string, id: string) {
    this.host.click?.();
    const pending = this.confirmDelete;
    this.confirmDelete = "";
    switch (act) {
      case "close":
        this.hide();
        return;
      case "switch":
        accounts.switchTo(id);
        this.host.toast(`${accounts.active().name} is at the controls: their wallet, their Garage.`);
        return;
      case "new": {
        const name = this.input("ac-new").trim();
        if (!name) return;
        const p = accounts.create(name);
        if (!p) return;
        accounts.switchTo(p.id);
        this.host.toast(`Welcome, ${p.name}. ${fmtCredits(STARTING_BALANCE)} to bet with and four Garage slots to fill.`);
        return;
      }
      case "rename": {
        const name = this.input("ac-name").trim();
        if (name) accounts.rename(accounts.active().id, name);
        return;
      }
      case "delete":
        if (pending !== id) {
          this.confirmDelete = id;
          break;
        }
        if (accounts.remove(id)) removeRosterFor(id);
        return;
      case "garage":
        this.hide();
        this.host.openGarage();
        return;
      case "season":
        this.hide();
        this.host.openSeason();
        return;
    }
    this.render();
  }

  /* ------------------------------------------------------------ rendering -------------------------- */

  private render() {
    if (!this.open) return;
    const me = accounts.active();
    paint(
      this.root,
      `<div class="sz-shell">
        <div class="sz-head">
          <div class="sz-brand"><span class="sz-kicker">S1 ARENA · USERS</span><h1>${esc(me.name).toUpperCase()}</h1><span class="sz-sub">Bettor and bot designer. One wallet for both.</span></div>
          <div class="sz-spacer"></div>
          <div class="sz-actions">
            <button data-act="garage" title="Design and save bots as ${esc(me.name)}">🛠 Garage</button>
            <button data-act="season" title="Enter your bots and follow the league">🏆 Season</button>
            <button class="sz-close" data-act="close" title="Esc">✕</button>
          </div>
        </div>
        <div class="sz-body ac-body">
          <section class="sz-panel">${this.renderUsers(me)}</section>
          <section class="sz-panel">${this.renderWallet(me)}</section>
          <section class="sz-panel">${this.renderDesigner(me)}</section>
        </div>
      </div>`,
    );
  }

  private renderUsers(me: Profile): string {
    const lib = new Library();
    const rows = accounts.profiles
      .map((p) => {
        const on = p.id === me.id;
        const arm = this.confirmDelete === p.id;
        const saved = lib.buildsOf(p.id).length;
        return `<li class="ac-user ${on ? "on" : ""}" style="--c:${hex(p.color)}">
          <i class="ac-dot"></i>
          <div class="ac-user-text"><b>${esc(p.name)}</b><small>${fmtCredits(p.balance)} · ${saved} saved build${saved === 1 ? "" : "s"} · ${p.designer.titles} title${p.designer.titles === 1 ? "" : "s"}</small></div>
          ${on ? `<em class="ac-active">AT THE CONTROLS</em>` : `<button data-act="switch" data-id="${p.id}">Switch</button>`}
          ${accounts.profiles.length > 1 ? `<button class="sz-danger ${arm ? "on" : ""}" data-act="delete" data-id="${p.id}" title="Delete this user, their wallet and their Garage">${arm ? "Really?" : "✕"}</button>` : ""}
        </li>`;
      })
      .join("");
    const full = accounts.profiles.length >= MAX_PROFILES;
    return `
      <header><h2>Users</h2><p>Everyone who plays on this machine. Each user has their own wallet, their own Garage and their own saved builds, and can do both jobs: bet on the season and build the bots that fight in it.</p></header>
      <ul class="ac-users">${rows}</ul>
      <h3>Add a user</h3>
      <div class="ac-row"><input id="ac-new" class="ac-input" maxlength="${NAME_MAX}" placeholder="name" spellcheck="false" data-enter="new" ${full ? "disabled" : ""} /><button data-act="new" ${full ? "disabled" : ""}>＋ Add</button></div>
      <p class="sz-note">${full ? `That is the limit of ${MAX_PROFILES} users.` : `New users start with ${fmtCredits(STARTING_BALANCE)} and a stock Garage.`}</p>
      <h3>Rename ${esc(me.name)}</h3>
      <div class="ac-row"><input id="ac-name" class="ac-input" maxlength="${NAME_MAX}" value="${esc(me.name)}" spellcheck="false" data-enter="rename" /><button data-act="rename">Save</button></div>
      <p class="sz-note">Deleting a user removes their wallet and Garage. Builds they saved stay in the library, credited to nobody.</p>`;
  }

  private renderWallet(me: Profile): string {
    const when = (t: number) => (t ? new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "");
    const rows = me.ledger
      .slice(-40)
      .reverse()
      .map((e) => `<li class="k-${e.kind}"><span class="ac-kind">${KIND_LABEL[e.kind] ?? "ENTRY"}</span><span class="ac-note">${esc(e.note)}<small>${when(e.t)}</small></span><b class="${e.amount >= 0 ? "in" : "out"}">${e.amount >= 0 ? "+" : "−"}${Math.abs(e.amount).toLocaleString()}</b></li>`)
      .join("");
    const sum = (kinds: LedgerEntry["kind"][], sign: 1 | -1) => me.ledger.filter((e) => kinds.includes(e.kind)).reduce((n, e) => n + sign * e.amount, 0);
    const staked = sum(["stake"], -1);
    const returned = sum(["payout", "refund"], 1);
    return `
      <header><h2>Wallet</h2><p>Play-money credits. Bets are staked from here and paid back here, and so is the prize money your bots earn.</p></header>
      <div class="ac-balance" style="--c:${hex(me.color)}"><span>Balance</span><b>${fmtCredits(me.balance)}</b></div>
      <div class="ac-tiles">
        <div><span>Staked</span><b>${staked.toLocaleString()}</b></div>
        <div><span>Returned</span><b>${returned.toLocaleString()}</b></div>
        <div><span>Betting net</span><b class="${returned - staked >= 0 ? "in" : "out"}">${returned - staked >= 0 ? "+" : "−"}${Math.abs(returned - staked).toLocaleString()}</b></div>
        <div><span>Prize money</span><b class="in">+${me.designer.prize.toLocaleString()}</b></div>
      </div>
      <h3>Ledger <small>most recent first</small></h3>
      <ul class="ac-ledger">${rows}</ul>`;
  }

  private renderDesigner(me: Profile): string {
    const d = me.designer;
    const s = this.host.season();
    const table = s ? standings(s) : [];
    const lib = new Library();
    const owner = { id: me.id, name: me.name };
    const bots = candidatePool(this.host.roster, lib.buildsOf(me.id).map((b) => ({ build: b.build, owner })), owner).filter((c) => c.mine);
    const rows = bots
      .map((c) => {
        const e = s?.entrants.find((x) => x.id === c.build.name && x.owner?.id === me.id);
        const r = e ? table.find((x) => x.id === e.id) : undefined;
        const status = !s || !e ? `<small>${c.origin === "garage" ? "in your Garage" : "saved build"} · not in a season</small>` : s.champion === e.id ? `<small class="gold">SEASON CHAMPION</small>` : `<small>${ORD[r?.rank ?? 0] ?? ""} in the league · ${r?.points ?? 0} pts · ${zoneOf(r?.rank ?? 8) === "out" ? "below the cut" : zoneOf(r?.rank ?? 8) === "final" ? "Grand Final place" : "Last Chance place"}</small>`;
        return `<li style="--c:${hex(c.build.color)}"><i>${WEAPON_ICON[c.build.kind]}</i><div><b>${esc(c.build.name)}</b>${status}</div></li>`;
      })
      .join("");
    return `
      <header><h2>Designer record</h2><p>How the bots you built have done in seasons, and what they have earned you.</p></header>
      <div class="ac-tiles">
        <div><span>Bots entered</span><b>${d.entered}</b></div>
        <div><span>Matches</span><b>${d.matches}</b></div>
        <div><span>Wins</span><b>${d.wins}</b></div>
        <div><span>Titles</span><b>${d.titles}</b></div>
      </div>
      <h3>Your bots</h3>
      ${rows ? `<ul class="ac-bots">${rows}</ul>` : `<p class="sz-note">Nothing of your own yet: your Garage still holds the stock bots. Open the Garage, change a build and give it a callsign, and it can enter the next season under your name.</p>`}
      <h3>Prize money</h3>
      <table class="ac-prizes">
        <tr><td>League match</td><td>${PRIZES.league.filter((n) => n > 0).join(" / ")} for 1st / 2nd / 3rd</td></tr>
        <tr><td>Each elimination</td><td>+${PRIZES.elimination}</td></tr>
        <tr><td>Last Chance</td><td>${PRIZES.lastChance[0]} for each bot that goes through</td></tr>
        <tr><td>Grand Final</td><td>${PRIZES.final.join(" / ")} by place</td></tr>
      </table>
      <p class="sz-note">A bot that wins every league match and the Grand Final earns its designer ${fmtCredits(SEASON_TOP_PRIZE)} before eliminations. Prizes are paid whether the match is played in the arena or simulated.</p>`;
  }
}

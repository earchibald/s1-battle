import type { BotBuild } from "@shared/build";
import type { BotDef } from "@shared/bots/common";
import type { SimEvent } from "../sim/events";
import type { World } from "../sim/world";
import { WEAPON_ICON } from "../ui/hud";
import { Library } from "../ui/library";
import { KillLog, fixtureDefs, outcomeFromWorld, simulateNext } from "./runner";
import {
  DIRECT_FINALISTS,
  LAST_CHANCE_CUT,
  LEAGUE_SIZE,
  LEAGUE_WEEKS,
  POINTS,
  SEASON_MATCHES,
  applyResult,
  candidatePool,
  coldStreak,
  createSeason,
  entrant,
  finalOrder,
  fixtureHooks,
  isComplete,
  lastRecord,
  nextFixture,
  ordinal,
  rankMoves,
  recordFor,
  rivalries,
  seasonAwards,
  seasonPhase,
  standings,
  tableGoingIn,
  winStreak,
  zoneOf,
  type Candidate,
  type Fixture,
  type MatchRecord,
  type Owner,
  type SeasonState,
} from "./season";
import { loadSeason, saveSeason } from "./storage";
import { accounts } from "../account/accounts";
import { loadRosterFor } from "../account/garage";
import "./season.css";

/**
 * Season mode: owns the saved season, the between-match screens (setup, hub, champion) and the two hooks the
 * arena needs: `fixture()` tells startMatch who fights next, `onEvent()` turns the finished match into a result.
 * Exhibition play is untouched while `playing` is false.
 *
 * Screens are built as HTML strings like the rest of the UI; every piece of text that can come from the player
 * (callsigns, taglines) goes through esc() first.
 */

export interface SeasonHost {
  /** The Garage roster (live reference). */
  roster: BotBuild[];
  /** Start a match in the arena: the next season fixture while `playing`, an exhibition match otherwise. */
  startMatch(): void;
  ticker(text: string, cls?: string): void;
  toast(text: string): void;
  click?(): void;
  /** A season has just been created. */
  onSeasonStart?(s: SeasonState): void;
  /** A fixture has just been recorded (played in the arena or simulated). `s` already includes `rec`. */
  onResult?(s: SeasonState, rec: MatchRecord): void;
}

export interface LiveFixture {
  defs: BotDef[];
  seed: number;
  label: string;
  hook: string;
}

/** Seconds the arena holds on the finished match before the season screen comes up. */
const RECAP_DELAY_MS = 3800;

const hex = (n: number) => "#" + n.toString(16).padStart(6, "0");
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
/** Replace an element's children with trusted markup (built here, player text escaped). */
function paint(el: HTMLElement, markup: string) {
  el.replaceChildren(document.createRange().createContextualFragment(markup));
}

export class SeasonMode {
  state: SeasonState | null = loadSeason();
  /** Arena matches are season fixtures. */
  playing = false;
  open = false;
  private root: HTMLElement;
  private chip: HTMLElement;
  private view: "hub" | "setup" = "hub";
  private picks: Candidate[] = [];
  /** The fixture currently being fought in the arena. */
  private live: string | null = null;
  private log = new KillLog();
  /** A past result opened from the schedule; null shows the latest. */
  private shown: string | null = null;
  private confirmAbandon = false;
  private recapTimer = 0;

  constructor(private host: SeasonHost) {
    this.root = document.createElement("div");
    this.root.className = "sz hidden";
    document.body.appendChild(this.root);
    this.root.addEventListener("click", (ev) => {
      const el = (ev.target as HTMLElement).closest<HTMLElement>("[data-act]");
      if (el) this.act(el.dataset.act!, el.dataset.id ?? "");
    });
    this.chip = document.createElement("div");
    this.chip.className = "sz-chip hidden";
    document.body.appendChild(this.chip);
    this.chip.addEventListener("click", (ev) => {
      if ((ev.target as HTMLElement).closest("[data-x]")) this.chip.classList.add("hidden");
      else this.show();
    });
    // A season in progress is offered, never forced: the arena opens in exhibition either way.
    if (this.state && !isComplete(this.state)) {
      paint(this.chip, `<span>🏆 Season in progress · ${esc(seasonPhase(this.state))}</span><b>Resume</b><i data-x title="Dismiss">✕</i>`);
      this.chip.classList.remove("hidden");
      host.ticker(`Season in progress (${seasonPhase(this.state)}). Press S to resume.`, "season");
    }
  }

  /* ------------------------------------------------------------ arena hooks ------------------------ */

  /** Who fights next, or null for an exhibition match. Called by startMatch. */
  fixture(): LiveFixture | null {
    clearTimeout(this.recapTimer);
    this.live = null;
    if (!this.playing || !this.state) return null;
    const fx = nextFixture(this.state);
    if (!fx) {
      this.playing = false;
      return null;
    }
    this.live = fx.id;
    this.log.reset();
    return { defs: fixtureDefs(this.state, fx), seed: fx.seed, label: fx.label, hook: fixtureHooks(this.state, fx)[0]?.text ?? "" };
  }

  /** Every sim event of the running match. Records the result when a season fixture ends. */
  onEvent(e: SimEvent, world: World) {
    if (!this.playing || !this.live || !this.state) return;
    this.log.onEvent(e, world);
    if (e.type !== "match_end") return;
    const id = this.live;
    this.live = null;
    this.state = applyResult(this.state, id, outcomeFromWorld(world, this.log.kills));
    saveSeason(this.state);
    const rec = recordFor(this.state, id);
    if (rec) this.host.onResult?.(this.state, rec);
    for (const h of rec?.headlines.slice(0, 3) ?? []) this.host.ticker(h, "season");
    this.shown = null;
    this.recapTimer = window.setTimeout(() => {
      if (this.playing && !this.live) this.show();
    }, RECAP_DELAY_MS);
  }

  /* ------------------------------------------------------------ overlay ---------------------------- */

  show() {
    this.open = true;
    this.chip.classList.add("hidden");
    this.confirmAbandon = false;
    if (!this.state) this.openSetup();
    else this.view = "hub";
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

  /** A Garage deploy is an exhibition match: step out of the season (it stays saved). */
  suspend() {
    clearTimeout(this.recapTimer);
    this.playing = false;
    this.live = null;
  }

  private openSetup() {
    this.view = "setup";
    // Every user's bots can enter: the active user's Garage and saved builds first, then the other designers'.
    const me = accounts.active();
    const owner = (id: string): Owner | undefined => {
      const p = accounts.get(id);
      return p ? { id: p.id, name: p.name } : undefined;
    };
    const saved = new Library().builds.map((b) => ({ build: b.build, owner: owner(b.ownerId) }));
    const rivals = accounts.profiles.filter((p) => p.id !== me.id).flatMap((p) => loadRosterFor(p.id).map((build) => ({ build, owner: owner(p.id) })));
    this.picks = candidatePool(this.host.roster, saved, owner(me.id), rivals);
  }

  /** Redraw after something outside the season changed (the user at the controls, a wallet). */
  refresh() {
    if (this.open && this.view === "setup") this.openSetup();
    this.render();
  }

  /** Whose bot this is: YOU for the user at the controls, the designer's name for anyone else's. */
  private tag(e: { mine: boolean; owner?: Owner }): string {
    if (!e.owner) return e.mine ? `<em class="sz-you">YOU</em>` : "";
    if (e.owner.id === accounts.active().id) return `<em class="sz-you">YOU</em>`;
    return `<em class="sz-by" title="Designed by ${esc(accounts.nameOf(e.owner.id) ?? e.owner.name)}">${esc(accounts.nameOf(e.owner.id) ?? e.owner.name)}</em>`;
  }
  private isMine(e: { mine: boolean; owner?: Owner } | undefined): boolean {
    return !!e && (e.owner ? e.owner.id === accounts.active().id : e.mine);
  }

  private act(act: string, id: string) {
    this.host.click?.();
    const wasAbandon = this.confirmAbandon;
    this.confirmAbandon = false;
    switch (act) {
      case "close":
        this.hide();
        return;
      case "pick": {
        const c = this.picks[Number(id)];
        if (c) c.selected = !c.selected;
        break;
      }
      case "start": {
        const chosen = this.picks.filter((c) => c.selected);
        if (chosen.length !== LEAGUE_SIZE) return;
        // A new season replaces the old one; if the arena was mid-fixture, that match is now an exhibition.
        this.leave();
        this.state = createSeason(chosen, (Date.now() % 1_000_000) + 1, Date.now());
        saveSeason(this.state);
        this.host.onSeasonStart?.(this.state);
        this.shown = null;
        this.view = "hub";
        this.host.ticker(`A new season begins: ${this.state.entrants.map((e) => e.id).join(" · ")}`, "season");
        break;
      }
      case "setup":
        this.openSetup();
        break;
      case "hub":
        this.view = "hub";
        break;
      case "play": {
        if (!this.state || !nextFixture(this.state)) return;
        const fx = nextFixture(this.state)!;
        this.hide();
        // Coming back to a fixture that is still being fought just closes the screen.
        if (this.playing && this.live === fx.id) return;
        this.playing = true;
        this.host.startMatch();
        return;
      }
      case "sim": {
        if (!this.state) return;
        const midMatch = this.playing && this.live !== null;
        const before = this.state.records.length;
        this.state = simulateNext(this.state);
        saveSeason(this.state);
        this.shown = null;
        const rec = this.state.records.length > before ? lastRecord(this.state) : null;
        if (rec) this.host.onResult?.(this.state, rec);
        if (rec) this.host.ticker(`${rec.label} (simulated): ${rec.headlines[0] ?? ""}`, "season");
        // The arena was showing the fixture that has just been simulated: move it on to the next one.
        if (midMatch) {
          this.live = null;
          if (nextFixture(this.state)) this.host.startMatch();
        }
        break;
      }
      case "rec":
        this.shown = id || null;
        break;
      case "exhibition":
        this.leave();
        this.hide();
        return;
      case "abandon":
        if (!wasAbandon) {
          this.confirmAbandon = true;
          break;
        }
        this.state = null;
        saveSeason(null);
        this.leave();
        this.host.toast("Season cleared. Back to exhibition.");
        this.hide();
        return;
    }
    this.render();
  }

  /** Back to exhibition matches. The season, if any, stays saved. */
  private leave() {
    const was = this.playing;
    this.suspend();
    if (was) this.host.startMatch();
  }

  /* ------------------------------------------------------------ rendering -------------------------- */

  private render() {
    if (!this.open) return;
    paint(this.root, this.view === "setup" || !this.state ? this.renderSetup() : this.renderHub(this.state));
  }

  private bot(s: SeasonState, id: string, extra = ""): string {
    const e = entrant(s, id);
    if (!e) return esc(id);
    return `<span class="sz-bot" style="--c:${hex(e.build.color)}"><i>${WEAPON_ICON[e.build.kind]}</i><b>${esc(id)}</b>${this.tag(e)}${extra}</span>`;
  }

  private renderSetup(): string {
    const n = this.picks.filter((c) => c.selected).length;
    const me = accounts.active().id;
    const source = (c: Candidate) => {
      if (c.origin === "stock") return "stock";
      if (c.origin === "wildcard") return "house wildcard";
      const whose = !c.owner ? "unsigned" : c.owner.id === me ? "your" : `${esc(c.owner.name)}'s`;
      return c.origin === "garage" ? `${whose} Garage` : `${whose} saved build`;
    };
    const cards = this.picks
      .map(
        (c, i) => `
        <button class="sz-pick ${c.selected ? "on" : ""}" data-act="pick" data-id="${i}" style="--c:${hex(c.build.color)}">
          <span class="sz-pick-icon">${WEAPON_ICON[c.build.kind]}</span>
          <span class="sz-pick-text"><b>${esc(c.build.name)}</b><small>${c.build.kind} · ${source(c)}</small><em>${esc(c.build.tagline)}</em></span>
          <span class="sz-pick-mark">${c.selected ? "IN" : "—"}</span>
        </button>`,
      )
      .join("");
    return `
      <div class="sz-shell">
        <div class="sz-head">
          <div class="sz-brand"><span class="sz-kicker">S1 ARENA</span><h1>NEW SEASON</h1><span class="sz-sub">Eight bots. Ten matches. One champion.</span></div>
          <div class="sz-spacer"></div>
          <div class="sz-actions">
            ${this.state ? `<button data-act="hub">← Back to the season</button>` : ""}
            <button class="sz-close" data-act="close" title="Esc">✕</button>
          </div>
        </div>
        <div class="sz-body setup">
          <section class="sz-panel">
            <header><h2>The league</h2><p>Pick exactly ${LEAGUE_SIZE} entrants. Your own builds are in by default, then the other users' builds; stock bots and house wildcards fill the rest. A designed bot fights under its designer's name and earns them prize money. Builds are frozen at the start, so Garage edits mid-season do not change who is fighting.</p></header>
            <div class="sz-picks">${cards}</div>
          </section>
          <section class="sz-panel sz-format">
            <header><h2>How a season works</h2></header>
            <ol>
              <li><b>League, ${LEAGUE_WEEKS} weeks.</b> Two four-bot matches a week; every bot fights every week and meets every rival at least once.</li>
              <li><b>Points.</b> ${POINTS.place.join(" / ")} by finishing place (outlasting a bot always places above it), +${POINTS.elimination} for each bot you eliminate, +${POINTS.topDamage} for the match's top damage.</li>
              <li><b>The cut.</b> The top ${DIRECT_FINALISTS} go straight to the Grand Final. ${ordinal(DIRECT_FINALISTS + 1)} to ${ordinal(LAST_CHANCE_CUT)} fight one <b>Last Chance</b> match for the other two places. ${ordinal(LAST_CHANCE_CUT + 1)} and ${ordinal(LEAGUE_SIZE)} are out.</li>
              <li><b>Grand Final.</b> Four bots, one match, winner takes the title. Points do not carry over.</li>
            </ol>
            <p class="sz-note">Play any match in the arena with whichever brains you like, or simulate it instantly on baseline brains. The season saves itself after every match.</p>
            <div class="sz-start">
              <span class="sz-count ${n === LEAGUE_SIZE ? "ok" : ""}">${n} / ${LEAGUE_SIZE} selected</span>
              <button class="sz-primary" data-act="start" ${n === LEAGUE_SIZE ? "" : "disabled"}>🏆 Start season</button>
            </div>
            ${this.state && !isComplete(this.state) ? `<p class="sz-warn">Starting replaces the season in progress (${esc(seasonPhase(this.state))}).</p>` : ""}
          </section>
        </div>
      </div>`;
  }

  private renderHub(s: SeasonState): string {
    const fx = nextFixture(s);
    const done = isComplete(s);
    const pips = Array.from({ length: SEASON_MATCHES }, (_, i) => {
      const cls = i < s.records.length ? "done" : i === s.records.length ? "now" : "";
      const kind = i === SEASON_MATCHES - 1 ? "final" : i === SEASON_MATCHES - 2 ? "lc" : "";
      return `<i class="${cls} ${kind}"></i>`;
    }).join("");
    const rec = (this.shown ? recordFor(s, this.shown) : null) ?? lastRecord(s);
    return `
      <div class="sz-shell">
        <div class="sz-head">
          <div class="sz-brand"><span class="sz-kicker">S1 ARENA · SEASON</span><h1>${done ? "FINAL WHISTLE" : esc(seasonPhase(s)).toUpperCase()}</h1><span class="sz-sub">${s.records.length} of ${SEASON_MATCHES} matches played</span></div>
          <div class="sz-pips" title="League weeks, then Last Chance and the Grand Final">${pips}</div>
          <div class="sz-actions">
            <button class="${done ? "sz-primary" : ""}" data-act="setup">${done ? "🏆 New season" : "New season"}</button>
            <button data-act="exhibition" title="Leave the season screen and run exhibition matches. The season stays saved.">Exhibition</button>
            <button class="${this.confirmAbandon ? "sz-danger on" : "sz-danger"}" data-act="abandon">${this.confirmAbandon ? "Really? Click again" : done ? "Clear season" : "Abandon season"}</button>
            <button class="sz-close" data-act="close" title="Esc">✕</button>
          </div>
        </div>
        <div class="sz-body">
          <section class="sz-panel sz-table-panel">${this.renderTable(s)}</section>
          <div class="sz-mid">
            ${done ? this.renderChampion(s) : fx ? this.renderFixture(s, fx) : ""}
            ${rec ? this.renderRecap(s, rec) : `<section class="sz-panel sz-empty">No matches played yet. The first result will show up here.</section>`}
          </div>
          <div class="sz-side">
            <section class="sz-panel">${this.renderStories(s)}</section>
            <section class="sz-panel">${this.renderSchedule(s)}</section>
          </div>
        </div>
      </div>`;
  }

  private status(s: SeasonState, id: string, rank: number): string {
    if (s.champion === id) return "CHAMPION";
    const fin = s.fixtures.find((f) => f.stage === "final");
    const lc = s.fixtures.find((f) => f.stage === "lastchance");
    if (fin) return fin.bots.includes(id) ? "FINALIST" : "OUT";
    if (lc) return rank <= DIRECT_FINALISTS ? "FINALIST" : lc.bots.includes(id) ? "LAST CHANCE" : "OUT";
    return "";
  }

  private renderTable(s: SeasonState): string {
    const moves = rankMoves(s);
    const rows = standings(s)
      .map((r) => {
        const mv = moves[r.id] ?? 0;
        const streak = winStreak(s, r.id);
        const cold = coldStreak(s, r.id);
        const tag = streak >= 2 ? `<em class="sz-hot" title="${streak} wins in a row">🔥${streak}</em>` : cold >= 3 ? `<em class="sz-cold" title="bottom two ${cold} matches running">▼${cold}</em>` : "";
        const st = this.status(s, r.id, r.rank);
        const form = r.form.map((p) => `<i class="p${p}">${p}</i>`).join("");
        return `<tr class="zone-${zoneOf(r.rank)}${this.isMine(entrant(s, r.id)) ? " mine" : ""}">
          <td class="rk">${r.rank}<span class="mv ${mv > 0 ? "up" : mv < 0 ? "down" : ""}">${mv > 0 ? "▲" : mv < 0 ? "▼" : ""}</span></td>
          <td class="nm">${this.bot(s, r.id, tag)}${st ? `<span class="sz-status ${st === "OUT" ? "out" : ""}">${st}</span>` : ""}</td>
          <td>${r.played}</td><td>${r.wins}</td><td>${r.elims}</td><td>${r.damage}</td>
          <td><span class="form">${form}</span></td>
          <td class="pts">${r.points}</td>
        </tr>`;
      })
      .join("");
    return `
      <header><h2>League table</h2></header>
      <table class="sz-table">
        <thead><tr><th></th><th>Bot</th><th title="Played">P</th><th title="Wins">W</th><th title="Eliminations">KO</th><th title="Damage dealt">DMG</th><th>Form</th><th>PTS</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="sz-legend"><span class="zone-final">Top ${DIRECT_FINALISTS}: Grand Final</span><span class="zone-lastchance">${ordinal(DIRECT_FINALISTS + 1)} to ${ordinal(LAST_CHANCE_CUT)}: Last Chance</span><span class="zone-out">${ordinal(LAST_CHANCE_CUT + 1)}, ${ordinal(LEAGUE_SIZE)}: out</span></div>
      <p class="sz-note">${POINTS.place.join(" / ")} by place · +${POINTS.elimination} per elimination · +${POINTS.topDamage} top damage. Ties: wins, eliminations, damage.</p>`;
  }

  private renderFixture(s: SeasonState, fx: Fixture): string {
    const table = tableGoingIn(s, fx);
    const hooks = fixtureHooks(s, fx);
    const liveNow = this.playing && this.live === fx.id;
    const bots = fx.bots
      .map((id) => {
        const e = entrant(s, id)!;
        const r = table.find((x) => x.id === id)!;
        return `<div class="sz-vs-bot" style="--c:${hex(e.build.color)}">
          <span class="sz-vs-icon">${WEAPON_ICON[e.build.kind]}</span>
          <b>${esc(id)}</b>${this.tag(e)}
          <small>${r.played ? `${ordinal(r.rank)} · ${r.points} pts` : e.build.kind}</small>
          <span class="form">${r.form.map((p) => `<i class="p${p}">${p}</i>`).join("")}</span>
        </div>`;
      })
      .join(`<span class="sz-vs-x">×</span>`);
    return `
      <section class="sz-panel sz-next ${fx.stage}">
        <div class="sz-next-kicker">${liveNow ? "NOW FIGHTING" : "NEXT MATCH"} · ${esc(fx.label).toUpperCase()}</div>
        <div class="sz-vs">${bots}</div>
        <p class="sz-hook">${esc(hooks[0]?.text ?? "")}</p>
        ${hooks.length > 1 ? `<ul class="sz-hooks">${hooks.slice(1, 3).map((h) => `<li>${esc(h.text)}</li>`).join("")}</ul>` : ""}
        <div class="sz-next-actions">
          <button class="sz-primary" data-act="play">${liveNow ? "▶ Back to the match" : "▶ Play next match"}</button>
          <button data-act="sim" title="Run this match instantly on baseline brains and record the result">⏩ Simulate it</button>
        </div>
      </section>`;
  }

  private renderRecap(s: SeasonState, rec: MatchRecord): string {
    const rows = rec.rows
      .map((p) => {
        const fate = p.eliminated ? `${p.eliminated.toUpperCase()}${p.by ? ` by ${esc(p.by)}` : ""}` : `${p.hp} hp left`;
        const why = [`${POINTS.place[p.place - 1] ?? 0} place`, p.elims ? `${p.elims * POINTS.elimination} elims` : "", p.topDamage ? `${POINTS.topDamage} top damage` : ""].filter(Boolean).join(" + ");
        const gain = rec.stage === "league" ? `+${p.points}` : p.place <= (rec.stage === "final" ? 1 : 2) ? "✓" : "✕";
        return `<tr class="${p.place === 1 ? "win" : ""}"><td>${p.place}</td><td class="nm">${this.bot(s, p.id)}</td><td>${fate}</td><td>${p.damage} dmg</td><td class="pts" title="${rec.stage === "league" ? why : ""}">${gain}</td></tr>`;
      })
      .join("");
    const latest = lastRecord(s) === rec;
    return `
      <section class="sz-panel sz-recap">
        <header><h2>${latest ? "Last result" : "Result"} · ${esc(rec.label)}</h2><p>${rec.duration.toFixed(0)}s · ${rec.reason === "judges" ? "judges' decision" : rec.reason === "draw" ? "nobody left standing" : "last bot standing"}${rec.simulated ? " · simulated" : ""}${latest ? "" : ` · <a data-act="rec" data-id="">show latest</a>`}</p></header>
        <ul class="sz-headlines">${rec.headlines.map((h, i) => `<li class="${i === 0 ? "lead" : ""}">${esc(h)}</li>`).join("")}</ul>
        <table class="sz-result">${rows}</table>
      </section>`;
  }

  private renderStories(s: SeasonState): string {
    const feuds = rivalries(s).slice(0, 4);
    const table = standings(s);
    const hot = table.filter((r) => winStreak(s, r.id) >= 2).map((r) => `<li>🔥 ${this.bot(s, r.id)} ${winStreak(s, r.id)} wins in a row</li>`);
    const cold = table.filter((r) => r.played >= 2 && r.wins === 0).slice(-2).map((r) => `<li>${this.bot(s, r.id)} still without a win</li>`);
    const feudRows = feuds
      .map((f) => `<li class="sz-feud">${this.bot(s, f.a)}<span class="sz-score">${f.aKills} : ${f.bKills}</span>${this.bot(s, f.b)}<small>${f.last ? `last: ${esc(f.last.killer)} in ${esc(f.last.label)}` : ""}</small></li>`)
      .join("");
    return `
      <header><h2>Storylines</h2></header>
      ${feudRows ? `<h3>Rivalries <small>eliminations, head to head</small></h3><ul class="sz-stories">${feudRows}</ul>` : `<p class="sz-note">Rivalries start with the first elimination.</p>`}
      ${hot.length || cold.length ? `<h3>Form</h3><ul class="sz-stories">${hot.join("")}${cold.join("")}</ul>` : ""}`;
  }

  private renderSchedule(s: SeasonState): string {
    const rows: string[] = [];
    for (const f of s.fixtures) {
      const r = recordFor(s, f.id);
      const isNext = nextFixture(s)?.id === f.id;
      rows.push(
        r
          ? `<li class="played${this.shown === f.id ? " on" : ""}" data-act="rec" data-id="${f.id}"><span>${esc(f.label)}</span><b>${esc(r.rows[0].id)}</b><small>${f.bots.map(esc).join(" · ")}</small></li>`
          : `<li class="${isNext ? "next" : ""}"><span>${esc(f.label)}</span><b>${isNext ? "next" : ""}</b><small>${f.bots.map(esc).join(" · ")}</small></li>`,
      );
    }
    if (!s.fixtures.some((f) => f.stage === "lastchance")) rows.push(`<li class="tbd"><span>Last Chance</span><b></b><small>${ordinal(DIRECT_FINALISTS + 1)} to ${ordinal(LAST_CHANCE_CUT)} in the table; top two go through</small></li>`);
    if (!s.fixtures.some((f) => f.stage === "final")) rows.push(`<li class="tbd"><span>Grand Final</span><b></b><small>table top ${DIRECT_FINALISTS} + Last Chance top two</small></li>`);
    return `<header><h2>Schedule</h2></header><ul class="sz-schedule">${rows.join("")}</ul>`;
  }

  private renderChampion(s: SeasonState): string {
    const champ = entrant(s, s.champion!)!;
    const order = finalOrder(s);
    const awards = seasonAwards(s)
      .filter((a) => a.title !== "Champion")
      .map((a) => `<li><span>${esc(a.title)}</span>${this.bot(s, a.id)}<small>${esc(a.detail)}</small></li>`)
      .join("");
    const story = s.records.map((r) => `<li data-act="rec" data-id="${r.fixtureId}"><span>${esc(r.label)}</span>${esc(r.headlines[0] ?? "")}</li>`).join("");
    return `
      <section class="sz-panel sz-champion" style="--c:${hex(champ.build.color)}">
        <div class="sz-next-kicker">SEASON CHAMPION</div>
        <div class="sz-champ-name"><span class="sz-champ-icon">${WEAPON_ICON[champ.build.kind]}</span>${esc(champ.id)}</div>
        <p class="sz-hook">${esc(champ.build.tagline)}${this.isMine(champ) ? " Your build took the title." : champ.owner ? ` Designed by ${esc(accounts.nameOf(champ.owner.id) ?? champ.owner.name)}.` : ""}</p>
        <ol class="sz-podium">${order.map((id, i) => `<li class="${i < 4 ? "finalist" : ""}"><span>${ordinal(i + 1)}</span>${this.bot(s, id)}</li>`).join("")}</ol>
      </section>
      <section class="sz-panel"><header><h2>Honours</h2></header><ul class="sz-awards">${awards}</ul></section>
      <section class="sz-panel"><header><h2>The season in ten lines</h2></header><ul class="sz-story">${story}</ul></section>`;
  }
}

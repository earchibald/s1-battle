import type { Maneuver } from "@shared/types";
import type { Brain, BrainMode } from "../brain/brains";
import { ARENA, padPhase, pitCountdown, pitPhase, sawPhase, shockPhase, ventsPhase } from "../sim/arena";
import type { Bot } from "../sim/bot";
import type { World } from "../sim/world";
import { BUILD_TIME, VERSION, VERSION_LABEL } from "../version";
import { fullscreenSupported, onFullscreenChange } from "./fullscreen";
import changelog from "../../CHANGELOG.md?raw";
import { EventLog, type LogInput } from "./eventlog";
import { helpRows, keyHint, PILOT_KEYS, type KeyAction } from "./keymap";

export interface HudCallbacks {
  toggleBrain(botId: string): void;
  setAllBrains(mode: BrainMode): void;
  newMatch(): void;
  togglePause(): void;
  setSpeed(x: number): void;
  toggleCamera(): void;
  toggleDebug(): void;
  toggleSound(): void;
  toggleDesigner(): void;
  toggleSeason(): void;
  toggleAccount(): void;
  toggleFullscreen(): void;
}

export interface TrainedInfo {
  loaded: boolean;
  /** Why it is not loaded, or a one-line description of the model. */
  detail: string;
}

export interface JevInfo {
  configured: boolean;
  model: string;
  requests?: number;
  errors?: number;
  avgLatencyMs?: number;
  p95LatencyMs?: number;
  inputTokens?: number;
}

export const WEAPON_ICON: Record<string, string> = {
  saw: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="6" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1" stroke="currentColor" stroke-width="2"/></svg>`,
  hammer: `<svg viewBox="0 0 24 24"><path d="M4 20l8-8" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/><rect x="11" y="3" width="10" height="7" rx="1.5" transform="rotate(45 16 6.5)" fill="currentColor"/></svg>`,
  grabber: `<svg viewBox="0 0 24 24"><path d="M6 4c-3 4-3 9 0 13M18 4c3 4 3 9 0 13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/><path d="M12 10v10" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>`,
  flipper: `<svg viewBox="0 0 24 24"><path d="M3 18h18" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/><path d="M4 16L20 8" stroke="currentColor" stroke-width="3" stroke-linecap="round"/><path d="M14 4l4 4-5 1" fill="currentColor"/></svg>`,
  spinner: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="2.2" fill="currentColor"/><path d="M3 12h18" stroke="currentColor" stroke-width="3" stroke-linecap="round"/><path d="M3 12l3-2.5M21 12l-3 2.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M6 6.5a7.5 7.5 0 0 1 12 0M6 17.5a7.5 7.5 0 0 0 12 0" fill="none" stroke="currentColor" stroke-width="1.2" stroke-dasharray="2 2"/></svg>`,
  torch: `<svg viewBox="0 0 24 24"><path d="M12 22c-4 0-7-3-7-6.5 0-3 2-5 3.5-7.5.5 2 1.5 3 2.5 3.5C11 9 11.5 5 13.5 2c2 3 5.5 6.5 5.5 11 0 4-3 9-7 9z" fill="currentColor"/><path d="M12 22c-2 0-3.5-1.5-3.5-3.5 0-2 1.5-3 2.5-4.5.5 1.5 1.5 2 2 2.5.5-1 .5-2.5 1-3.5 1 1.5 2 3 2 5 0 2.2-1.8 4-4 4z" fill="#16100a" opacity=".55"/></svg>`,
  ram: `<svg viewBox="0 0 24 24"><path d="M3 19h14l4-7-4-7H3z" fill="currentColor"/><path d="M6 8v8M10 8v8" stroke="#16100a" stroke-width="1.6" opacity=".6"/><path d="M3 5v14" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>`,
};

const MANEUVER_LABEL: Record<Maneuver, string> = {
  engage: "ENGAGE",
  flank: "FLANK",
  circle: "CIRCLE",
  retreat: "RETREAT",
  hold: "HOLD",
  spin_up: "SPIN UP",
  strike_now: "STRIKE!",
  grab_now: "GRAB!",
  drag_to_pit: "DRAG → PIT",
  drag_to_saws: "DRAG → SAWS",
  crush: "CRUSH",
  release: "RELEASE",
  flip_now: "FLIP!",
  burn: "BURN!",
  ram_now: "RAM!",
  shove_to_pit: "SHOVE → PIT",
  shove_to_saws: "SHOVE → SAWS",
};
export const maneuverLabel = (m: Maneuver) => MANEUVER_LABEL[m] ?? m.toUpperCase();

interface Card {
  root: HTMLElement;
  hp: HTMLElement;
  /** The "recent damage" ghost behind the HP fill: holds for a beat after a hit, then drains. */
  hpChip: HTMLElement;
  hpText: HTMLElement;
  charge: HTMLElement;
  chargeLabel: HTMLElement;
  /** HP fraction the chip segment is showing, and when it may start draining. */
  lag: number;
  lagHoldUntil: number;
  status: HTMLElement;
  brain: HTMLButtonElement;
  maneuver: HTMLElement;
  target: HTMLElement;
  probs: HTMLElement;
  latency: HTMLElement;
  danger: HTMLElement;
}

/** Compact chips for the three traps: grey when idle, amber while telegraphing, red while firing. */
function trapChips(t: number): string {
  const vents = ventsPhase(t);
  const pad = padPhase(t);
  const plates = ARENA.shock.plates.map((_, i) => shockPhase(i, t));
  const plate = plates.findIndex((p) => p !== "idle");
  const shock = plate < 0 ? "" : plates[plate] === "live" ? "open" : "warning";
  return `
      <div class="hz-row">
      <div class="hz ${vents === "erupting" ? "open" : vents === "warning" ? "warning" : ""}" title="Flame vents">VENTS</div>
      <div class="hz ${pad === "charging" ? "warning" : ""}" title="Launch pad">PAD</div>
      <div class="hz ${shock}" title="Shock plates">SHOCK${plate < 0 ? "" : plate === 0 ? " W" : " E"}</div>
      </div>`;
}

export class Hud {
  private cards = new Map<string, Card>();
  private cardsEl: HTMLElement;
  private tickerEl: HTMLElement;
  private clockEl: HTMLElement;
  private phaseEl: HTMLElement;
  private matchEl: HTMLElement;
  private hazardsEl: HTMLElement;
  private jevEl: HTMLElement;
  private netEl: HTMLElement;
  private resultEl: HTMLElement;
  private controls: Record<string, HTMLButtonElement> = {};
  private jevInfo: JevInfo = { configured: false, model: "" };
  private world: World | null = null;
  private newsEl: HTMLElement;
  /** The match whose result card is currently built. */
  private resultFor: World | null = null;
  /** Every thought and commentary line of the session, browsable; a tab in the lower right until opened. */
  readonly log: EventLog;
  /** Replaces "MATCH n" in the top bar (season fixtures name themselves). */
  matchLabel: string | null = null;

  constructor(root: HTMLElement, private cb: HudCallbacks) {
    root.innerHTML = `
      <div class="hud-top">
        <div class="hud-id">
          <div class="hud-match" id="hud-match">MATCH 1</div>
          <button class="hud-version" id="hud-version" title="What's new"></button>
        </div>
        <div class="hud-clock"><div class="hud-phase" id="hud-phase"></div><div class="hud-time" id="hud-time">3:00</div></div>
        <div class="hud-hazards" id="hud-hazards"></div>
      </div>
      <div class="hud-cards" id="hud-cards"></div>
      <div class="hud-side">
        <div class="hud-jev" id="hud-jev"></div>
        <div class="hud-jev hud-net" id="hud-net"></div>
      </div>
      <div class="hud-ticker" id="hud-ticker"></div>
      <div class="hud-controls" id="hud-controls">
        <button data-k="pause" data-key="pause">⏸ Pause</button>
        <div class="seg"><button data-k="s05" data-key="slower">½×</button><button data-k="s1" class="on">1×</button><button data-k="s2" data-key="faster">2×</button></div>
        <button data-k="cam" data-key="camera">🎥 Auto cam</button>
        <button data-k="debug" data-key="debug">◎ Debug</button>
        <button data-k="sound" data-key="mute">🔊</button>
        <button data-k="fullscreen" data-key="fullscreen" data-name="Fullscreen" aria-label="Fullscreen">⛶</button>
        <button data-k="keys" data-key="help" data-name="Keyboard controls">? Keys</button>
        <div class="seg"><button data-k="alljev" data-key="allJev">All Jev</button><button data-k="alltrained" data-key="allTrained">All Trained</button><button data-k="allbase" data-key="allBaseline">All Baseline</button></div>
        <button data-k="account" class="account" data-key="users" data-name="Users: wallet and designer record"><i></i><b></b><span></span></button>
        <button data-k="garage" class="garage" data-key="garage">🛠 Garage</button>
        <button data-k="season" class="season" data-key="season">🏆 Season</button>
        <button data-k="new" class="primary" data-key="newMatch">⟳ New match</button>
      </div>
      <div class="hud-result hidden" id="hud-result"></div>
      <div class="hud-news hidden" id="hud-news"></div>
    `;
    this.cardsEl = root.querySelector("#hud-cards")!;
    this.tickerEl = root.querySelector("#hud-ticker")!;
    this.clockEl = root.querySelector("#hud-time")!;
    this.phaseEl = root.querySelector("#hud-phase")!;
    this.matchEl = root.querySelector("#hud-match")!;
    this.hazardsEl = root.querySelector("#hud-hazards")!;
    this.jevEl = root.querySelector("#hud-jev")!;
    this.netEl = root.querySelector("#hud-net")!;
    this.resultEl = root.querySelector("#hud-result")!;
    this.newsEl = root.querySelector("#hud-news")!;
    const ver = root.querySelector<HTMLButtonElement>("#hud-version")!;
    ver.textContent = VERSION_LABEL;
    if (BUILD_TIME) ver.title = `What's new · built ${new Date(BUILD_TIME).toLocaleString()}`;
    ver.onclick = () => this.toggleNews();
    this.log = new EventLog(root, () => this.logClock(), (open) => root.classList.toggle("log-open", open));
    root.querySelectorAll<HTMLButtonElement>("#hud-controls button").forEach((b) => {
      this.controls[b.dataset.k!] = b;
      const action = b.dataset.key as KeyAction | undefined;
      if (action) b.title = b.dataset.name ? `${b.dataset.name} (${keyHint(action)})` : keyHint(action);
    });
    this.controls.keys.onclick = () => this.toggleKeys();
    this.controls.pause.onclick = () => cb.togglePause();
    this.controls.s05.onclick = () => cb.setSpeed(0.5);
    this.controls.s1.onclick = () => cb.setSpeed(1);
    this.controls.s2.onclick = () => cb.setSpeed(2);
    this.controls.cam.onclick = () => cb.toggleCamera();
    this.controls.debug.onclick = () => cb.toggleDebug();
    this.controls.sound.onclick = () => cb.toggleSound();
    this.controls.alljev.onclick = () => cb.setAllBrains("jev");
    this.controls.allbase.onclick = () => cb.setAllBrains("baseline");
    this.controls.alltrained.onclick = () => cb.setAllBrains("trained");
    this.controls.new.onclick = () => cb.newMatch();
    this.controls.garage.onclick = () => cb.toggleDesigner();
    this.controls.season.onclick = () => cb.toggleSeason();
    this.controls.account.onclick = () => cb.toggleAccount();
    this.controls.fullscreen.onclick = () => cb.toggleFullscreen();
    if (!fullscreenSupported) this.controls.fullscreen.style.display = "none";
    onFullscreenChange((on) => {
      this.controls.fullscreen.classList.toggle("on", on);
      this.controls.fullscreen.title = on ? `Exit fullscreen (${keyHint("fullscreen")} or Esc)` : `Fullscreen (${keyHint("fullscreen")})`;
    });
  }

  private card(bot: Bot): Card {
    let c = this.cards.get(bot.id);
    if (c) return c;
    const root = document.createElement("div");
    root.className = "card";
    root.style.setProperty("--c", "#" + bot.def.color.toString(16).padStart(6, "0"));
    root.innerHTML = `
      <div class="card-head">
        <span class="card-icon">${WEAPON_ICON[bot.kind]}</span>
        <div class="card-title"><div class="card-name">${bot.id}</div><div class="card-weapon">${bot.def.weapon} · ${bot.def.build.levels.armor ? bot.def.build.levels.armor * 9 + "% armor" : "no armor"}</div></div>
        <button class="brain-toggle" title="Toggle this bot's brain"></button>
      </div>
      <div class="bar hp"><div class="chip"></div><div class="fill"></div><span class="bar-text"></span></div>
      <div class="charge-row"><div class="bar charge"><div class="fill"></div></div><span class="charge-label"></span></div>
      <div class="card-status"></div>
      <div class="decision">
        <div class="decision-main"><span class="maneuver"></span><span class="target"></span></div>
        <div class="probs"></div>
        <div class="decision-meta"><span class="danger"></span><span class="latency"></span></div>
      </div>
    `;
    this.cardsEl.appendChild(root);
    c = {
      root,
      hp: root.querySelector(".hp .fill")!,
      hpChip: root.querySelector(".hp .chip")!,
      hpText: root.querySelector(".hp .bar-text")!,
      charge: root.querySelector(".charge .fill")!,
      chargeLabel: root.querySelector(".charge-label")!,
      lag: bot.hpFrac,
      lagHoldUntil: 0,
      status: root.querySelector(".card-status")!,
      brain: root.querySelector(".brain-toggle")!,
      maneuver: root.querySelector(".maneuver")!,
      target: root.querySelector(".target")!,
      probs: root.querySelector(".probs")!,
      latency: root.querySelector(".latency")!,
      danger: root.querySelector(".danger")!,
    };
    c.brain.onclick = () => this.cb.toggleBrain(bot.id);
    this.cards.set(bot.id, c);
    return c;
  }

  /**
   * One line of commentary: always recorded in the event log, and shown briefly in the on-screen ticker
   * unless it is a bot's thought (those are too frequent to read in passing; the log has them all).
   */
  ticker(text: string, cls = "", meta: Omit<LogInput, "text" | "cls"> = {}) {
    const entry = this.log.add({ ...meta, text, cls });
    if (entry.cat === "thought") return;
    const line = document.createElement("div");
    line.className = `line ${cls}`;
    appendWithBots(line, text, this.botColors());
    this.tickerEl.appendChild(line);
    while (this.tickerEl.children.length > 5) this.tickerEl.firstElementChild?.remove();
    setTimeout(() => line.classList.add("fade"), 7000);
  }

  /** A bot's decision, for the event log only: "FLANK → CLAMP" plus the brain's full note. */
  thought(botId: string, text: string, detail: string, source: string) {
    this.log.add({ cat: "thought", cls: source === "jev" ? "jev" : source === "trained" ? "net" : "base", text, detail, bots: [botId], source });
  }

  /** Callsign -> CSS colour for the bots in the current match. */
  private botColors(): Map<string, string> {
    const m = new Map<string, string>();
    for (const b of this.world?.bots ?? []) m.set(b.id, hex(b.def.color));
    return m;
  }

  private logClock() {
    const w = this.world;
    const bots = new Map<string, string>();
    for (const b of w?.bots ?? []) bots.set(b.id, "#" + b.def.color.toString(16).padStart(6, "0"));
    return { match: w?.matchNumber ?? 0, t: w?.fightTime ?? 0, bots };
  }

  /** Point the log's clock at a new match before its first lines arrive. */
  setWorld(world: World) {
    this.world = world;
  }

  /** The keyboard map (H or ?), in the same slot as What's new. */
  toggleKeys() {
    this.togglePanel("keys", renderKeys);
  }

  /** Esc: close the key list or What's new if either is up. True when something closed. */
  closePanel(): boolean {
    if (this.newsEl.classList.contains("hidden")) return false;
    this.newsEl.classList.add("hidden");
    return true;
  }

  private toggleNews() {
    this.togglePanel("news", renderNews);
  }

  private togglePanel(panel: string, render: () => HTMLElement) {
    if (!this.newsEl.classList.contains("hidden") && this.newsEl.dataset.panel === panel) {
      this.newsEl.classList.add("hidden");
      return;
    }
    this.newsEl.replaceChildren(render());
    this.newsEl.dataset.panel = panel;
    this.newsEl.classList.remove("hidden");
  }

  /** The user at the controls and their wallet, on the Users button. */
  setAccount(name: string, credits: string, color: number) {
    const b = this.controls.account;
    b.style.setProperty("--c", "#" + color.toString(16).padStart(6, "0"));
    b.querySelector("b")!.textContent = name;
    b.querySelector("span")!.textContent = credits;
  }

  setJev(info: JevInfo) {
    this.jevInfo = { ...this.jevInfo, ...info };
    const i = this.jevInfo;
    if (!i.configured) {
      this.jevEl.innerHTML = `<div class="jev-title off">JEV OFFLINE</div><div class="jev-sub">No TYPESAFE_API_KEY on the server — Jev bots run the local trained brain instead (baseline if that is not loaded).</div>`;
      return;
    }
    this.jevEl.innerHTML = `
      <div class="jev-title"><span class="dot"></span>JEV LIVE <span class="model">${i.model}</span></div>
      <div class="jev-grid">
        <span>decisions</span><b>${i.requests ?? 0}</b>
        <span>avg latency</span><b>${i.avgLatencyMs ?? 0} ms</b>
        <span>p95</span><b>${i.p95LatencyMs ?? 0} ms</b>
        <span>errors</span><b>${i.errors ?? 0}</b>
        <span>tokens in</span><b>${((i.inputTokens ?? 0) / 1000).toFixed(1)}k</b>
      </div>`;
  }

  setTrained(info: TrainedInfo) {
    this.netEl.innerHTML = info.loaded
      ? `<div class="jev-title net"><span class="dot"></span>TRAINED BRAIN <span class="model">local</span></div><div class="jev-sub">${info.detail}</div>`
      : `<div class="jev-title off">TRAINED BRAIN OFF</div><div class="jev-sub">${info.detail}</div>`;
  }

  setControls(paused: boolean, speed: number, autoCam: boolean, debug: boolean, muted = false) {
    this.controls.pause.textContent = paused ? "▶ Resume" : "⏸ Pause";
    this.controls.sound.textContent = muted ? "🔇" : "🔊";
    this.controls.sound.classList.toggle("on", !muted);
    this.controls.s05.classList.toggle("on", speed === 0.5);
    this.controls.s1.classList.toggle("on", speed === 1);
    this.controls.s2.classList.toggle("on", speed === 2);
    this.controls.cam.textContent = autoCam ? "🎥 Auto cam" : "🎥 Free cam";
    this.controls.debug.classList.toggle("on", debug);
  }

  update(world: World, brains: Map<string, Brain>) {
    this.world = world;
    this.matchEl.textContent = this.matchLabel ?? `MATCH ${world.matchNumber}`;
    if (world.phase === "countdown") {
      this.phaseEl.textContent = world.countdown > 0.6 ? String(Math.ceil(world.countdown)) : "FIGHT!";
      this.phaseEl.className = "hud-phase count";
    } else if (world.phase === "ended") {
      this.phaseEl.textContent = "MATCH OVER";
      this.phaseEl.className = "hud-phase";
    } else {
      this.phaseEl.textContent = world.fightTime < 1.2 ? "FIGHT!" : "";
      this.phaseEl.className = "hud-phase count";
    }
    const tl = world.timeLeft;
    this.clockEl.textContent = `${Math.floor(tl / 60)}:${String(Math.floor(tl % 60)).padStart(2, "0")}`;
    this.clockEl.classList.toggle("urgent", tl <= 30 && world.phase === "fighting");

    const t = world.fightTime;
    const pit = pitPhase(t);
    const pc = pitCountdown(t);
    const saws = sawPhase(t);
    this.hazardsEl.innerHTML = `
      <div class="hz ${pit}">PIT ${pit === "open" ? "OPEN" : pit === "warning" ? "OPENING" : `in ${Math.ceil(pc)}s`}</div>
      <div class="hz saws-${saws}">SAWS ${saws === "up" ? "UP" : saws === "rising" ? "RISING" : "down"}</div>${trapChips(t)}`;

    // Rosters change between matches now, so drop cards for bots that are not in this one.
    for (const [id, c] of this.cards) {
      if (!world.bots.some((b) => b.id === id)) {
        c.root.remove();
        this.cards.delete(id);
      }
    }
    for (const bot of world.bots) {
      const c = this.card(bot);
      const brain = brains.get(bot.id);
      c.root.classList.toggle("dead", !bot.alive);
      c.root.classList.toggle("danger", bot.alive && bot.intent.danger > 0.65);
      const hp = bot.alive ? bot.hpFrac : 0;
      const now = performance.now();
      if (hp > c.lag) c.lag = hp; // healed or a new match: no ghost
      else if (hp < c.lag - 0.001 && c.lagHoldUntil < now - 1000) c.lagHoldUntil = now + 450; // fresh hit: hold, then drain
      if (now > c.lagHoldUntil) c.lag = Math.max(hp, c.lag - 0.012);
      c.hp.style.width = `${hp * 100}%`;
      c.hp.style.background = hpGradient(hp);
      c.hpChip.style.width = `${c.lag * 100}%`;
      c.hpText.textContent = bot.alive ? `${Math.max(0, Math.ceil(bot.hp))} / ${bot.def.stats.hp}` : bot.eliminated === "pitted" ? "PITTED" : "DESTROYED";
      c.root.classList.toggle("low", bot.alive && hp < 0.3);
      c.charge.style.width = `${bot.weaponCharge * 100}%`;
      c.charge.classList.toggle("ready", bot.weaponReady);
      c.chargeLabel.textContent = !bot.alive ? "" : bot.weaponReady ? "READY" : `${Math.floor(bot.weaponCharge * 100)}%`;
      c.chargeLabel.classList.toggle("ready", bot.alive && bot.weaponReady);
      c.status.textContent = statusLine(bot);
      if (brain) {
        const eff = brain.effectiveMode;
        c.brain.textContent = brain.mode === "jev" ? (eff === "jev" ? "JEV" : "JEV→NET") : brain.mode === "trained" ? "TRAINED" : "BASELINE";
        c.brain.className = `brain-toggle ${eff}${brain.status.inFlight ? " busy" : ""}`;
        c.brain.title = "Click to cycle Jev → Trained → Baseline";
      }
      const it = bot.intent;
      c.maneuver.textContent = maneuverLabel(it.maneuver);
      c.maneuver.dataset.source = it.source;
      c.target.textContent = it.target ? `→ ${it.target}` : "";
      const entries = Object.entries(it.probabilities).sort((a, b) => b[1] - a[1]).slice(0, 3);
      c.probs.innerHTML = entries
        .map(([m, p]) => `<div class="prob"><span>${maneuverLabel(m as Maneuver)}</span><i style="width:${(p * 100).toFixed(0)}%"></i><b>${(p * 100).toFixed(0)}</b></div>`)
        .join("");
      c.danger.textContent = `danger ${(it.danger * 100).toFixed(0)}%`;
      c.danger.classList.toggle("hot", it.danger > 0.65);
      c.latency.textContent =
        it.source === "jev" ? `${it.latencyMs} ms` : it.source === "trained" ? `${Math.max(1, Math.round(it.latencyMs * 1000))} µs` : it.source === "fallback" ? "fallback" : "scripted";
    }
  }

  showResult(world: World, secondsToNext: number | null) {
    const r = world.result;
    if (!r) return;
    this.resultEl.classList.remove("hidden");
    const next = secondsToNext !== null ? `Next match in <b>${Math.max(0, Math.ceil(secondsToNext))}s</b> · N to skip` : "Press N for a new match";
    // Called every frame while the result shows: build the card once (so its entrance animation plays), then just tick the countdown.
    if (this.resultFor === world) {
      const el = this.resultEl.querySelector(".result-next");
      if (el && el.innerHTML !== next) el.innerHTML = next;
      return;
    }
    this.resultFor = world;
    const winner = r.winner ? world.bot(r.winner) : null;
    const rows = r.standings
      .map((s, i) => {
        const b = world.bot(s.id)!;
        const brain = [b.stats.jevDecisions > 0 ? "Jev" : "", b.stats.trainedDecisions > 0 ? "trained" : "", b.stats.decisions > b.stats.jevDecisions + b.stats.trainedDecisions ? "baseline" : ""].filter(Boolean).join(" + ") || "baseline";
        const fate = s.eliminated ? `<span class="fate ${s.eliminated}">${s.eliminated.toUpperCase()}</span>` : `<span class="fate alive">${s.hp} hp</span>`;
        return `<tr class="${s.id === r.winner ? "win" : ""}" style="--c:${hex(b.def.color)}">
          <td class="rank">${i + 1}</td>
          <td class="who"><span class="who-icon">${WEAPON_ICON[b.kind] ?? ""}</span>${s.id}</td>
          <td>${fate}</td>
          <td class="num">${s.damageDealt}</td>
          <td class="num">${b.stats.hits}</td>
          <td class="brain">${b.stats.decisions} · ${brain}</td>
        </tr>`;
      })
      .join("");
    const wc = hex(winner?.def.color ?? 0xffffff);
    this.resultEl.innerHTML = `
      <div class="result-card" style="--c:${wc}">
        <div class="result-kicker">${r.reason === "judges" ? "JUDGES' DECISION" : r.reason === "draw" ? "DRAW" : "LAST BOT STANDING"}</div>
        <div class="result-head">
          ${winner ? `<span class="result-icon">${WEAPON_ICON[winner.kind] ?? ""}</span>` : ""}
          <div class="result-winner">${r.winner ?? "NOBODY"}</div>
        </div>
        <div class="result-sub">${winner ? `${winner.def.tagline} · ` : ""}${world.fightTime.toFixed(0)}s</div>
        <table>
          <thead><tr><th>#</th><th>Bot</th><th>Result</th><th class="num">Damage</th><th class="num">Hits</th><th>Decisions · brain</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <div class="result-next">${next}</div>
      </div>`;
  }
  hideResult() {
    this.resultFor = null;
    this.resultEl.classList.add("hidden");
  }
}

const hex = (c: number) => "#" + c.toString(16).padStart(6, "0");

/** Health fill: green when healthy, amber at half, red when critical; a light top edge so it reads as a bar. */
function hpGradient(f: number): string {
  const h = Math.round(f > 0.5 ? 50 + (f - 0.5) * 2 * 82 : f * 2 * 50); // 132 (green) → 50 (amber) → 0 (red)
  return `linear-gradient(180deg, hsl(${h} 95% 66%) 0%, hsl(${h} 88% 50%) 55%, hsl(${h} 90% 40%) 100%)`;
}

/** Text with every current-match callsign wrapped in a span tinted that bot's colour. */
function appendWithBots(el: HTMLElement, text: string, bots: Map<string, string>) {
  const ids = [...bots.keys()].sort((a, b) => b.length - a.length);
  if (!ids.length) {
    el.textContent = text;
    return;
  }
  const re = new RegExp(`(${ids.map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "g");
  for (const part of text.split(re)) {
    if (!part) continue;
    const c = bots.get(part);
    if (c) {
      const span = document.createElement("span");
      span.className = "who";
      span.style.setProperty("--c", c);
      span.textContent = part;
      el.append(span);
    } else el.append(part);
  }
}

function statusWeapon(bot: Bot): string {
  switch (bot.kind) {
    case "saw":
      return `blade ${(bot.weapon.spin * 100).toFixed(0)}%`;
    case "spinner":
      return `bar ${(bot.weapon.spin * 100).toFixed(0)}%`;
    case "ram":
      return `boost ${(bot.weapon.spin * 100).toFixed(0)}%`;
    default:
      return bot.weaponReady ? "weapon ready" : "recharging";
  }
}

function statusLine(bot: Bot): string {
  if (!bot.alive) return bot.eliminated === "pitted" ? "fell into the pit" : "wrecked";
  if (bot.airborne) return bot.burn > 0 ? "AIRBORNE · burning" : "AIRBORNE";
  if (bot.heldBy) return `held by ${bot.heldBy.id}`;
  if (bot.stun > 0) return bot.burn > 0 ? "stunned · burning" : "stunned";
  if (bot.burn > 0 && bot.kind !== "torch") return `ON FIRE · ${statusWeapon(bot)}`;
  if (bot.holding) return `holding ${bot.holding.id} (${Math.max(0, bot.def.tuning.grabber.maxHold - bot.weapon.holdTime).toFixed(1)}s)`;
  switch (bot.kind) {
    case "saw":
      return `blade ${(bot.weapon.spin * 100).toFixed(0)}%`;
    case "hammer":
      return bot.weapon.hammerPhase !== "idle" ? bot.weapon.hammerPhase : bot.weaponReady ? "hammer ready" : `recharging ${bot.weapon.cooldown.toFixed(1)}s`;
    case "grabber":
      return bot.weaponReady ? "jaws ready" : `recharging ${bot.weapon.cooldown.toFixed(1)}s`;
    case "flipper":
      return bot.weaponReady ? "flipper charged" : `recharging ${bot.weapon.cooldown.toFixed(1)}s`;
    case "spinner":
      return `bar ${(bot.weapon.spin * 100).toFixed(0)}%`;
    case "torch":
      return `${bot.weapon.firing ? "FLAME ON · " : ""}fuel ${(bot.weapon.spin * 100).toFixed(0)}%${bot.burn > 0 ? " · burning" : ""}`;
    case "ram":
      return `${bot.weapon.boosting ? "BOOSTING · " : ""}boost ${(bot.weapon.spin * 100).toFixed(0)}%`;
  }
}
export { ARENA };

/** The keyboard map as a card: the arena keys from the keymap table, then the keys held back for piloting. */
function renderKeys(): HTMLElement {
  const card = document.createElement("div");
  card.className = "news-card keys-card";
  const h = document.createElement("div");
  h.className = "news-head";
  h.textContent = "Keyboard";
  const close = document.createElement("button");
  close.className = "news-close";
  close.textContent = "✕";
  close.onclick = () => card.parentElement?.classList.add("hidden");
  h.append(close);
  card.append(h);
  const grid = document.createElement("div");
  grid.className = "keys-grid";
  const section = (title: string, rows: { keys: string[]; label: string }[]) => {
    const sec = document.createElement("section");
    sec.append(Object.assign(document.createElement("h4"), { textContent: title }));
    for (const r of rows) {
      const row = document.createElement("div");
      row.className = "keys-row";
      const ks = document.createElement("span");
      ks.className = "keys-keys";
      for (const k of r.keys) ks.append(Object.assign(document.createElement("kbd"), { textContent: k }));
      row.append(ks, Object.assign(document.createElement("span"), { textContent: r.label }));
      sec.append(row);
    }
    grid.append(sec);
  };
  for (const g of helpRows()) section(g.group, g.rows);
  section("Pilot (reserved)", PILOT_KEYS);
  card.append(grid);
  return card;
}

/** The newest CHANGELOG.md section as DOM: heading, then bullets with **bold** and `code`. */
function renderNews(): HTMLElement {
  const card = document.createElement("div");
  card.className = "news-card";
  const sections = changelog.split(/^## /m).slice(1);
  const latest = sections[0] ?? `${VERSION}\n`;
  const [heading, ...body] = latest.split("\n");
  const h = document.createElement("div");
  h.className = "news-head";
  h.textContent = `What's new in v${heading.trim()}`;
  const close = document.createElement("button");
  close.className = "news-close";
  close.textContent = "✕";
  close.onclick = () => card.parentElement?.classList.add("hidden");
  h.append(close);
  card.append(h);
  const ul = document.createElement("ul");
  // Bullets may wrap onto indented continuation lines; join them first.
  const items: string[] = [];
  for (const line of body) {
    if (/^- /.test(line)) items.push(line.slice(2));
    else if (/^\s+\S/.test(line) && items.length) items[items.length - 1] += " " + line.trim();
  }
  for (const it of items) {
    const li = document.createElement("li");
    for (const part of it.split(/(\*\*[^*]+\*\*|`[^`]+`)/)) {
      if (part.startsWith("**")) li.append(Object.assign(document.createElement("b"), { textContent: part.slice(2, -2) }));
      else if (part.startsWith("`")) li.append(Object.assign(document.createElement("code"), { textContent: part.slice(1, -1) }));
      else if (part) li.append(part);
    }
    ul.append(li);
  }
  card.append(ul);
  if (sections.length > 1) {
    const older = document.createElement("div");
    older.className = "news-older";
    older.textContent = `Earlier: ${sections.slice(1).map((x) => "v" + x.split(/\s/)[0]).join(", ")} · full history in CHANGELOG.md`;
    card.append(older);
  }
  return card;
}

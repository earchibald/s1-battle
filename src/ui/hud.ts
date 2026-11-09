import type { Maneuver } from "@shared/types";
import type { Brain, BrainMode } from "../brain/brains";
import { ARENA, padPhase, pitCountdown, pitPhase, sawPhase, shockPhase, ventsPhase } from "../sim/arena";
import type { Bot } from "../sim/bot";
import type { World } from "../sim/world";

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
  hpText: HTMLElement;
  charge: HTMLElement;
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

  constructor(root: HTMLElement, private cb: HudCallbacks) {
    root.innerHTML = `
      <div class="hud-top">
        <div class="hud-match" id="hud-match">MATCH 1</div>
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
        <button data-k="pause" title="Space">⏸ Pause</button>
        <div class="seg"><button data-k="s05">½×</button><button data-k="s1" class="on">1×</button><button data-k="s2">2×</button></div>
        <button data-k="cam" title="C">🎥 Auto cam</button>
        <button data-k="debug" title="D">◎ Debug</button>
        <button data-k="sound" title="M">🔊</button>
        <div class="seg"><button data-k="alljev" title="J">All Jev</button><button data-k="alltrained" title="T">All Trained</button><button data-k="allbase" title="B">All Baseline</button></div>
        <button data-k="garage" class="garage" title="G">🛠 Garage</button>
        <button data-k="new" class="primary" title="N">⟳ New match</button>
      </div>
      <div class="hud-result hidden" id="hud-result"></div>
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
    root.querySelectorAll<HTMLButtonElement>("#hud-controls button").forEach((b) => {
      this.controls[b.dataset.k!] = b;
    });
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
      <div class="bar hp"><div class="fill"></div><span class="bar-text"></span></div>
      <div class="bar charge"><div class="fill"></div></div>
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
      hpText: root.querySelector(".hp .bar-text")!,
      charge: root.querySelector(".charge .fill")!,
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

  ticker(text: string, cls = "") {
    const line = document.createElement("div");
    line.className = `line ${cls}`;
    line.textContent = text;
    this.tickerEl.appendChild(line);
    while (this.tickerEl.children.length > 7) this.tickerEl.firstElementChild?.remove();
    setTimeout(() => line.classList.add("fade"), 6000);
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
    this.matchEl.textContent = `MATCH ${world.matchNumber}`;
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
      c.hp.style.width = `${bot.hpFrac * 100}%`;
      c.hp.style.background = `hsl(${bot.hpFrac * 120}, 90%, 55%)`;
      c.hpText.textContent = bot.alive ? `${Math.ceil(bot.hp)} / ${bot.def.stats.hp}` : bot.eliminated === "pitted" ? "PITTED" : "DESTROYED";
      c.charge.style.width = `${bot.weaponCharge * 100}%`;
      c.charge.classList.toggle("ready", bot.weaponReady);
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
    const winner = r.winner ? world.bot(r.winner) : null;
    const rows = r.standings
      .map((s, i) => {
        const b = world.bot(s.id)!;
        const brain = [b.stats.jevDecisions > 0 ? "Jev" : "", b.stats.trainedDecisions > 0 ? "trained" : "", b.stats.decisions > b.stats.jevDecisions + b.stats.trainedDecisions ? "baseline" : ""].filter(Boolean).join(" + ") || "baseline";
        return `<tr class="${s.id === r.winner ? "win" : ""}"><td>${i + 1}</td><td style="color:#${b.def.color.toString(16).padStart(6, "0")}">${s.id}</td><td>${s.eliminated ? s.eliminated.toUpperCase() : s.hp + " hp"}</td><td>${s.damageDealt} dmg</td><td>${b.stats.hits} hits</td><td>${b.stats.decisions} decisions (${brain})</td></tr>`;
      })
      .join("");
    this.resultEl.innerHTML = `
      <div class="result-card">
        <div class="result-kicker">${r.reason === "judges" ? "JUDGES' DECISION" : r.reason === "draw" ? "DRAW" : "LAST BOT STANDING"}</div>
        <div class="result-winner" style="--c:#${(winner?.def.color ?? 0xffffff).toString(16).padStart(6, "0")}">${r.winner ?? "NOBODY"}</div>
        <div class="result-sub">${winner ? winner.def.tagline : ""} · ${world.fightTime.toFixed(0)}s</div>
        <table>${rows}</table>
        <div class="result-next">${secondsToNext !== null ? `Next match in ${Math.ceil(secondsToNext)}s` : "Press N for a new match"}</div>
      </div>`;
  }
  hideResult() {
    this.resultEl.classList.add("hidden");
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

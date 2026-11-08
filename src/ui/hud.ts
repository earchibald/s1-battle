import type { Maneuver } from "@shared/types";
import type { Brain, BrainMode } from "../brain/brains";
import { ARENA, pitCountdown, pitPhase, sawPhase } from "../sim/arena";
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

const WEAPON_ICON: Record<string, string> = {
  saw: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="6" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1" stroke="currentColor" stroke-width="2"/></svg>`,
  hammer: `<svg viewBox="0 0 24 24"><path d="M4 20l8-8" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/><rect x="11" y="3" width="10" height="7" rx="1.5" transform="rotate(45 16 6.5)" fill="currentColor"/></svg>`,
  grabber: `<svg viewBox="0 0 24 24"><path d="M6 4c-3 4-3 9 0 13M18 4c3 4 3 9 0 13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/><path d="M12 10v10" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>`,
  flipper: `<svg viewBox="0 0 24 24"><path d="M3 18h18" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/><path d="M4 16L20 8" stroke="currentColor" stroke-width="3" stroke-linecap="round"/><path d="M14 4l4 4-5 1" fill="currentColor"/></svg>`,
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

export class Hud {
  private cards = new Map<string, Card>();
  private cardsEl: HTMLElement;
  private tickerEl: HTMLElement;
  private clockEl: HTMLElement;
  private phaseEl: HTMLElement;
  private matchEl: HTMLElement;
  private hazardsEl: HTMLElement;
  private jevEl: HTMLElement;
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
      <div class="hud-jev" id="hud-jev"></div>
      <div class="hud-ticker" id="hud-ticker"></div>
      <div class="hud-controls" id="hud-controls">
        <button data-k="pause" title="Space">⏸ Pause</button>
        <div class="seg"><button data-k="s05">½×</button><button data-k="s1" class="on">1×</button><button data-k="s2">2×</button></div>
        <button data-k="cam" title="C">🎥 Auto cam</button>
        <button data-k="debug" title="D">◎ Debug</button>
        <div class="seg"><button data-k="alljev">All Jev</button><button data-k="allbase">All Baseline</button></div>
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
    this.controls.alljev.onclick = () => cb.setAllBrains("jev");
    this.controls.allbase.onclick = () => cb.setAllBrains("baseline");
    this.controls.new.onclick = () => cb.newMatch();
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
        <div class="card-title"><div class="card-name">${bot.id}</div><div class="card-weapon">${bot.def.weapon}</div></div>
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
      this.jevEl.innerHTML = `<div class="jev-title off">JEV OFFLINE</div><div class="jev-sub">No TYPESAFE_API_KEY on the server — all bots on baseline logic.</div>`;
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

  setControls(paused: boolean, speed: number, autoCam: boolean, debug: boolean) {
    this.controls.pause.textContent = paused ? "▶ Resume" : "⏸ Pause";
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
      <div class="hz saws-${saws}">SAWS ${saws === "up" ? "UP" : saws === "rising" ? "RISING" : "down"}</div>`;

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
        c.brain.textContent = brain.mode === "jev" ? "JEV" : "BASELINE";
        c.brain.className = `brain-toggle ${brain.mode}${brain.status.inFlight ? " busy" : ""}`;
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
      c.latency.textContent = it.source === "jev" ? `${it.latencyMs} ms` : it.source === "fallback" ? "fallback" : "scripted";
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
        const brain = b.stats.jevDecisions > 0 ? "Jev" : "baseline";
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

function statusLine(bot: Bot): string {
  if (!bot.alive) return bot.eliminated === "pitted" ? "fell into the pit" : "wrecked";
  if (bot.airborne) return "AIRBORNE";
  if (bot.heldBy) return `held by ${bot.heldBy.id}`;
  if (bot.stun > 0) return "stunned";
  if (bot.holding) return `holding ${bot.holding.id} (${Math.max(0, 3.6 - bot.weapon.holdTime).toFixed(1)}s)`;
  switch (bot.kind) {
    case "saw":
      return `blade ${(bot.weapon.spin * 100).toFixed(0)}%`;
    case "hammer":
      return bot.weapon.hammerPhase !== "idle" ? bot.weapon.hammerPhase : bot.weaponReady ? "hammer ready" : `recharging ${bot.weapon.cooldown.toFixed(1)}s`;
    case "grabber":
      return bot.weaponReady ? "jaws ready" : `recharging ${bot.weapon.cooldown.toFixed(1)}s`;
    case "flipper":
      return bot.weaponReady ? "flipper charged" : `recharging ${bot.weapon.cooldown.toFixed(1)}s`;
  }
}
export { ARENA };

import * as THREE from "three";
import { DEFAULT_ROSTER, stockBuild } from "@shared/bots/index";
import type { BotBuild } from "@shared/build";
import { cloneBuild, normalizeBuild } from "@shared/build";
import { defFromBuild } from "@shared/logic";
import { BRAIN_MODES, Brain, type BrainMode } from "./brain/brains";
import { TrainedNet, type ModelFile } from "./brain/trained/net";
import { BotMesh } from "./render/botMesh";
import { Effects } from "./render/effects";
import { ArenaScene, toWorld } from "./render/scene";
import type { SimEvent } from "./sim/events";
import { World } from "./sim/world";
import { commentate } from "./ui/commentary";
import { Hud, maneuverLabel, type JevInfo } from "./ui/hud";
import { Labels } from "./ui/labels";
import { Callouts } from "./ui/callouts";
import { CalloutDirector } from "./ui/calloutPolicy";
import { Designer, uniqueNamed } from "./ui/designer";
import { SoundEngine } from "./audio/sound";
import { SeasonMode } from "./season/seasonUi";
import { pitPhase, sawRaise } from "./sim/arena";
import { toggleFullscreen } from "./ui/fullscreen";
import type { HammerPhase } from "./sim/bot";
import type { BotKind, Maneuver } from "@shared/types";

/**
 * S1 Arena entry point. Fixed-step simulation, async brains, Three.js rendering, HTML HUD, and the Garage
 * (designer) overlay. Keyboard: Space pause · N new match · C camera · D debug · M mute · 1/2/3 speed ·
 * J/T/B all Jev/trained/baseline · G garage · S season · F fullscreen.
 */

const FIXED_DT = 1 / 60;
const DECISION_CADENCE = 0.45; // seconds between brain decisions per bot
const AUTO_NEXT_SECONDS = 9;

const canvas = document.getElementById("arena") as HTMLCanvasElement;
const scene = new ArenaScene(canvas);
const effects = new Effects();
scene.scene.add(effects.group);
const labels = new Labels(document.getElementById("labels")!, scene.camera);
const callouts = new Callouts(document.getElementById("callouts")!, scene.camera, () => world.bots.filter((b) => b.alive).map((b) => b.p));
/** Decides which few moments get a comic callout (eliminations, big crits, huge hits) and paces them. */
let director = new CalloutDirector();
const sound = new SoundEngine();
// Browsers gate audio behind a gesture; the first click or key anywhere unlocks it.
const unlock = () => sound.unlock();
window.addEventListener("pointerdown", unlock);
window.addEventListener("keydown", unlock);
/** Last time each saw bot's blade connected, for the whine's "biting" timbre. */
const lastBite = new Map<string, number>();
const lastHammerPhase = new Map<string, HammerPhase>();
const lastReady = new Map<string, boolean>();
/** Motor pitch per kind so the four hums don't stack into one drone. */
const MOTOR_PITCH: Record<BotKind, number> = { saw: 62, hammer: 44, grabber: 52, flipper: 70, spinner: 58, torch: 66, ram: 40 };
let lastCountdownTick = -1;

let paused = false;
let speed = 1;
let slowmo = 1;
let slowmoTimer = 0;
let debug = false;
let defaultMode: BrainMode = "jev";
let matchNumber = 1;
let endedAt: number | null = null;
let lineupRotation = 0;

let world!: World;
let meshes: BotMesh[] = [];
let brains = new Map<string, Brain>();
let debugLines: THREE.LineSegments | null = null;
/** Roster slot index -> bot id in the current match. */
let slotBots: string[] = [];

/* ---------------------------------------------------------------- roster / garage ---------------- */

const GARAGE_KEY = "s1.garage.v1";
function loadRoster(): BotBuild[] {
  const stock = DEFAULT_ROSTER.map((k, i) => ({ ...stockBuild(k), id: `slot-${i}` }));
  try {
    const raw = localStorage.getItem(GARAGE_KEY);
    if (!raw) return stock;
    const parsed = JSON.parse(raw) as { builds?: unknown[] };
    if (!Array.isArray(parsed.builds)) return stock;
    return stock.map((s, i) => (parsed.builds![i] ? normalizeBuild(parsed.builds![i], stockBuild, `slot-${i}`) : s));
  } catch {
    return stock;
  }
}
function saveRoster(builds: BotBuild[]) {
  try {
    localStorage.setItem(GARAGE_KEY, JSON.stringify({ version: 1, builds }));
  } catch {
    /* private mode etc.: the roster just lives for this session */
  }
}
const roster = loadRoster();

let toastEl: HTMLElement | null = null;
let toastTimer = 0;
function toast(text: string) {
  if (!toastEl) {
    toastEl = document.createElement("div");
    toastEl.className = "dz-toast";
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = text;
  toastEl.style.display = "";
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    if (toastEl) toastEl.style.display = "none";
  }, 3200);
}

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
/** Free view's controls aren't discoverable, so say them once each time it's switched on. */
function freeCamHint() {
  if (scene.autoCamera) return;
  const mod = IS_MAC ? "⌥/⌘/⇧" : "Alt/Ctrl/Shift";
  toast(`Free cam · drag to orbit · ${mod}-drag or right-drag to pan · scroll to zoom · C for auto`);
}

const designer = new Designer(document.getElementById("designer")!, roster, {
  deploy: () => {
    season.suspend(); // a Garage deploy is an exhibition match; the season stays saved
    startMatch();
    toast(`Deployed: ${roster.map((b) => b.name).join(" · ")}`);
  },
  applyLive(slot, build) {
    const bot = world?.bot(slotBots[slot]);
    if (!bot) return;
    // Brain-only changes: the running bot's def closes over its own build object, so copy into it.
    const copy = cloneBuild(build);
    bot.def.build.logic = copy.logic;
    bot.def.build.techniques = copy.techniques;
  },
  botForSlot: (slot) => world?.bot(slotBots[slot]),
  brainForSlot: (slot) => brains.get(slotBots[slot]),
  world: () => world,
  onChange: saveRoster,
  toast,
});

const hud = new Hud(document.getElementById("hud")!, {
  toggleBrain(id) {
    const b = brains.get(id);
    if (!b) return;
    b.mode = BRAIN_MODES[(BRAIN_MODES.indexOf(b.mode) + 1) % BRAIN_MODES.length];
    hud.ticker(`${id} switched to ${MODE_LABEL[b.mode]} brain`, MODE_CLS[b.mode], { cat: "match", bots: [id] });
  },
  setAllBrains(mode) {
    setAllBrains(mode);
  },
  newMatch: () => startMatch(),
  togglePause() {
    paused = !paused;
    syncControls();
  },
  setSpeed(x) {
    speed = x;
    syncControls();
  },
  toggleCamera() {
    scene.autoCamera = !scene.autoCamera;
    syncControls();
    freeCamHint();
  },
  toggleFullscreen,
  toggleDebug() {
    debug = !debug;
    if (debugLines) debugLines.visible = debug;
    syncControls();
  },
  toggleSound() {
    sound.unlock();
    sound.setMuted(!sound.muted);
    syncControls();
  },
  toggleDesigner() {
    sound.uiClick();
    designer.toggle();
  },
  toggleSeason() {
    sound.uiClick();
    season.toggle();
  },
});
/** Season arc (src/season/): while season.playing, startMatch runs its fixtures and match ends feed its table. */
const season = new SeasonMode({ roster, startMatch: () => startMatch(), ticker: (text, cls) => hud.ticker(text, cls), toast, click: () => sound.uiClick() });
const MODE_LABEL: Record<BrainMode, string> = { jev: "Jev", trained: "trained", baseline: "baseline" };
const MODE_CLS: Record<BrainMode, string> = { jev: "jev", trained: "net", baseline: "base" };
function setAllBrains(mode: BrainMode) {
  defaultMode = mode;
  for (const b of brains.values()) b.mode = mode;
  hud.ticker(`All bots now on ${MODE_LABEL[mode]} brains`, MODE_CLS[mode], { cat: "match", bots: [] });
}

/** The trained brain's weights are a static file; the arena runs fine (baseline) until or unless they load. */
async function loadTrained() {
  try {
    const res = await fetch("/models/trained-brain.json");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const net = new TrainedNet((await res.json()) as ModelFile);
    Brain.trainedNet = net;
    const info = net.file.info as { rows?: number; params?: number; datasets?: string[] } | undefined;
    hud.setTrained({
      loaded: true,
      detail: `${((info?.params ?? 0) / 1000).toFixed(0)}k weights · ${((info?.rows ?? 0) / 1000).toFixed(0)}k rollout-labeled moments · ${info?.datasets?.join(" + ") ?? ""}`,
    });
  } catch (err) {
    hud.setTrained({ loaded: false, detail: `No model (${err instanceof Error ? err.message : String(err)}). Train one: see docs/trained-brain.md.` });
  }
}

function syncControls() {
  hud.setControls(paused, speed, scene.autoCamera, debug, sound.muted);
}

function startMatch() {
  // Tear down the previous match's meshes.
  for (const m of meshes) scene.scene.remove(m.group);
  meshes = [];
  brains = new Map();
  endedAt = null;
  slowmo = 1;
  lastCountdownTick = -1;
  lastHammerPhase.clear();
  lastReady.clear();
  hud.hideResult();
  director = new CalloutDirector();
  callouts.clear();

  // Each slot gets its own copy of the build so garage edits only reach the arena on deploy (or live-apply).
  // In season mode the fixture names the four bots (already in start-corner order) and the seed.
  const fixture = season.fixture();
  const defs = fixture ? fixture.defs : roster.map((b) => defFromBuild(uniqueNamed(cloneBuild(b), roster)));
  // Rotate start corners each match so nobody always spawns next to the pit.
  const order = defs.map((_, i) => (i + (fixture ? 0 : lineupRotation)) % defs.length);
  const lineup = order.map((i) => defs[i]);
  if (!fixture) lineupRotation++;
  world = new World(lineup, fixture ? fixture.seed : Date.now() % 100000);
  world.matchNumber = matchNumber++;
  hud.setWorld(world);
  hud.matchLabel = fixture ? fixture.label.toUpperCase() : null;
  slotBots = [];
  // Garage slots map to arena bots only in exhibition; season bots are the season's frozen builds.
  if (!fixture) order.forEach((slot, pos) => (slotBots[slot] = world.bots[pos].id));
  for (const bot of world.bots) {
    const mesh = new BotMesh(bot);
    scene.scene.add(mesh.group);
    meshes.push(mesh);
    brains.set(bot.id, new Brain(bot, defaultMode, { cadence: DECISION_CADENCE, decideUrl: "/api/decide" }));
    labels.ensure(bot);
  }
  if (!debugLines) {
    debugLines = new THREE.LineSegments(
      new THREE.BufferGeometry().setAttribute("position", new THREE.BufferAttribute(new Float32Array(4 * 2 * 3), 3)),
      new THREE.LineBasicMaterial({ color: 0x6ee7ff, transparent: true, opacity: 0.6 }),
    );
    debugLines.visible = debug;
    scene.scene.add(debugLines);
  }
  hud.ticker(`${fixture ? fixture.label : `Match ${world.matchNumber}`}: ${lineup.map((d) => d.name).join(" · ")}`, "big");
  if (fixture?.hook) hud.ticker(fixture.hook, "season");
}

function handleEvent(e: SimEvent) {
  for (const b of brains.values()) b.nudge(e);
  const line = commentate(e, world);
  if (line) hud.ticker(line.text, line.cls);
  const callout = director.pick(e, world.fightTime);
  if (callout && (e.type === "hit" || e.type === "destroyed" || e.type === "pitted")) callouts.show(e.at, callout);
  season.onEvent(e, world);

  switch (e.type) {
    case "hit": {
      const at = toWorld(e.at, 0.5);
      const victim = world.bot(e.victim);
      const attacker = world.bot(e.attacker);
      const dir = victim && attacker ? toWorld(victim.p).sub(toWorld(attacker.p)).normalize() : new THREE.Vector3(0, 1, 0);
      const now = world.time;
      const crit = e.crit;
      const paint = victim?.def.color ?? 0x9aa0aa;
      if (e.weapon === "saw") {
        effects.sparkBurst(at, dir, 0.4 + e.power * 0.6, 0xffd36e);
        if (e.amount >= 12) effects.debris(at, dir, 2, paint, 0.7);
        sound.sawBite(e.power);
        lastBite.set(e.attacker, now);
      } else if (e.weapon === "hammer") {
        effects.sparkBurst(at, new THREE.Vector3(0, 1, 0), 1, 0xffffff);
        effects.ring(at, 0xff6a3d, 1.4);
        effects.debris(at, new THREE.Vector3(0, 0, 0), 6, paint);
        effects.scorch(at, 0.9, 0.45);
        scene.kick(0.9);
        triggerSlowmo(0.35, 0.45);
        sound.hammerStrike(true, crit);
      } else if (e.weapon === "flip") {
        effects.sparkBurst(at, new THREE.Vector3(0, 1, 0), 0.5, 0x9ad7ff);
        effects.ring(at, 0x6ee7ff, 1);
        scene.kick(0.4);
        sound.flip(true);
      } else if (e.weapon === "landing") {
        effects.sparkBurst(at, new THREE.Vector3(0, 1, 0), Math.min(1, e.amount / 15), 0xbbbbbb);
        effects.ring(at, 0xffffff, 0.9);
        scene.kick(0.5);
        sound.landing(e.power, crit);
      } else if (e.weapon === "wall") {
        effects.sparkBurst(at, dir.negate(), Math.min(1, e.amount / 12), 0xffaa66);
        scene.kick(0.25);
      } else if (e.weapon === "saws") {
        if (e.power > 0) {
          effects.sparkBurst(at, new THREE.Vector3(0, 1, 0), 0.5, 0xffc864);
          sound.sawsChew();
        }
      } else if (e.weapon === "crush") {
        effects.sparkBurst(at, new THREE.Vector3(0, 1, 0), crit ? 0.5 : 0.15, 0x2dd4bf);
        sound.crush();
      } else if (e.weapon === "spinner") {
        effects.sparkBurst(at, dir, 0.6 + e.power * 0.6, 0xd9b3ff);
        effects.ring(at, 0xb57bff, 0.9);
        effects.debris(at, dir, Math.round(3 + e.power * 4), paint);
        scene.kick(0.5);
        sound.spinnerHit(e.power, crit);
        lastBite.set(e.attacker, now);
      } else if (e.weapon === "torch") {
        // power 0.2 is a lingering burn tick; a direct flame hit is 0.6.
        if (e.power > 0.3) {
          effects.sparkBurst(at, new THREE.Vector3(0, 1, 0), 0.5, 0xff7a1a);
          sound.torchHit();
        } else effects.smokePuff(at, false);
      } else if (e.weapon === "ram") {
        effects.sparkBurst(at, dir, Math.min(1, e.amount / 14), 0xc8ffc0);
        effects.ring(at, 0x7cff6e, 1.1);
        if (e.amount >= 10) effects.debris(at, dir, Math.min(6, Math.round(e.amount / 4)), paint);
        scene.kick(0.6);
        sound.slam(e.power * 9, crit);
      } else if (e.weapon === "vent") {
        if (e.power > 0) {
          effects.sparkBurst(at, new THREE.Vector3(0, 1, 0), 0.5, 0xff7a1a);
          effects.embers(at, 6);
          effects.scorch(at, 0.7, 0.4);
        }
      } else if (e.weapon === "shock") {
        effects.sparkBurst(at, new THREE.Vector3(0, 1, 0), 0.9, 0x9fe8ff);
        effects.ring(at, 0x66ddff, 1.2);
        scene.kick(0.4);
      }
      if (crit) {
        // Crits get the full treatment: extra sparks, a chime, a camera kick, a beat of slow motion.
        effects.sparkBurst(at, new THREE.Vector3(0, 1, 0), 1, 0xfff1a8);
        effects.ring(at, 0xffd400, 1.6);
        effects.debris(at, dir, 5, paint);
        scene.kick(0.6);
        triggerSlowmo(0.45, 0.4);
        sound.crit();
      } else if (e.amount >= 20) sound.crowdReact(0.3);
      if (e.amount >= 2.5) labels.damage(e.at, e.amount, crit ? "big" : e.amount > 20 ? "big" : e.weapon === "saw" ? "saw" : e.weapon === "saws" || e.weapon === "shock" ? "hazard" : e.weapon === "torch" || e.weapon === "vent" ? "fire" : "");
      break;
    }
    case "strike":
      if (!e.landed) {
        effects.sparkBurst(toWorld(e.at, 0.1), new THREE.Vector3(0, 1, 0), 0.4, 0xffffff);
        effects.ring(toWorld(e.at), 0xffffff, 0.8);
        effects.scorch(toWorld(e.at), 0.55, 0.3); // the head leaves a dent in the floor
        scene.kick(0.35);
        sound.hammerStrike(false);
      }
      break;
    case "flip":
      effects.ring(toWorld(e.at), 0xff7a1a, 0.7);
      if (!e.victim) sound.flip(false);
      break;
    case "grab":
      effects.sparkBurst(toWorld(world.bot(e.victim)!.p, 0.6), new THREE.Vector3(0, 1, 0), 0.3, 0x2dd4bf);
      sound.grab();
      break;
    case "release":
      sound.release();
      break;
    case "wall":
      sound.wall(e.speed);
      break;
    case "boost":
      sound.boost();
      break;
    case "slam":
      if (e.speed < 2.4) sound.wall(e.speed);
      break;
    case "pit_open":
      sound.pitOpen();
      break;
    case "saws_rising":
      sound.sawsRising();
      break;
    // Traps: a cue when each one telegraphs and fires; the crowd only reacts when a bot is actually caught.
    case "vent_erupt":
      effects.sparkBurst(toWorld(e.at, 0.2), new THREE.Vector3(0, 1, 0), 0.7, 0xff7a1a);
      sound.ventErupt();
      break;
    case "pad_warning":
      sound.padCharge();
      break;
    case "pad_fire":
      effects.ring(toWorld(e.at, 0.1), 0xffd166, e.caught ? 1.6 : 1);
      if (e.caught) scene.kick(0.5);
      sound.padFire(e.caught > 0);
      break;
    case "shock_warning":
      sound.shockCharge();
      break;
    case "shock_fire":
      effects.ring(toWorld(e.at, 0.1), 0x66ddff, e.caught ? 1.8 : 1.2);
      sound.shockFire(e.caught > 0);
      break;
    case "trapped":
      sound.crowdReact(e.by ? 0.6 : 0.35);
      break;
    case "match_start":
      sound.countdownBeep(true);
      break;
    case "destroyed": {
      const at = toWorld(e.at, 0.5);
      effects.sparkBurst(at, new THREE.Vector3(0, 1, 0), 1, 0xff8844);
      effects.sparkBurst(at, new THREE.Vector3(0, 1, 0), 1, 0xffffff);
      effects.ring(at, 0xff4422, 2.2);
      effects.debris(at, new THREE.Vector3(0, 0, 0), 18, world.bot(e.bot)?.def.color ?? 0x9aa0aa, 1.3);
      effects.scorch(at, 2.0, 0.8);
      effects.embers(at, 30);
      for (let i = 0; i < 12; i++) effects.smokePuff(at, true);
      scene.kick(1.1);
      triggerSlowmo(0.25, 1.3);
      sound.destroyed();
      break;
    }
    case "pitted": {
      const at = toWorld(e.at, 0.2);
      effects.ring(at, 0xff2a1a, 1.8);
      for (let i = 0; i < 6; i++) effects.smokePuff(at, false);
      scene.kick(0.6);
      triggerSlowmo(0.3, 1.2);
      sound.pitted();
      break;
    }
    case "decision": {
      const bot = world.bot(e.bot);
      if (bot) {
        const it = bot.intent;
        const said = `${maneuverLabel(it.maneuver)}${it.target ? " → " + it.target : ""}`;
        labels.say(e.bot, said, e.source, world.time);
        // The note already carries the brain's own summary; add only what it leaves out.
        const alts = Object.entries(it.probabilities)
          .filter(([m, p]) => m !== it.maneuver && p >= 0.05)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 2)
          .map(([m, p]) => `${maneuverLabel(m as Maneuver)} ${(p * 100).toFixed(0)}%`);
        const extra = [
          alts.length ? `also ${alts.join(", ")}` : "",
          /danger/.test(e.note) ? "" : `danger ${(it.danger * 100).toFixed(0)}%`,
          e.source === "jev" ? `${it.latencyMs} ms` : "",
        ].filter(Boolean);
        hud.thought(e.bot, said, extra.length ? `${e.note} · ${extra.join(" · ")}` : e.note, e.source);
      }
      break;
    }
    case "match_end":
      endedAt = performance.now();
      triggerSlowmo(0.4, 1.5);
      sound.matchEnd();
      break;
  }
}

/** Continuous sounds and phase-transition cues that have no discrete sim event. */
function updateAudio() {
  const fighting = world.phase === "fighting";
  for (const b of world.bots) {
    const drive = paused || !fighting ? 0 : Math.min(1, Math.hypot(b.vel.x, b.vel.y) / b.def.stats.maxSpeed) * 0.7 + Math.abs(b.throttle) * 0.3;
    const boostPitch = b.kind === "ram" && b.weapon.boosting ? 1.6 : 1;
    sound.updateMotor(b.id, b.controllable ? Math.min(1, drive * boostPitch) : 0, b.alive, MOTOR_PITCH[b.kind] * boostPitch);
    if ((b.kind === "hammer" || b.kind === "grabber" || b.kind === "flipper" || b.kind === "ram") && fighting) {
      const prev = lastReady.get(b.id);
      if (prev === false && b.weaponReady && b.alive) sound.recharged(b.kind);
      lastReady.set(b.id, b.weaponReady);
    }
    if (b.kind === "saw" || b.kind === "spinner") {
      const biting = world.time - (lastBite.get(b.id) ?? -10) < 0.2;
      sound.updateSaw(b.id, paused ? 0 : b.weapon.spin, b.alive && world.phase !== "ended", biting, b.kind === "spinner" ? 0.55 : 1);
    }
    if (b.kind === "torch") sound.updateTorch(b.id, b.weapon.firing && fighting && !paused, b.alive);
    if (b.kind === "hammer") {
      const prev = lastHammerPhase.get(b.id);
      if (prev !== b.weapon.hammerPhase) {
        if (b.weapon.hammerPhase === "windup") sound.hammerWindup();
        lastHammerPhase.set(b.id, b.weapon.hammerPhase);
      }
    }
  }
  sound.updateGrind(fighting && !paused ? sawRaise(world.fightTime) : 0);
  sound.updateAlarm(fighting && pitPhase(world.fightTime) === "warning");
  if (world.phase === "countdown") {
    const tick = Math.ceil(world.countdown);
    if (tick !== lastCountdownTick && tick > 0) {
      lastCountdownTick = tick;
      sound.countdownBeep(false);
    }
  }
}

function triggerSlowmo(factor: number, seconds: number) {
  slowmo = Math.min(slowmo, factor);
  slowmoTimer = Math.max(slowmoTimer, seconds);
}

function updateDebug() {
  if (!debugLines || !debug) return;
  const arr = debugLines.geometry.attributes.position.array as Float32Array;
  world.bots.forEach((b, i) => {
    const a = toWorld(b.p, 0.1);
    const t = b.navTarget && b.alive ? toWorld(b.navTarget, 0.1) : a;
    arr.set([a.x, a.y, a.z, t.x, t.y, t.z], i * 6);
  });
  debugLines.geometry.attributes.position.needsUpdate = true;
}

// Jev health + stats polling
async function pollJev() {
  try {
    const h = (await (await fetch("/api/health")).json()) as { jev: boolean; model: string };
    Brain.jevAvailable = h.jev;
    const info: JevInfo = { configured: h.jev, model: h.model };
    if (h.jev) {
      const s = (await (await fetch("/api/stats")).json()) as Partial<JevInfo>;
      Object.assign(info, s);
    }
    hud.setJev(info);
  } catch {
    Brain.jevAvailable = false;
    hud.setJev({ configured: false, model: "server unreachable" });
  }
}

window.addEventListener("keydown", (ev) => {
  const t = ev.target;
  if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return;
  if (designer.open) {
    if (ev.key === "Escape" || ev.key === "g" || ev.key === "G") designer.hide();
    return;
  }
  if (season.open) {
    if (ev.key === "Escape" || ev.key === "s" || ev.key === "S") season.hide();
    return;
  }
  switch (ev.key) {
    case "l":
    case "L":
      hud.log.toggle();
      return;
    case "/":
      ev.preventDefault();
      hud.log.focusSearch();
      return;
    case "Escape":
      hud.log.setOpen(false);
      return;
    case "g":
    case "G":
      designer.show();
      break;
    case "s":
    case "S":
      season.show();
      break;
    case " ":
      ev.preventDefault();
      paused = !paused;
      break;
    case "n":
    case "N":
      startMatch();
      break;
    case "c":
    case "C":
      scene.autoCamera = !scene.autoCamera;
      freeCamHint();
      break;
    case "f":
    case "F":
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return; // leave browser shortcuts (⌘F find) alone
      toggleFullscreen();
      break;
    case "d":
    case "D":
      debug = !debug;
      if (debugLines) debugLines.visible = debug;
      break;
    case "1":
      speed = 0.5;
      break;
    case "2":
      speed = 1;
      break;
    case "3":
      speed = 2;
      break;
    case "j":
    case "J":
      setAllBrains("jev");
      break;
    case "t":
    case "T":
      setAllBrains("trained");
      break;
    case "b":
    case "B":
      setAllBrains("baseline");
      break;
    case "m":
    case "M":
      sound.setMuted(!sound.muted);
      break;
  }
  syncControls();
});

// Main loop
let last = performance.now();
let acc = 0;
let renderTime = 0;
function frame(now: number) {
  requestAnimationFrame(frame);
  const realDt = Math.min(0.1, (now - last) / 1000);
  last = now;
  renderTime += realDt;

  if (slowmoTimer > 0) {
    slowmoTimer -= realDt;
    if (slowmoTimer <= 0) slowmo = 1;
  }
  const simScale = paused ? 0 : speed * slowmo;
  acc += realDt * simScale;
  let steps = 0;
  while (acc >= FIXED_DT && steps < 6) {
    world.step(FIXED_DT);
    for (const b of brains.values()) b.update(world, FIXED_DT, handleEvent);
    for (const e of world.drainEvents()) handleEvent(e);
    acc -= FIXED_DT;
    steps++;
  }
  if (steps === 6) acc = 0;

  // Render side
  const dtScaled = realDt * simScale;
  scene.updateArena(world.fightTime, dtScaled);
  for (const m of meshes) m.update(dtScaled, world.time, (p, heavy) => effects.smokePuff(p, heavy), (p, n) => effects.embers(p, n));
  effects.update(dtScaled);
  const alive = world.alive;
  const focus = (alive.length ? alive : world.bots).map((b) => b.p);
  const aggression = alive.length <= 2 ? 1 : 0;
  scene.updateCamera(focus, realDt, aggression);
  labels.update(world.bots, realDt, world.time);
  callouts.update(realDt);
  updateAudio();
  updateDebug();
  designer.tick(realDt);
  hud.update(world, brains);
  // Season fixtures do not auto-advance: the season screen takes over after the match (see SeasonMode.onEvent).
  if (world.phase === "ended" && endedAt !== null && !season.playing) {
    const elapsed = (performance.now() - endedAt) / 1000;
    hud.showResult(world, AUTO_NEXT_SECONDS - elapsed);
    if (elapsed >= AUTO_NEXT_SECONDS) startMatch();
  }
  scene.render();
}

startMatch();
syncControls();
// Debug handle for the console: window.__s1.world, .sound, .brains
Object.assign(window as unknown as Record<string, unknown>, {
  __s1: { get world() { return world; }, get brains() { return brains; }, sound, scene, effects, designer, roster, season },
});
void loadTrained();
void pollJev();
setInterval(() => void pollJev(), 2500);
requestAnimationFrame(frame);

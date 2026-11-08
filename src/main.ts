import * as THREE from "three";
import { BOT_DEFS } from "@shared/bots/index";
import { Brain, type BrainMode } from "./brain/brains";
import { BotMesh } from "./render/botMesh";
import { Effects } from "./render/effects";
import { ArenaScene, toWorld } from "./render/scene";
import type { SimEvent } from "./sim/events";
import { World } from "./sim/world";
import { commentate } from "./ui/commentary";
import { Hud, maneuverLabel, type JevInfo } from "./ui/hud";
import { Labels } from "./ui/labels";
import { Callouts } from "./ui/callouts";
import { SoundEngine } from "./audio/sound";
import { pitPhase, sawRaise } from "./sim/arena";
import type { HammerPhase } from "./sim/bot";

/**
 * S1 Arena entry point. Fixed-step simulation, async brains, Three.js rendering, HTML HUD.
 * Keyboard: Space pause · N new match · C camera · D debug · M mute · 1/2/3 speed · J/B all Jev/baseline.
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
const MOTOR_PITCH = { saw: 62, hammer: 44, grabber: 52, flipper: 70 } as const;
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

const hud = new Hud(document.getElementById("hud")!, {
  toggleBrain(id) {
    const b = brains.get(id);
    if (!b) return;
    b.mode = b.mode === "jev" ? "baseline" : "jev";
    hud.ticker(`${id} switched to ${b.mode === "jev" ? "Jev" : "baseline"} brain`, b.mode === "jev" ? "jev" : "base");
  },
  setAllBrains(mode) {
    defaultMode = mode;
    for (const b of brains.values()) b.mode = mode;
    hud.ticker(`All bots now on ${mode === "jev" ? "Jev" : "baseline"} brains`, mode === "jev" ? "jev" : "base");
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
  },
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
});
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

  // Rotate start corners each match so nobody always spawns next to the pit.
  const defs = Object.values(BOT_DEFS);
  const lineup = defs.map((_, i) => defs[(i + lineupRotation) % defs.length]);
  lineupRotation++;
  world = new World(lineup, Date.now() % 100000);
  world.matchNumber = matchNumber++;
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
  hud.ticker(`Match ${world.matchNumber}: ${lineup.map((d) => d.name).join(" · ")}`, "big");
}

function handleEvent(e: SimEvent) {
  for (const b of brains.values()) b.nudge(e);
  const line = commentate(e, world);
  if (line) hud.ticker(line.text, line.cls);

  switch (e.type) {
    case "hit": {
      const at = toWorld(e.at, 0.5);
      const victim = world.bot(e.victim);
      const attacker = world.bot(e.attacker);
      const dir = victim && attacker ? toWorld(victim.p).sub(toWorld(attacker.p)).normalize() : new THREE.Vector3(0, 1, 0);
      const now = world.time;
      const crit = e.crit;
      let shout = false;
      if (e.weapon === "saw") {
        effects.sparkBurst(at, dir, 0.4 + e.power * 0.6, 0xffd36e);
        sound.sawBite(e.power);
        lastBite.set(e.attacker, now);
        shout = e.amount >= 22 || crit;
      } else if (e.weapon === "hammer") {
        effects.sparkBurst(at, new THREE.Vector3(0, 1, 0), 1, 0xffffff);
        effects.ring(at, 0xff6a3d, 1.4);
        scene.kick(0.9);
        triggerSlowmo(0.35, 0.45);
        sound.hammerStrike(true, crit);
        shout = true;
      } else if (e.weapon === "flip") {
        effects.sparkBurst(at, new THREE.Vector3(0, 1, 0), 0.5, 0x9ad7ff);
        effects.ring(at, 0x6ee7ff, 1);
        scene.kick(0.4);
        sound.flip(true);
        shout = true;
      } else if (e.weapon === "landing") {
        effects.sparkBurst(at, new THREE.Vector3(0, 1, 0), Math.min(1, e.amount / 15), 0xbbbbbb);
        effects.ring(at, 0xffffff, 0.9);
        scene.kick(0.5);
        sound.landing(e.power, crit);
        shout = e.amount >= 14 || crit;
      } else if (e.weapon === "wall") {
        effects.sparkBurst(at, dir.negate(), Math.min(1, e.amount / 12), 0xffaa66);
        scene.kick(0.25);
        shout = e.amount >= 14 || crit;
      } else if (e.weapon === "saws") {
        if (e.power > 0) {
          effects.sparkBurst(at, new THREE.Vector3(0, 1, 0), 0.5, 0xffc864);
          sound.sawsChew();
        }
      } else if (e.weapon === "crush") {
        effects.sparkBurst(at, new THREE.Vector3(0, 1, 0), crit ? 0.5 : 0.15, 0x2dd4bf);
        sound.crush();
        shout = crit && Math.random() < 0.3;
      }
      if (crit) {
        // Crits get the full treatment: extra sparks, a chime, a camera kick, a beat of slow motion.
        effects.sparkBurst(at, new THREE.Vector3(0, 1, 0), 1, 0xfff1a8);
        effects.ring(at, 0xffd400, 1.6);
        scene.kick(0.6);
        triggerSlowmo(0.45, 0.4);
        sound.crit();
      } else if (e.amount >= 20) sound.crowdReact(0.3);
      if (shout) callouts.show(e.at, e.weapon, { size: crit ? 1.6 : e.amount >= 30 ? 1.4 : 1, crit, now });
      if (e.amount >= 2.5) labels.damage(e.at, e.amount, crit ? "big" : e.amount > 20 ? "big" : e.weapon === "saw" ? "saw" : e.weapon === "saws" ? "hazard" : "");
      break;
    }
    case "strike":
      if (!e.landed) {
        effects.sparkBurst(toWorld(e.at, 0.1), new THREE.Vector3(0, 1, 0), 0.4, 0xffffff);
        effects.ring(toWorld(e.at), 0xffffff, 0.8);
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
    case "pit_open":
      sound.pitOpen();
      break;
    case "saws_rising":
      sound.sawsRising();
      break;
    case "match_start":
      sound.countdownBeep(true);
      break;
    case "destroyed": {
      const at = toWorld(e.at, 0.5);
      effects.sparkBurst(at, new THREE.Vector3(0, 1, 0), 1, 0xff8844);
      effects.sparkBurst(at, new THREE.Vector3(0, 1, 0), 1, 0xffffff);
      effects.ring(at, 0xff4422, 2.2);
      for (let i = 0; i < 12; i++) effects.smokePuff(at, true);
      scene.kick(1.1);
      triggerSlowmo(0.25, 1.3);
      sound.destroyed();
      callouts.show(e.at, "destroyed", { size: 2, now: world.time });
      break;
    }
    case "pitted": {
      const at = toWorld(e.at, 0.2);
      effects.ring(at, 0xff2a1a, 1.8);
      for (let i = 0; i < 6; i++) effects.smokePuff(at, false);
      scene.kick(0.6);
      triggerSlowmo(0.3, 1.2);
      sound.pitted();
      callouts.show(e.at, "pitted", { size: 1.6, now: world.time });
      break;
    }
    case "decision": {
      const bot = world.bot(e.bot);
      if (bot) labels.say(e.bot, `${maneuverLabel(bot.intent.maneuver)}${bot.intent.target ? " → " + bot.intent.target : ""}`, e.source, world.time);
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
    sound.updateMotor(b.id, b.controllable ? drive : 0, b.alive, MOTOR_PITCH[b.kind]);
    if (b.kind !== "saw" && fighting) {
      const prev = lastReady.get(b.id);
      if (prev === false && b.weaponReady && b.alive) sound.recharged(b.kind);
      lastReady.set(b.id, b.weaponReady);
    }
    if (b.kind === "saw") {
      const biting = world.time - (lastBite.get(b.id) ?? -10) < 0.2;
      sound.updateSaw(b.id, paused ? 0 : b.weapon.spin, b.alive && world.phase !== "ended", biting);
    }
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
    } else if (defaultMode === "jev") {
      defaultMode = "baseline";
      for (const b of brains.values()) b.mode = "baseline";
    }
    hud.setJev(info);
  } catch {
    Brain.jevAvailable = false;
    hud.setJev({ configured: false, model: "server unreachable" });
  }
}

window.addEventListener("keydown", (ev) => {
  if (ev.target instanceof HTMLInputElement) return;
  switch (ev.key) {
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
      defaultMode = "jev";
      for (const b of brains.values()) b.mode = "jev";
      break;
    case "b":
    case "B":
      defaultMode = "baseline";
      for (const b of brains.values()) b.mode = "baseline";
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
  for (const m of meshes) m.update(dtScaled, world.time, (p, heavy) => effects.smokePuff(p, heavy));
  effects.update(dtScaled);
  const alive = world.alive;
  const focus = (alive.length ? alive : world.bots).map((b) => b.p);
  const aggression = alive.length <= 2 ? 1 : 0;
  scene.updateCamera(focus, realDt, aggression);
  labels.update(world.bots, realDt, world.time);
  callouts.update(realDt);
  updateAudio();
  updateDebug();
  hud.update(world, brains);
  if (world.phase === "ended" && endedAt !== null) {
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
  __s1: { get world() { return world; }, get brains() { return brains; }, sound, scene, effects },
});
void pollJev();
setInterval(() => void pollJev(), 2500);
requestAnimationFrame(frame);

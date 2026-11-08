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

/**
 * S1 Arena entry point. Fixed-step simulation, async brains, Three.js rendering, HTML HUD.
 * Keyboard: Space pause · N new match · C camera · D debug · 1/2/3 speed · J/B all Jev/baseline.
 */

const FIXED_DT = 1 / 60;
const DECISION_CADENCE = 0.45; // seconds between brain decisions per bot
const AUTO_NEXT_SECONDS = 9;

const canvas = document.getElementById("arena") as HTMLCanvasElement;
const scene = new ArenaScene(canvas);
const effects = new Effects();
scene.scene.add(effects.group);
const labels = new Labels(document.getElementById("labels")!, scene.camera);

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
    hud.setControls(paused, speed, scene.autoCamera, debug);
  },
  setSpeed(x) {
    speed = x;
    hud.setControls(paused, speed, scene.autoCamera, debug);
  },
  toggleCamera() {
    scene.autoCamera = !scene.autoCamera;
    hud.setControls(paused, speed, scene.autoCamera, debug);
  },
  toggleDebug() {
    debug = !debug;
    if (debugLines) debugLines.visible = debug;
    hud.setControls(paused, speed, scene.autoCamera, debug);
  },
});

function startMatch() {
  // Tear down the previous match's meshes.
  for (const m of meshes) scene.scene.remove(m.group);
  meshes = [];
  brains = new Map();
  endedAt = null;
  slowmo = 1;
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
      if (e.weapon === "saw") effects.sparkBurst(at, dir, 0.4 + e.power * 0.6, 0xffd36e);
      else if (e.weapon === "hammer") {
        effects.sparkBurst(at, new THREE.Vector3(0, 1, 0), 1, 0xffffff);
        effects.ring(at, 0xff6a3d, 1.4);
        scene.kick(0.9);
        triggerSlowmo(0.35, 0.45);
      } else if (e.weapon === "flip") {
        effects.sparkBurst(at, new THREE.Vector3(0, 1, 0), 0.5, 0x9ad7ff);
        effects.ring(at, 0x6ee7ff, 1);
        scene.kick(0.4);
      } else if (e.weapon === "landing") {
        effects.sparkBurst(at, new THREE.Vector3(0, 1, 0), Math.min(1, e.amount / 15), 0xbbbbbb);
        effects.ring(at, 0xffffff, 0.9);
        scene.kick(0.5);
      } else if (e.weapon === "wall") {
        effects.sparkBurst(at, dir.negate(), Math.min(1, e.amount / 12), 0xffaa66);
        scene.kick(0.25);
      } else if (e.weapon === "saws") {
        if (e.power > 0) effects.sparkBurst(at, new THREE.Vector3(0, 1, 0), 0.5, 0xffc864);
      } else if (e.weapon === "crush") {
        effects.sparkBurst(at, new THREE.Vector3(0, 1, 0), 0.15, 0x2dd4bf);
      }
      if (e.amount >= 2.5) labels.damage(e.at, e.amount, e.amount > 20 ? "big" : e.weapon === "saw" ? "saw" : e.weapon === "saws" ? "hazard" : "");
      break;
    }
    case "strike":
      if (!e.landed) {
        effects.sparkBurst(toWorld(e.at, 0.1), new THREE.Vector3(0, 1, 0), 0.4, 0xffffff);
        effects.ring(toWorld(e.at), 0xffffff, 0.8);
        scene.kick(0.35);
      }
      break;
    case "flip":
      effects.ring(toWorld(e.at), 0xff7a1a, 0.7);
      break;
    case "grab":
      effects.sparkBurst(toWorld(world.bot(e.victim)!.p, 0.6), new THREE.Vector3(0, 1, 0), 0.3, 0x2dd4bf);
      break;
    case "destroyed": {
      const at = toWorld(e.at, 0.5);
      effects.sparkBurst(at, new THREE.Vector3(0, 1, 0), 1, 0xff8844);
      effects.sparkBurst(at, new THREE.Vector3(0, 1, 0), 1, 0xffffff);
      effects.ring(at, 0xff4422, 2.2);
      for (let i = 0; i < 12; i++) effects.smokePuff(at, true);
      scene.kick(1.1);
      triggerSlowmo(0.25, 1.3);
      break;
    }
    case "pitted": {
      const at = toWorld(e.at, 0.2);
      effects.ring(at, 0xff2a1a, 1.8);
      for (let i = 0; i < 6; i++) effects.smokePuff(at, false);
      scene.kick(0.6);
      triggerSlowmo(0.3, 1.2);
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
      break;
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
  }
  hud.setControls(paused, speed, scene.autoCamera, debug);
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
hud.setControls(paused, speed, scene.autoCamera, debug);
void pollJev();
setInterval(() => void pollJev(), 2500);
requestAnimationFrame(frame);

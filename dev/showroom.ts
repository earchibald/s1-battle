import { BOT_DEFS, STOCK_ORDER } from "@shared/bots/index";
import type { BotKind } from "@shared/types";
import { BotMesh } from "../src/render/botMesh";
import { Effects } from "../src/render/effects";
import { ArenaScene } from "../src/render/scene";
import { World } from "../src/sim/world";
import { Labels } from "../src/ui/labels";

/**
 * Dev-only art showroom (not part of the build): every bot kind parked in a row under the real arena
 * lighting, cycling its weapon through idle → wind-up → fire → recover, so models, articulation and
 * lighting states can be checked up close. Open /dev/showroom.html on the vite dev server.
 *
 * Query params: kinds=saw,hammer · t=<seconds> (freeze the demo clock; the cycle is 3 s) · view=row|close|arena · heading=<rad>
 *               hurt=0..1 (HP fraction) · burn=1 · dead=1 · fight=<seconds> (arena clock: pit/saws/traps)
 */
const q = new URLSearchParams(location.search);
const kinds = (q.get("kinds")?.split(",") as BotKind[] | undefined) ?? STOCK_ORDER;
const frozen = q.has("t") ? Number(q.get("t")) : null;
const view = q.get("view") ?? "row";
const hurt = q.has("hurt") ? Number(q.get("hurt")) : 1;
const fight = q.has("fight") ? Number(q.get("fight")) : 5;

const scene = new ArenaScene(document.getElementById("arena") as HTMLCanvasElement);
const effects = new Effects();
scene.scene.add(effects.group);
const world = new World(kinds.map((k) => BOT_DEFS[k]), 1);
const labels = new Labels(document.getElementById("labels")!, scene.camera);
const spacing = 2.6;
const meshes = world.bots.map((b, i) => {
  b.p = { x: (i - (kinds.length - 1) / 2) * spacing, y: -1.5 };
  b.heading = q.has("heading") ? Number(q.get("heading")) : -Math.PI / 2 + 0.6; // default: three-quarter view toward the camera; 0 = side profile
  b.hp = b.def.stats.hp * hurt;
  if (q.has("burn")) b.burn = 99;
  if (q.has("dead")) {
    b.alive = false;
    b.eliminated = "destroyed";
  }
  const m = new BotMesh(b);
  scene.scene.add(m.group);
  labels.ensure(b);
  return m;
});
scene.autoCamera = false;
if (view === "row") {
  scene.camera.position.set(0, 4.2, 7.5);
  scene.controls.target.set(0, 0.6, 1.5);
} else if (view === "close") {
  scene.camera.position.set(0, 2.4, 4.6);
  scene.controls.target.set(0, 0.5, 1.5);
} else {
  scene.autoCamera = true;
}
scene.controls.update();

/** A repeating 3 s weapon cycle per kind, so every rig shows its whole range of motion. */
function demo(t: number) {
  const ph = t % 3;
  for (const b of world.bots) {
    const w = b.weapon;
    const speed = Math.max(0, Math.sin(t * 0.9)) * b.def.stats.maxSpeed * 0.6;
    b.vel = { x: Math.cos(b.heading) * speed, y: Math.sin(b.heading) * speed };
    b.throttle = speed > 0.1 ? 1 : 0;
    b.steer = Math.sin(t * 0.5) * 0.6;
    w.spin = Math.min(1, ph / 1.2);
    w.firing = ph > 1 && ph < 2.4;
    w.boosting = ph > 1.2 && ph < 2;
    w.cooldown = ph > 2 ? 3 - ph : 0;
    w.cooldownMax = 1;
    w.hammerPhase = ph < 1 ? "idle" : ph < 1.28 ? "windup" : ph < 1.4 ? "strike" : ph < 1.8 ? "recover" : "idle";
    w.timer = w.hammerPhase === "windup" ? 1.28 - ph : w.hammerPhase === "recover" ? 1.8 - ph : 0.1;
    w.flipAnim = ph > 1 && ph < 1.6 ? 1 - (ph - 1) / 0.6 : 0;
    b.holding = b.kind === "grabber" && ph > 1 && ph < 2.5 ? world.bots[0] : null;
  }
}

let last = performance.now();
let clock = 0;
function frame(now: number) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  clock += dt;
  const t = frozen ?? clock;
  demo(t);
  world.time = t;
  scene.updateArena(fight, dt);
  // A frozen clock still needs a few frames of easing for the rigs to settle into their pose.
  for (const m of meshes) m.update(frozen !== null ? 0.5 : dt, t, (p, heavy) => effects.smokePuff(p, heavy), (p, n) => effects.embers(p, n));
  effects.update(dt);
  scene.updateCamera(world.bots.map((b) => b.p), dt);
  labels.update(world.bots, dt, t);
  scene.render();
}
requestAnimationFrame(frame);
Object.assign(window as unknown as Record<string, unknown>, { __show: { scene, world, meshes, effects } });

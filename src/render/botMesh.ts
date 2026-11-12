import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { Bot } from "../sim/bot";
import { toWorld } from "./scene";

/**
 * Procedural robot models. Every bot shares a sprung chassis, spoked wheels and a lighting kit, and each kind
 * gets a mechanically honest weapon rig that animates from the simulation's weapon state. The build shows on the
 * body: armor level adds side plates, motor level grows the wheels, weapon power scales the rig, frame level
 * scales the chassis (which must match the collision footprint in shared/build.ts, so chassis blocks keep their
 * old dimensions; detail is added on and around them).
 *
 * Articulation
 *   chassis   – springs: squats on acceleration, dives on braking, rolls out of turns, jolts on hits, compresses on landing
 *   wheels    – differential drive: each side turns at its own speed, so pivots read as pivots
 *   hydraulics – pistons (barrel + chrome rod) re-aim and extend every frame between chassis and the moving part
 *   saw       – disc spins with `weapon.spin`, a motion-blur ring fades in as it spools, belt pulley turns with it
 *   hammer    – sprung arm: anticipation on wind-up, overshoot and bounce on the strike, chassis kicks back
 *   grabber   – jaws on hydraulic rams; a two-joint crushing arm reaches down and pumps while holding
 *   flipper   – plate on twin rams with an overshoot; a vent puffs on every fire
 *   spinner   – bar with a blur disc; the body leans gyroscopically when it turns at speed
 *   torch     – pilot light, layered flame, nozzle heats up while firing
 *   ram       – plow shoves forward on hydraulic arms during boost, stacks spit flame
 *
 * Lighting
 *   team underglow + facing chevron on the floor; team-colored visor strip and headlights up front;
 *   a 4-segment LED bar on the back shows weapon charge (spin-up, recharge, fuel or boost) and flares when ready;
 *   hits flash the paint white-hot and jolt the chassis; damage scorches the paint and makes the lights stutter;
 *   destroyed bots go dark apart from dying sputters; burning bots glow orange.
 */

/* ---------------------------------------------------------------- shared materials and textures ---------------- */

function treadTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 16;
  const g = c.getContext("2d")!;
  g.fillStyle = "#26272c";
  g.fillRect(0, 0, 256, 16);
  g.fillStyle = "#0b0b0d";
  for (let x = 0; x < 256; x += 16) g.fillRect(x, 0, 7, 16);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Soft round glow: white center fading to nothing. Tinted per use. */
function glowTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.35, "rgba(255,255,255,0.55)");
  grad.addColorStop(0.7, "rgba(255,255,255,0.12)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

/** Motion-blur disc for spinning weapons: clear hub, a bright band where the tips sweep, faint concentric streaks. */
function blurTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grad.addColorStop(0, "rgba(255,255,255,0)");
  grad.addColorStop(0.45, "rgba(255,255,255,0.05)");
  grad.addColorStop(0.8, "rgba(255,255,255,0.35)");
  grad.addColorStop(0.93, "rgba(255,255,255,0.9)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  g.strokeStyle = "rgba(255,255,255,0.18)";
  for (let r = 40; r < 120; r += 9) {
    g.lineWidth = 1 + (r % 3);
    g.beginPath();
    g.arc(128, 128, r, 0, Math.PI * 2);
    g.stroke();
  }
  return new THREE.CanvasTexture(c);
}

/**
 * Flame body for a cone whose apex is at the nozzle: bright at the apex (canvas top, v=1), thinning to nothing at
 * the far end, with ragged streaks so it reads as fire rather than a beam.
 */
function flameTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 256;
  const g = c.getContext("2d")!;
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.35, "rgba(255,255,255,0.75)");
  grad.addColorStop(0.75, "rgba(255,255,255,0.25)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 256);
  g.globalCompositeOperation = "destination-out";
  for (let i = 0; i < 26; i++) {
    const x = Math.random() * 128;
    const y0 = 40 + Math.random() * 120;
    const streak = g.createLinearGradient(0, y0, 0, 256);
    streak.addColorStop(0, "rgba(0,0,0,0)");
    streak.addColorStop(1, `rgba(0,0,0,${0.4 + Math.random() * 0.5})`);
    g.fillStyle = streak;
    g.fillRect(x, y0, 3 + Math.random() * 9, 256 - y0);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  return t;
}

let shared: {
  tire: THREE.MeshStandardMaterial;
  rim: THREE.MeshStandardMaterial;
  steel: THREE.MeshStandardMaterial;
  dark: THREE.MeshStandardMaterial;
  chrome: THREE.MeshStandardMaterial;
  rubber: THREE.MeshStandardMaterial;
  glow: THREE.Texture;
  blur: THREE.Texture;
  flame: THREE.Texture;
} | null = null;
function S() {
  if (!shared) {
    shared = {
      tire: new THREE.MeshStandardMaterial({ map: treadTexture(), roughness: 0.92, metalness: 0.0 }),
      rim: new THREE.MeshStandardMaterial({ color: 0x2c3038, roughness: 0.4, metalness: 0.9 }),
      steel: new THREE.MeshStandardMaterial({ color: 0xa9b0bb, roughness: 0.32, metalness: 1 }),
      dark: new THREE.MeshStandardMaterial({ color: 0x4a4f59, roughness: 0.45, metalness: 0.9 }),
      // Not mirror-smooth: a mirror picks up the stadium spots as pin-point highlights that bloom into white bars.
      chrome: new THREE.MeshStandardMaterial({ color: 0xd4dae2, roughness: 0.22, metalness: 1 }),
      rubber: new THREE.MeshStandardMaterial({ color: 0x141518, roughness: 0.85, metalness: 0.1 }),
      glow: glowTexture(),
      blur: blurTexture(),
      flame: flameTexture(),
    };
  }
  return shared;
}

const CHAR = new THREE.Color(0x19191c);
const HOT = new THREE.Color(1, 0.86, 0.72);

/* ---------------------------------------------------------------- small mechanical helpers ---------------- */

/** Damped spring, integrated in small fixed substeps so stiff settings stay stable at low frame rates. */
class Spring {
  v = 0;
  constructor(public x = 0) {}
  step(target: number, k: number, c: number, dt: number): number {
    let t = dt;
    while (t > 1e-6) {
      const h = Math.min(t, 1 / 120);
      this.v += (k * (target - this.x) - c * this.v) * h;
      this.x += this.v * h;
      t -= h;
    }
    return this.x;
  }
}

/**
 * Hydraulic cylinder between a fixed point on the chassis and a moving anchor on a weapon part. The barrel stays
 * put at the chassis end and swivels to face the anchor; the chrome rod stretches to reach it.
 */
class Piston {
  readonly root = new THREE.Group();
  private rod: THREE.Mesh;
  private w = new THREE.Vector3();
  constructor(private parent: THREE.Object3D, at: THREE.Vector3, private tip: THREE.Object3D, barrelLen: number, radius: number, barrelMat: THREE.Material) {
    this.root.position.copy(at);
    parent.add(this.root);
    const bg = new THREE.CylinderGeometry(radius, radius, barrelLen, 12).rotateX(Math.PI / 2).translate(0, 0, barrelLen / 2);
    const barrel = new THREE.Mesh(bg, barrelMat);
    barrel.castShadow = true;
    const cap = new THREE.Mesh(new THREE.SphereGeometry(radius * 1.05, 10, 8), barrelMat);
    const rg = new THREE.CylinderGeometry(radius * 0.5, radius * 0.5, 1, 8).rotateX(Math.PI / 2).translate(0, 0, 0.5);
    this.rod = new THREE.Mesh(rg, S().chrome);
    this.root.add(barrel, cap, this.rod);
  }
  update() {
    this.tip.getWorldPosition(this.w);
    this.root.lookAt(this.w);
    this.parent.worldToLocal(this.w);
    this.rod.scale.z = Math.max(0.01, this.w.distanceTo(this.root.position));
  }
}

function spokedWheel(radius: number, width: number): THREE.Group {
  const m = S();
  const g = new THREE.Group();
  const tire = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, width, 28), m.tire);
  tire.rotation.x = Math.PI / 2;
  tire.castShadow = true;
  const rim = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.64, radius * 0.64, width + 0.012, 18), m.rim);
  rim.rotation.x = Math.PI / 2;
  g.add(tire, rim);
  // Three bright spokes standing proud of the rim on both faces: they make the spin (and its direction) readable.
  const spokes = [0, 1, 2].map((i) => new THREE.BoxGeometry(radius * 1.16, radius * 0.16, width + 0.03).rotateZ((i * Math.PI) / 3));
  g.add(new THREE.Mesh(mergeGeometries(spokes), m.steel));
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.2, radius * 0.2, width + 0.05, 10), m.chrome);
  cap.rotation.x = Math.PI / 2;
  g.add(cap);
  return g;
}

/* ---------------------------------------------------------------- the model ---------------- */

interface WheelRef {
  g: THREE.Group;
  side: number;
  spin: number;
}

export class BotMesh {
  readonly group = new THREE.Group();
  readonly bot: Bot;
  private body: THREE.Group;
  /** Chassis pivot: springs move this; `body` keeps the frame-level scale. */
  private chassis = new THREE.Group();
  private paint: { m: THREE.MeshStandardMaterial; base: THREE.Color }[] = [];
  private bodyMats: THREE.MeshStandardMaterial[] = [];
  private wheels: WheelRef[] = [];
  private pistons: Piston[] = [];

  // floor markings
  private ring: THREE.Mesh;
  private ringMat: THREE.MeshBasicMaterial;
  private glow: THREE.Mesh;
  private glowMat: THREE.MeshBasicMaterial;
  private chevronMat: THREE.MeshBasicMaterial;

  // lights on the body
  private teamGlow: THREE.MeshStandardMaterial;
  private lampMat: THREE.MeshStandardMaterial;
  private leds: THREE.MeshStandardMaterial[] = [];
  private sensorLight?: THREE.MeshStandardMaterial;
  private mast?: THREE.Group;
  private mastSpring = { x: new Spring(), z: new Spring() };

  // weapon rigs
  private blade?: THREE.Group;
  private bladeBlur?: THREE.MeshBasicMaterial;
  private pulley?: THREE.Mesh;
  private hammerArm?: THREE.Group;
  private hammerSpring = new Spring(1.15);
  private jawL?: THREE.Group;
  private jawR?: THREE.Group;
  private clawUpper?: THREE.Group;
  private clawFore?: THREE.Group;
  private clawLight?: THREE.MeshStandardMaterial;
  private plate?: THREE.Group;
  private plateSpring = new Spring(-0.18);
  private bar?: THREE.Group;
  private barBlur?: THREE.MeshBasicMaterial;
  private flame?: THREE.Group;
  private flameOuter?: THREE.MeshBasicMaterial;
  private flameCore?: THREE.MeshBasicMaterial;
  private pilot?: THREE.Mesh;
  private nozzleMat?: THREE.MeshStandardMaterial;
  private nozzleHeat = 0;
  private plow?: THREE.Group;
  private plowSpring = new Spring(0);
  private exhaust: THREE.MeshStandardMaterial[] = [];
  private exhaustFlames: THREE.Mesh[] = [];
  private exhaustFlameMat?: THREE.MeshBasicMaterial;
  private ventAt?: THREE.Vector3;

  // motion state
  private pitch = new Spring();
  private roll = new Spring();
  private heave = new Spring();
  private jolt = new THREE.Vector2();
  private prevFwd = 0;
  private prevHeading: number;
  private prevAirborne = false;
  private prevDamagedAt = -Infinity;
  private prevReady = true;
  private prevPhase = "idle";
  private prevFlip = 0;
  private flash = 0;
  private readyFlare = 0;
  private sputter = 0;
  private smokeTimer = 0;
  private burnTimer = 0;
  private wheelScale = 1;
  private wheelWidth = 1;
  private rigScale = 1;
  private halfTrack = 0.6;

  constructor(bot: Bot) {
    this.bot = bot;
    this.prevHeading = bot.heading;
    const L = bot.def.build.levels;
    const team = new THREE.Color(bot.def.color);
    this.wheelScale = 0.85 + L.motor * 0.05;
    this.wheelWidth = 1 + L.traction * 0.14;
    this.rigScale = 0.82 + L.power * 0.06;
    this.body = new THREE.Group();
    this.body.scale.setScalar(1.18 * (0.955 + L.frame * 0.015));
    this.chassis.add(this.body);
    this.group.add(this.chassis);

    // Floor: a soft team-colored underglow, a crisp team ring and a chevron pointing where the bot faces.
    this.glowMat = new THREE.MeshBasicMaterial({ map: S().glow, color: team, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false });
    this.glow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.glowMat);
    this.glow.rotation.x = -Math.PI / 2;
    this.glow.position.y = 0.018;
    this.glow.scale.setScalar(bot.radius * 3.6);
    this.group.add(this.glow);
    this.ringMat = new THREE.MeshBasicMaterial({ color: team, transparent: true, opacity: 0.75, side: THREE.DoubleSide, depthWrite: false });
    this.ring = new THREE.Mesh(new THREE.RingGeometry(bot.radius + 0.16, bot.radius + 0.24, 56), this.ringMat);
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.024;
    this.group.add(this.ring);
    const chev = new THREE.Shape();
    chev.moveTo(0.3, 0);
    chev.lineTo(-0.02, 0.22);
    chev.lineTo(0.04, 0);
    chev.lineTo(-0.02, -0.22);
    chev.closePath();
    this.chevronMat = new THREE.MeshBasicMaterial({ color: team, transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthWrite: false });
    const chevron = new THREE.Mesh(new THREE.ShapeGeometry(chev), this.chevronMat);
    chevron.position.set(bot.radius + 0.3, 0, 0); // a child of the ring, so already lying in the floor plane
    this.ring.add(chevron);

    this.teamGlow = new THREE.MeshStandardMaterial({ color: 0x0a0a0c, emissive: team, emissiveIntensity: 3.2, roughness: 0.3 });
    this.lampMat = new THREE.MeshStandardMaterial({ color: 0x202020, emissive: 0xfff2d8, emissiveIntensity: 4, roughness: 0.2 });

    switch (bot.kind) {
      case "saw":
        this.buildSaw();
        break;
      case "hammer":
        this.buildHammer();
        break;
      case "grabber":
        this.buildGrabber();
        break;
      case "flipper":
        this.buildFlipper();
        break;
      case "spinner":
        this.buildSpinner();
        break;
      case "torch":
        this.buildTorch();
        break;
      case "ram":
        this.buildRam();
        break;
    }
    this.addArmor(L.armor);
    this.addSystems(L.wedge, L.gyro, L.sensors);
    for (const g of [this.body, this.blade, this.bar, this.hammerArm, this.jawL, this.jawR, this.clawUpper, this.clawFore, this.plate, this.plow, this.mast]) {
      if (g) this.bake(g);
    }
  }

  /**
   * Merge a part's rigid children into one mesh per material, in the part's own space: the chassis's fixed pieces,
   * and each weapon rig's pieces (which then move as one). Child groups (wheels, pistons, sub-rigs) and anything
   * flagged `userData.animated` are left alone; transparent parts stay separate so they sort correctly. Cuts a bot
   * from ~75 draw calls to ~30 with no visual change (materials are shared, so flashes and scorching still apply).
   */
  private bake(parent: THREE.Object3D) {
    const byMat = new Map<THREE.Material, THREE.Mesh[]>();
    for (const o of parent.children) {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || mesh.children.length || mesh.userData.animated) continue;
      const mat = mesh.material as THREE.Material;
      if (Array.isArray(mesh.material) || mat.transparent) continue;
      if (!byMat.has(mat)) byMat.set(mat, []);
      byMat.get(mat)!.push(mesh);
    }
    for (const [mat, meshes] of byMat) {
      if (meshes.length < 2) continue;
      const geos = meshes.map((m) => {
        m.updateMatrix();
        const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
        g.applyMatrix4(m.matrix);
        for (const name of Object.keys(g.attributes)) if (!["position", "normal", "uv"].includes(name)) g.deleteAttribute(name);
        return g;
      });
      const merged = mergeGeometries(geos);
      if (!merged) continue;
      const casts = meshes.some((m) => m.castShadow);
      for (const m of meshes) parent.remove(m);
      const baked = new THREE.Mesh(merged, mat);
      baked.castShadow = casts;
      baked.receiveShadow = true;
      parent.add(baked);
    }
  }

  /* ------------------------------------------------------------ construction helpers ---------------- */

  /** Clear-coated team paint. Tracked for hit flashes, scorching and the destroyed char. */
  private paintMat(color: number, extra: Partial<THREE.MeshPhysicalMaterialParameters> = {}): THREE.MeshStandardMaterial {
    const m = new THREE.MeshPhysicalMaterial({ color, roughness: 0.42, metalness: 0.25, clearcoat: 0.7, clearcoatRoughness: 0.3, ...extra });
    this.paint.push({ m, base: m.color.clone() });
    this.bodyMats.push(m);
    return m;
  }

  private mat(color: number, extra: Partial<THREE.MeshStandardMaterialParameters> = {}): THREE.MeshStandardMaterial {
    const m = new THREE.MeshStandardMaterial({ color, roughness: 0.45, metalness: 0.6, ...extra });
    this.bodyMats.push(m);
    return m;
  }

  private box(w: number, h: number, d: number, m: THREE.Material, x = 0, y = 0, z = 0, round = 0): THREE.Mesh {
    const r = Math.min(round, w / 2, h / 2, d / 2) * 0.999;
    const geo = r > 0.004 ? new RoundedBoxGeometry(w, h, d, 2, r) : new THREE.BoxGeometry(w, h, d);
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.body.add(mesh);
    return mesh;
  }

  private cyl(r: number, len: number, m: THREE.Material, axis: "x" | "y" | "z", x: number, y: number, z: number, parent: THREE.Object3D = this.body, seg = 14): THREE.Mesh {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, seg), m);
    if (axis === "x") mesh.rotation.z = Math.PI / 2;
    if (axis === "z") mesh.rotation.x = Math.PI / 2;
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    parent.add(mesh);
    return mesh;
  }

  /** An empty marker on a moving part, for a piston to aim at. */
  private anchor(parent: THREE.Object3D, x: number, y: number, z: number): THREE.Object3D {
    const o = new THREE.Object3D();
    o.position.set(x, y, z);
    parent.add(o);
    return o;
  }

  private piston(at: [number, number, number], tip: THREE.Object3D, barrelLen: number, radius: number, barrelMat: THREE.Material = S().dark) {
    this.pistons.push(new Piston(this.body, new THREE.Vector3(...at), tip, barrelLen, radius, barrelMat));
  }

  private addWheels(x: number, z: number, r: number, w: number, count = 2) {
    this.halfTrack = z;
    for (let i = 0; i < count; i++) {
      const xi = count === 1 ? 0 : x * (i === 0 ? 1 : -1);
      for (const side of [-1, 1]) {
        const g = spokedWheel(r * this.wheelScale, w * this.wheelWidth);
        g.position.set(xi, r * this.wheelScale, side * (z + (w * (this.wheelWidth - 1)) / 2));
        this.body.add(g);
        this.wheels.push({ g, side, spin: 0 });
      }
    }
  }

  /** Team-colored visor strip across the front face plus a pair of headlights: every bot gets a readable "face". */
  private visor(x: number, y: number, width: number, lampsY = y - 0.09) {
    this.box(0.035, 0.05, width, this.teamGlow, x, y, 0, 0.012);
    for (const s of [-1, 1]) {
      const lamp = this.cyl(0.04, 0.03, this.lampMat, "x", x + 0.004, lampsY, s * width * 0.42, this.body, 10);
      lamp.castShadow = false;
    }
  }

  /** Four LED segments on the back: weapon charge. Laid out across the bot, left to right. */
  private ledBar(x: number, y: number, tilt = 0) {
    for (let i = 0; i < 4; i++) {
      const m = new THREE.MeshStandardMaterial({ color: 0x0a0a0c, emissive: this.bot.def.color, emissiveIntensity: 0, roughness: 0.3 });
      const led = this.box(0.05, 0.035, 0.085, m, x, y, (i - 1.5) * 0.11);
      led.rotation.z = tilt;
      led.castShadow = false;
      this.leds.push(m);
    }
  }

  /** A row of rivet heads, for honest-looking plate joins. */
  private rivets(xs: number[], y: number, z: number, r = 0.022) {
    const geo = new THREE.SphereGeometry(r, 6, 5);
    for (const x of xs) {
      const m = new THREE.Mesh(geo, S().steel);
      m.position.set(x, y, z);
      this.body.add(m);
    }
  }

  /** Systems parts that show on the body: a wedge skirt up front, a gyro dome on top, a sensor mast at the back. */
  private addSystems(wedge: number, gyro: number, sensors: number) {
    const r = this.bot.radius;
    const m = S();
    if (wedge > 0) {
      const skirtMat = this.mat(0x5a606c, { roughness: 0.35, metalness: 0.95 });
      const skirt = this.box(0.22 + wedge * 0.06, 0.05, r * 1.45, skirtMat, r * 0.78 + 0.05, 0.1, 0);
      skirt.rotation.z = -0.32 - wedge * 0.03;
      for (let i = 1; i < wedge; i++) {
        const lip = this.box(0.04, 0.03, r * 1.45, m.steel, r * 0.78 + 0.08 + i * 0.05, 0.08 - i * 0.012, 0);
        lip.rotation.z = -0.32;
      }
    }
    if (gyro > 0) {
      // Smoked-glass dome: glossy enough to catch the lights, dark enough not to bloom into a white blob.
      const domeMat = new THREE.MeshPhysicalMaterial({ color: 0x1c2733, metalness: 0.3, roughness: 0.12, clearcoat: 1, clearcoatRoughness: 0.08 });
      const dome = new THREE.Mesh(new THREE.SphereGeometry(0.12 + gyro * 0.02, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2), domeMat);
      dome.position.set(-0.35, 0.78, this.bot.kind === "hammer" ? 0.45 : 0.3);
      dome.castShadow = true;
      this.body.add(dome);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.13 + gyro * 0.02, 0.015, 6, 24), this.teamGlow);
      ring.rotation.x = Math.PI / 2;
      ring.position.copy(dome.position);
      ring.position.y += 0.02;
      this.body.add(ring);
    }
    if (sensors > 0) {
      // A sprung whip mast: it sways back when the bot accelerates and wobbles after hits.
      this.mast = new THREE.Group();
      this.mast.position.set(-0.55, 0.72, this.bot.kind === "hammer" ? -0.5 : -0.35);
      this.body.add(this.mast);
      const len = 0.32 + sensors * 0.1;
      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 0.06, 10), m.dark);
      base.position.y = 0.03;
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.02, len, 6), m.steel);
      pole.position.y = 0.06 + len / 2;
      this.sensorLight = new THREE.MeshStandardMaterial({ color: 0x220000, emissive: 0xff4d5e, emissiveIntensity: 1.2, roughness: 0.3 });
      const tip = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 8), this.sensorLight);
      tip.position.y = 0.06 + len + 0.02;
      this.mast.add(base, pole, tip);
      if (sensors >= 3) {
        const dish = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.05, 14, 1, true), m.rim);
        (dish.material as THREE.Material).side = THREE.DoubleSide;
        dish.position.y = 0.06 + len * 0.6;
        dish.rotation.x = Math.PI;
        this.mast.add(dish);
      }
    }
  }

  /** Armor plating: one riveted side plate per level, alternating sides, front to back. */
  private addArmor(level: number) {
    if (level <= 0) return;
    const plateMat = this.mat(0x575d69, { roughness: 0.38, metalness: 0.92 });
    const r = this.bot.radius;
    for (let i = 0; i < level; i++) {
      const side = i % 2 === 0 ? 1 : -1;
      const x = 0.25 - Math.floor(i / 2) * 0.32;
      const z = side * (r * 0.62 + 0.02);
      const plate = this.box(0.3, 0.2, 0.06, plateMat, x, 0.5, z, 0.02);
      plate.rotation.x = side * 0.1;
      this.rivets([x - 0.1, x + 0.1], 0.5, z + side * 0.035);
    }
  }

  /* ------------------------------------------------------------ the seven kinds ---------------- */

  /** RIPSAW: wedge chassis, hazard livery, big belt-driven vertical disc up front. */
  private buildSaw() {
    const m = S();
    const main = this.paintMat(this.bot.def.color);
    const trim = this.paintMat(this.bot.def.accent, { roughness: 0.55, clearcoat: 0.2 });
    this.box(1.1, 0.34, 1.05, main, -0.1, 0.36, 0, 0.06);
    // sloped nose
    const nose = this.box(0.7, 0.3, 1.0, trim, 0.5, 0.3, 0, 0.04);
    nose.rotation.z = 0.35;
    // hazard chevrons on the deck
    for (const z of [-0.3, 0.3]) {
      const stripe = this.box(0.42, 0.012, 0.09, trim, -0.15, 0.535, z);
      stripe.rotation.y = z > 0 ? -0.5 : 0.5;
    }
    this.box(0.5, 0.14, 0.6, trim, -0.5, 0.6, 0, 0.04); // rear motor hump
    this.cyl(0.11, 0.5, m.dark, "z", -0.5, 0.72, 0); // motor can
    // Blade pylons (swing-arm forks) and the belt drive from the motor to the blade hub.
    for (const z of [0.14, -0.14]) this.box(0.08, 0.5, 0.08, m.steel, 0.55, 0.62, z, 0.02);
    this.pulley = this.cyl(0.09, 0.05, m.steel, "z", -0.5, 0.72, 0.29);
    this.pulley.userData.animated = true;
    const belt = this.box(1.2, 0.035, 0.03, m.rubber, 0.08, 0.72, 0.29);
    belt.castShadow = false;
    this.blade = new THREE.Group();
    this.blade.position.set(this.bot.radius + 0.22, 0.62, 0);
    this.blade.scale.setScalar(this.rigScale);
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.56, 0.56, 0.06, 40), m.steel);
    disc.rotation.x = Math.PI / 2; // axis along z: disc stands vertical, facing forward
    disc.castShadow = true;
    this.blade.add(disc);
    // lightening holes so the spin reads even before the blur kicks in
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      const hole = this.cyl(0.07, 0.07, m.rubber, "z", Math.cos(a) * 0.32, Math.sin(a) * 0.32, 0, this.blade, 12);
      hole.castShadow = false;
    }
    const toothMat = this.mat(0xeef2f8, { metalness: 1, roughness: 0.15 });
    for (let t = 0; t < 16; t++) {
      const a = (t / 16) * Math.PI * 2;
      const tooth = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.16, 0.08), toothMat);
      tooth.position.set(Math.cos(a) * 0.6, Math.sin(a) * 0.6, 0);
      tooth.rotation.z = a + 0.5;
      this.blade.add(tooth);
    }
    this.cyl(0.14, 0.12, m.dark, "z", 0, 0, 0, this.blade, 14);
    this.cyl(0.05, 0.16, m.chrome, "z", 0, 0, 0, this.blade, 8);
    this.body.add(this.blade);
    this.bladeBlur = new THREE.MeshBasicMaterial({ map: m.blur, color: 0xb8c4d2, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide });
    const blur = new THREE.Mesh(new THREE.CircleGeometry(0.72 * this.rigScale, 40), this.bladeBlur);
    blur.position.copy(this.blade.position);
    blur.position.z = 0.045;
    this.body.add(blur);
    const blur2 = blur.clone();
    blur2.position.z = -0.045;
    this.body.add(blur2);
    this.visor(0.31, 0.5, 0.86, 0.43);
    this.ledBar(-0.66, 0.5, 0);
    this.ventAt = new THREE.Vector3(-0.6, 0.6, 0);
    this.addWheels(0.35, 0.56, 0.22, 0.14);
  }

  /** PILEDRIVER: brick of armor with a long sprung hammer arm on twin lift rams. */
  private buildHammer() {
    const m = S();
    const main = this.paintMat(this.bot.def.color, { roughness: 0.5, clearcoat: 0.5 });
    const trim = this.paintMat(this.bot.def.accent, { roughness: 0.4, metalness: 0.75, clearcoat: 0.2 });
    this.box(1.5, 0.55, 1.35, main, 0, 0.42, 0, 0.08);
    this.box(1.6, 0.1, 1.45, trim, 0, 0.72, 0, 0.04); // top plate
    this.box(0.3, 0.3, 1.4, trim, 0.78, 0.3, 0, 0.06); // front bumper
    for (const z of [-0.62, 0.62]) this.rivets([-0.6, -0.3, 0, 0.3, 0.6], 0.78, z, 0.035);
    // Pivot tower: two cheeks and an axle.
    for (const z of [0.22, -0.22]) this.box(0.28, 0.5, 0.1, trim, -0.5, 0.97, z, 0.03);
    this.cyl(0.07, 0.6, m.chrome, "z", -0.5, 1.12, 0);
    this.hammerArm = new THREE.Group();
    this.hammerArm.position.set(-0.5, 1.12, 0);
    this.hammerArm.scale.set(1, this.rigScale, this.rigScale);
    const arm = new THREE.Mesh(new RoundedBoxGeometry(1.9, 0.14, 0.22, 2, 0.04), m.steel);
    arm.position.set(0.95, 0, 0);
    arm.castShadow = true;
    this.hammerArm.add(arm);
    const head = new THREE.Mesh(new RoundedBoxGeometry(0.55, 0.42, 0.55, 2, 0.06), trim);
    head.scale.setScalar(this.rigScale);
    head.position.set(1.95, -0.05, 0);
    head.castShadow = true;
    this.hammerArm.add(head);
    const face = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.24, 0.08, 16), m.steel);
    face.position.set(1.95, -0.3 * this.rigScale, 0);
    this.hammerArm.add(face);
    const spike = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.3, 10), m.chrome);
    spike.position.set(1.95, -0.45 * this.rigScale, 0);
    spike.rotation.x = Math.PI;
    this.hammerArm.add(spike);
    this.body.add(this.hammerArm);
    // Lift rams from the front deck to the arm.
    for (const z of [0.17, -0.17]) this.piston([0.5, 0.8, z], this.anchor(this.hammerArm, 0.55, -0.07, z), 0.42, 0.065);
    this.visor(0.935, 0.42, 1.1, 0.3);
    this.ledBar(-0.76, 0.62, 0);
    this.ventAt = new THREE.Vector3(-0.7, 0.8, 0);
    this.addWheels(0.5, 0.74, 0.26, 0.2);
  }

  /** CLAMP: two jaws on hydraulic rams at the front, a two-joint crushing arm on top. */
  private buildGrabber() {
    const m = S();
    const main = this.paintMat(this.bot.def.color, { roughness: 0.38 });
    const trim = this.paintMat(this.bot.def.accent, { roughness: 0.55, clearcoat: 0.2 });
    this.box(1.25, 0.4, 1.15, main, -0.1, 0.38, 0, 0.07);
    this.box(0.8, 0.14, 0.9, trim, -0.2, 0.66, 0, 0.04);
    this.box(0.4, 0.3, 0.3, trim, -0.55, 0.85, 0, 0.05); // hydraulic reservoir
    this.cyl(0.12, 0.6, m.rim, "x", -0.1, 0.85, 0.28); // accumulator
    this.cyl(0.13, 0.04, m.steel, "x", 0.21, 0.85, 0.28);
    const makeJaw = (side: number) => {
      const g = new THREE.Group();
      g.position.set(0.5, 0.42, side * 0.5);
      const arm = new THREE.Mesh(new RoundedBoxGeometry(1.1, 0.18, 0.14, 2, 0.03), m.steel);
      arm.position.set(0.55, 0, 0);
      arm.castShadow = true;
      g.add(arm);
      const tip = new THREE.Mesh(new RoundedBoxGeometry(0.25, 0.3, 0.14, 2, 0.03), trim);
      tip.position.set(1.08, 0, side * -0.05);
      tip.rotation.y = side * 0.5;
      g.add(tip);
      for (let i = 0; i < 3; i++) {
        const tooth = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.14, 6), m.chrome);
        tooth.position.set(0.5 + i * 0.25, 0, -side * 0.1);
        tooth.rotation.x = side * (Math.PI / 2);
        g.add(tooth);
      }
      this.cyl(0.06, 0.2, m.dark, "y", 0, 0, 0, g, 10); // pivot boss
      this.body.add(g);
      this.piston([0.0, 0.62, side * 0.36], this.anchor(g, 0.5, 0.14, 0), 0.32, 0.05);
      return g;
    };
    this.jawL = makeJaw(1);
    this.jawR = makeJaw(-1);
    this.jawL.scale.set(this.rigScale, this.rigScale, 1);
    this.jawR.scale.set(this.rigScale, this.rigScale, 1);
    // Crushing arm: shoulder on a turret, an upper arm, an elbow, and a forearm ending in a pick.
    this.cyl(0.14, 0.12, m.dark, "y", -0.05, 0.78, -0.1);
    this.clawUpper = new THREE.Group();
    this.clawUpper.position.set(-0.05, 0.9, -0.1);
    const upper = new THREE.Mesh(new RoundedBoxGeometry(0.75, 0.12, 0.16, 2, 0.03), m.steel);
    upper.position.set(0.375, 0, 0);
    upper.castShadow = true;
    this.clawUpper.add(upper);
    this.cyl(0.08, 0.2, trim, "z", 0, 0, 0, this.clawUpper, 12);
    this.clawFore = new THREE.Group();
    this.clawFore.position.set(0.75, 0, 0);
    this.cyl(0.07, 0.2, trim, "z", 0, 0, 0, this.clawFore, 12);
    const fore = new THREE.Mesh(new RoundedBoxGeometry(0.55, 0.1, 0.13, 2, 0.03), m.steel);
    fore.position.set(0.27, 0, 0);
    fore.castShadow = true;
    this.clawFore.add(fore);
    const pick = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.26, 8), trim);
    pick.position.set(0.6, 0, 0);
    pick.rotation.z = -Math.PI / 2;
    this.clawFore.add(pick);
    this.clawLight = new THREE.MeshStandardMaterial({ color: 0x0a0a0c, emissive: 0xff3344, emissiveIntensity: 0, roughness: 0.3 });
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 6), this.clawLight);
    lamp.position.set(0.1, 0.07, 0);
    this.clawFore.add(lamp);
    this.clawUpper.add(this.clawFore);
    this.body.add(this.clawUpper);
    this.piston([0.25, 0.72, -0.1], this.anchor(this.clawUpper, 0.36, -0.06, 0), 0.26, 0.045);
    this.visor(0.53, 0.46, 0.7, 0.33);
    this.ledBar(-0.73, 0.5, 0);
    this.ventAt = new THREE.Vector3(-0.55, 1.0, 0);
    this.addWheels(0.4, 0.62, 0.24, 0.18);
  }

  /** LAUNCHER: low wedge, a big front plate hinged at its back edge, fired by twin pneumatic rams. */
  private buildFlipper() {
    const m = S();
    const main = this.paintMat(this.bot.def.color, { roughness: 0.42 });
    const trim = this.paintMat(this.bot.def.accent, { roughness: 0.55, clearcoat: 0.2 });
    this.box(1.1, 0.3, 1.25, main, -0.25, 0.3, 0, 0.06);
    this.box(0.5, 0.12, 0.7, trim, -0.5, 0.5, 0, 0.04);
    // Gas tank with a regulator.
    this.cyl(0.16, 0.8, m.rim, "z", -0.55, 0.62, 0, this.body, 16);
    for (const z of [-0.41, 0.41]) {
      const end = new THREE.Mesh(new THREE.SphereGeometry(0.16, 14, 8), m.rim);
      end.scale.set(1, 1, 0.35);
      end.position.set(-0.55, 0.62, z);
      this.body.add(end);
    }
    this.cyl(0.05, 0.12, m.chrome, "y", -0.55, 0.8, 0);
    // Hinge
    this.cyl(0.06, 1.3, m.chrome, "z", 0.2, 0.42, 0);
    this.plate = new THREE.Group();
    this.plate.position.set(0.2, 0.42, 0);
    this.plate.scale.set(this.rigScale, 1, 1);
    const plate = new THREE.Mesh(new RoundedBoxGeometry(0.95, 0.06, 1.25, 2, 0.02), m.steel);
    plate.position.set(0.48, 0, 0);
    plate.castShadow = true;
    plate.receiveShadow = true;
    this.plate.add(plate);
    const lip = new THREE.Mesh(new RoundedBoxGeometry(0.1, 0.1, 1.25, 2, 0.02), trim);
    lip.position.set(0.95, 0.02, 0);
    this.plate.add(lip);
    // Team stripe down the plate so the flipper's front reads from above.
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.008, 0.14), this.teamGlow);
    stripe.position.set(0.48, 0.034, 0);
    this.plate.add(stripe);
    this.body.add(this.plate);
    for (const z of [0.32, -0.32]) this.piston([-0.12, 0.32, z], this.anchor(this.plate, 0.42, -0.03, z), 0.3, 0.07);
    // Wedge underside
    const wedge = this.box(0.9, 0.22, 1.2, trim, 0.5, 0.17, 0, 0.03);
    wedge.rotation.z = -0.2;
    this.visor(0.2, 0.32, 0.9, 0.25);
    this.ledBar(-0.81, 0.36, 0);
    this.ventAt = new THREE.Vector3(-0.75, 0.4, 0);
    this.addWheels(0.35, 0.66, 0.2, 0.16);
  }

  /** CYCLONE: a low drum of a body with a long bar on a vertical axle over the front. */
  private buildSpinner() {
    const m = S();
    const main = this.paintMat(this.bot.def.color, { roughness: 0.38 });
    const trim = this.paintMat(this.bot.def.accent, { roughness: 0.55, clearcoat: 0.2 });
    const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.68, 0.36, 20), main);
    drum.position.set(-0.15, 0.36, 0);
    drum.castShadow = true;
    drum.receiveShadow = true;
    this.body.add(drum);
    const band = new THREE.Mesh(new THREE.TorusGeometry(0.66, 0.03, 6, 32), m.dark);
    band.rotation.x = Math.PI / 2;
    band.position.set(-0.15, 0.26, 0);
    this.body.add(band);
    this.box(0.5, 0.14, 0.7, trim, -0.45, 0.6, 0, 0.04); // motor housing
    // Axle tower with a bearing collar.
    const tower = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.13, 0.5, 14), m.steel);
    tower.position.set(0.3, 0.7, 0);
    this.body.add(tower);
    this.cyl(0.16, 0.06, m.dark, "y", 0.3, 0.9, 0, this.body, 16);
    this.bar = new THREE.Group();
    this.bar.position.set(0.3, 0.98, 0);
    const barMesh = new THREE.Mesh(new RoundedBoxGeometry(2.2 * this.rigScale, 0.1, 0.18, 2, 0.03), m.steel);
    barMesh.castShadow = true;
    this.bar.add(barMesh);
    const tipMat = this.mat(0xeef2f8, { metalness: 1, roughness: 0.15 });
    for (const s of [-1, 1]) {
      const tip = new THREE.Mesh(new RoundedBoxGeometry(0.24, 0.16, 0.26, 2, 0.03), tipMat);
      tip.position.set(s * 1.05 * this.rigScale, 0, 0);
      this.bar.add(tip);
      const mark = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.012, 0.06), this.teamGlow);
      mark.position.set(s * 0.7 * this.rigScale, 0.056, 0);
      this.bar.add(mark);
    }
    this.cyl(0.14, 0.14, m.dark, "y", 0, 0, 0, this.bar, 14);
    this.body.add(this.bar);
    this.barBlur = new THREE.MeshBasicMaterial({ map: m.blur, color: 0xb8c4d2, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide });
    const blur = new THREE.Mesh(new THREE.CircleGeometry(1.18 * this.rigScale, 48), this.barBlur);
    blur.rotation.x = -Math.PI / 2;
    blur.position.set(0.3, 0.98, 0);
    this.body.add(blur);
    this.visor(0.42, 0.42, 0.7, 0.32);
    this.ledBar(-0.71, 0.6, 0);
    this.ventAt = new THREE.Vector3(-0.6, 0.7, 0);
    this.addWheels(0.35, 0.58, 0.22, 0.14);
  }

  /** SCORCH: boxy chassis, twin fuel tanks on the back, a nozzle with a pilot light and a layered flame. */
  private buildTorch() {
    const m = S();
    const main = this.paintMat(this.bot.def.color, { roughness: 0.42 });
    const trim = this.paintMat(this.bot.def.accent, { roughness: 0.55, clearcoat: 0.2 });
    this.box(1.15, 0.36, 1.05, main, -0.1, 0.36, 0, 0.06);
    this.box(0.7, 0.1, 0.8, trim, -0.2, 0.6, 0, 0.03);
    for (const z of [-0.28, 0.28]) {
      const tank = this.cyl(0.17, 0.75, m.rim, "x", -0.4, 0.74, z, this.body, 16);
      tank.castShadow = true;
      for (const x of [-0.6, -0.2]) {
        const band = new THREE.Mesh(new THREE.TorusGeometry(0.175, 0.018, 6, 18), trim);
        band.rotation.y = Math.PI / 2;
        band.position.set(x, 0.74, z);
        this.body.add(band);
      }
      const cap = this.cyl(0.05, 0.06, m.chrome, "x", -0.8, 0.74, z);
      cap.castShadow = false;
    }
    // Fuel line and nozzle
    this.cyl(0.06, 1.0, m.steel, "x", 0.35, 0.62, 0);
    const feed = this.box(0.04, 0.04, 0.5, m.rubber, -0.05, 0.66, 0);
    feed.castShadow = false;
    this.nozzleMat = new THREE.MeshStandardMaterial({ color: 0x3a3e46, roughness: 0.45, metalness: 0.9, emissive: 0xff4a10, emissiveIntensity: 0 });
    const nozzle = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.3, 14, 1, true), this.nozzleMat);
    nozzle.rotation.z = -Math.PI / 2;
    nozzle.position.set(0.95, 0.62, 0);
    (nozzle.material as THREE.Material).side = THREE.DoubleSide;
    this.body.add(nozzle);
    // Pilot light: a small blue-white flicker at the nozzle whenever the bot is alive.
    this.pilot = new THREE.Mesh(
      new THREE.SphereGeometry(0.06, 10, 8),
      new THREE.MeshBasicMaterial({ color: 0x7fb8ff, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    this.pilot.position.set(1.12, 0.62, 0);
    this.body.add(this.pilot);
    // Flame: an orange outer cone around a yellow-white core, scaled to the weapon's range.
    const range = this.bot.def.tuning.torch.range;
    const fm = (color: number, opacity: number) =>
      new THREE.MeshBasicMaterial({ map: m.flame, color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    this.flameOuter = fm(0xff5a10, 0.55);
    this.flameCore = fm(0xffd890, 0.6);
    this.flame = new THREE.Group();
    this.flame.position.set(1.05, 0.6, 0);
    // Apex (+y before the rotation) ends up at the nozzle; the open base fans out at full range.
    const outer = new THREE.Mesh(new THREE.ConeGeometry(0.6, range, 20, 1, true).rotateZ(Math.PI / 2).translate(range / 2, 0, 0), this.flameOuter);
    const core = new THREE.Mesh(new THREE.ConeGeometry(0.2, range * 0.55, 14, 1, true).rotateZ(Math.PI / 2).translate(range * 0.275, 0, 0), this.flameCore);
    this.flame.add(outer, core);
    this.flame.visible = false;
    this.body.add(this.flame);
    this.visor(0.41, 0.42, 0.75, 0.3);
    this.ledBar(-0.69, 0.48, 0);
    this.ventAt = new THREE.Vector3(-0.6, 0.9, 0);
    this.addWheels(0.38, 0.56, 0.22, 0.15);
  }

  /** DOZER: a brick with a big angled plow on hydraulic push arms, brush bars, and exhaust stacks that spit flame on boost. */
  private buildRam() {
    const m = S();
    const main = this.paintMat(this.bot.def.color, { roughness: 0.5, clearcoat: 0.5 });
    const trim = this.paintMat(this.bot.def.accent, { roughness: 0.42, metalness: 0.75, clearcoat: 0.2 });
    this.box(1.35, 0.5, 1.3, main, -0.15, 0.4, 0, 0.08);
    this.box(1.0, 0.1, 1.2, trim, -0.2, 0.68, 0, 0.04);
    for (const z of [-0.58, 0.58]) this.rivets([-0.55, -0.25, 0.05, 0.35], 0.66, z, 0.03);
    // Plow assembly: slides forward on its arms during a boost.
    this.plow = new THREE.Group();
    this.body.add(this.plow);
    const plow = new THREE.Mesh(new RoundedBoxGeometry(0.12, 0.62 * this.rigScale, 1.55, 2, 0.03), m.steel);
    plow.position.set(0.85, 0.42, 0);
    plow.rotation.z = -0.28;
    plow.castShadow = true;
    plow.receiveShadow = true;
    this.plow.add(plow);
    const edge = new THREE.Mesh(new RoundedBoxGeometry(0.08, 0.08, 1.6, 2, 0.02), trim);
    edge.position.set(0.98, 0.14, 0);
    edge.rotation.z = -0.28;
    this.plow.add(edge);
    // Team chevrons painted on the plow face.
    for (const z of [-0.45, 0, 0.45]) {
      const ch = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.12, 0.26), this.teamGlow);
      ch.position.set(0.925, 0.45, z);
      ch.rotation.z = -0.28;
      this.plow.add(ch);
    }
    for (const z of [-0.5, 0, 0.5]) {
      const bar = this.cyl(0.035, 0.7, m.dark, "y", 0.55, 0.5, z, this.plow, 8);
      bar.rotation.z = 0.5;
    }
    for (const z of [-0.42, 0.42]) this.piston([0.35, 0.36, z], this.anchor(this.plow, 0.8, 0.36, z), 0.25, 0.055);
    // Exhaust stacks with glowing tips and flame jets.
    this.exhaustFlameMat = new THREE.MeshBasicMaterial({ color: 0xff8a2a, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false });
    for (const z of [-0.3, 0.3]) {
      const stack = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 0.4, 12), m.dark);
      stack.position.set(-0.6, 0.9, z);
      stack.castShadow = true;
      this.body.add(stack);
      const glowMat = new THREE.MeshStandardMaterial({ color: 0x331100, emissive: 0xff6a00, emissiveIntensity: 0, roughness: 0.6 });
      const glow = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.06, 12), glowMat);
      glow.position.set(-0.6, 1.11, z);
      this.body.add(glow);
      this.exhaust.push(glowMat);
      const jet = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.4, 10, 1, true).translate(0, 0.2, 0), this.exhaustFlameMat);
      jet.position.set(-0.6, 1.13, z);
      jet.visible = false;
      this.body.add(jet);
      this.exhaustFlames.push(jet);
    }
    this.visor(0.53, 0.52, 0.9, 0.42);
    this.ledBar(-0.83, 0.5, 0);
    this.ventAt = new THREE.Vector3(-0.6, 1.2, 0);
    this.addWheels(0.45, 0.72, 0.26, 0.2);
  }

  /* ------------------------------------------------------------ animation ---------------- */

  /** 0..1: how ready the weapon is (spin-up, recharge, fuel or boost reserve). */
  private charge(): number {
    const b = this.bot;
    const w = b.weapon;
    switch (b.kind) {
      case "saw":
      case "spinner":
      case "torch":
      case "ram":
        return w.spin;
      default:
        return w.cooldown > 0 ? Math.max(0, 1 - w.cooldown / Math.max(0.01, w.cooldownMax)) : 1;
    }
  }

  /** Animate from sim state. `dt` is the (sim-scaled) render delta, so slow motion slows the rigs too. */
  update(dt: number, time: number, emitSmoke: (p: THREE.Vector3, heavy: boolean) => void, emitEmbers: (p: THREE.Vector3, count: number) => void = () => undefined) {
    const b = this.bot;
    const pos = toWorld(b.p, b.z);
    this.group.position.copy(pos);
    this.group.rotation.set(0, b.heading, 0);

    // Pitted: sink and tumble away, lights going out.
    if (b.eliminated === "pitted") {
      this.group.position.y = -b.pitFall * 4.5;
      this.group.rotation.x = b.pitFall * 1.2;
      this.group.rotation.z = b.pitFall * 2.0;
      this.ring.visible = this.glow.visible = false;
      this.group.visible = b.pitFall < 1;
      this.teamGlow.emissiveIntensity = Math.max(0, 3.2 * (1 - b.pitFall * 2));
      return;
    }
    const sdt = Math.max(dt, 0);

    /* ---- chassis dynamics (bot-local frame: +x forward) ---- */
    const vx = b.vel.x + b.knock.x;
    const vy = b.vel.y + b.knock.y;
    const fwd = vx * Math.cos(b.heading) + vy * Math.sin(b.heading);
    let dh = b.heading - this.prevHeading;
    dh = Math.atan2(Math.sin(dh), Math.cos(dh));
    const omega = sdt > 1e-4 ? dh / sdt : 0;
    const accel = sdt > 1e-4 ? (fwd - this.prevFwd) / sdt : 0;
    this.prevFwd = fwd;
    this.prevHeading = b.heading;
    const grounded = !b.airborne;
    // Squat on acceleration (nose up), dive on braking; roll out of turns (centripetal = v·ω).
    // A bot in CLAMP's jaws gets hoisted: tipped up and lifted a little, so the grab reads from across the arena.
    const held = b.heldBy && b.alive ? 1 : 0;
    const wantPitch = grounded ? THREE.MathUtils.clamp(accel * 0.006, -0.07, 0.07) + held * 0.14 : 0;
    const wantRoll = grounded ? THREE.MathUtils.clamp(fwd * omega * 0.012, -0.08, 0.08) : 0;
    this.pitch.step(wantPitch, 160, 14, sdt);
    this.roll.step(wantRoll, 160, 12, sdt);
    if (this.prevAirborne && grounded) this.heave.v -= 2.4; // landing compression
    this.prevAirborne = b.airborne;
    this.heave.step(held * 1.6, 220, 13, sdt);

    // Hits: white-hot flash, a jolt away from... anywhere, and a mast wobble.
    if (b.lastDamagedAt !== this.prevDamagedAt) {
      if (b.lastDamagedAt > this.prevDamagedAt && b.lastDamagedAt > -1e9) {
        this.flash = 1;
        const a = Math.random() * Math.PI * 2;
        this.jolt.set(Math.cos(a) * 0.06, Math.sin(a) * 0.06);
        this.pitch.v += (Math.random() - 0.5) * 3;
        this.roll.v += (Math.random() - 0.5) * 3;
        this.mastSpring.x.v += (Math.random() - 0.5) * 14;
        this.mastSpring.z.v += (Math.random() - 0.5) * 14;
      }
      this.prevDamagedAt = b.lastDamagedAt;
    }
    this.flash = Math.max(0, this.flash - sdt * 5);
    this.jolt.multiplyScalar(Math.exp(-sdt * 18));

    const airWobble = b.airborne ? Math.sin(time * 6) * 0.5 : 0;
    const airFlop = b.airborne ? Math.sin(time * 4.3) * 0.5 : 0;
    const stunShake = b.stun > 0 ? Math.sin(time * 30) * 0.03 : 0;
    this.chassis.rotation.set(this.roll.x + airWobble, 0, this.pitch.x + airFlop + stunShake);
    const rumble = grounded && b.alive ? Math.sin(time * 40) * Math.min(1, Math.abs(fwd) / 6) * 0.006 : 0;
    this.chassis.position.set(this.jolt.x, Math.max(-0.08, this.heave.x * 0.05) + rumble + (held ? Math.sin(time * 12) * 0.01 : 0), this.jolt.y);

    // Differential drive: each side's wheels turn at their own surface speed.
    for (const w of this.wheels) {
      const surf = b.controllable || b.airborne ? fwd + w.side * omega * this.halfTrack : 0;
      w.spin += (surf * sdt) / (0.24 * this.wheelScale);
      w.g.rotation.z = -w.spin;
    }

    // Whip mast lags the chassis.
    if (this.mast) {
      const mx = this.mastSpring.x.step(-accel * 0.01 + (b.airborne ? 0.3 : 0), 90, 4, sdt);
      const mz = this.mastSpring.z.step(fwd * omega * 0.02, 90, 4, sdt);
      this.mast.rotation.set(THREE.MathUtils.clamp(mz, -0.5, 0.5), 0, THREE.MathUtils.clamp(mx, -0.5, 0.5));
    }

    /* ---- lighting ---- */
    const hp = b.hpFrac;
    const dead = !b.alive;
    // Paint scorches as HP drops; destroyed bots char.
    const wear = dead && b.eliminated === "destroyed" ? 1 : (1 - hp) * 0.32;
    for (const p of this.paint) p.m.color.copy(p.base).lerp(CHAR, wear);
    for (const m of this.bodyMats) m.emissive.copy(HOT).multiplyScalar(this.flash * 0.9);
    if (dead && b.eliminated === "destroyed") {
      const ember = 0.25 * Math.max(0, Math.sin(time * 9));
      for (const m of this.bodyMats) m.emissive.setRGB(Math.max(m.emissive.r, ember), Math.max(m.emissive.g, ember * 0.2), m.emissive.b);
    }
    if (b.burn > 0 && !dead) {
      const flick = 0.35 + 0.35 * Math.max(0, Math.sin(time * 23) + Math.sin(time * 31) * 0.5);
      for (const m of this.bodyMats) m.emissive.setRGB(Math.max(m.emissive.r, flick), Math.max(m.emissive.g, flick * 0.35), m.emissive.b);
      this.burnTimer -= sdt;
      if (this.burnTimer <= 0) {
        this.burnTimer = 0.07;
        const at = pos.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.6, 0.7, (Math.random() - 0.5) * 0.6));
        emitSmoke(at, false);
        if (Math.random() < 0.6) emitEmbers(at, 1);
      }
    }

    // Team lights: steady when healthy, stutter when badly hurt or stunned, dark (with dying sputters) when destroyed.
    let lights = 1;
    if (dead) {
      this.sputter -= sdt;
      if (this.sputter <= 0) this.sputter = 0.4 + Math.random() * 1.6;
      lights = this.sputter < 0.06 ? 0.8 : 0;
      // A dying short: the occasional spit of embers off a wreck.
      if (this.sputter < 0.06 && b.eliminated === "destroyed" && Math.random() < 0.3) emitEmbers(pos.clone().setY(pos.y + 0.6), 2);
    } else if (hp < 0.3 && Math.sin(time * 37) + Math.sin(time * 23.7) > 1.3) lights = 0.15;
    else if (b.stun > 0) lights = Math.sin(time * 18) > 0 ? 1 : 0.25;
    const ready = b.weaponReady && !dead;
    if (ready && !this.prevReady) this.readyFlare = 1;
    this.prevReady = ready;
    this.readyFlare = Math.max(0, this.readyFlare - sdt * 2.2);
    this.teamGlow.emissiveIntensity = (3.2 + this.readyFlare * 3) * lights;
    this.lampMat.emissiveIntensity = 4 * lights;
    const ch = dead ? 0 : this.charge();
    this.leds.forEach((m, i) => {
      const fill = THREE.MathUtils.clamp(ch * 4 - i, 0, 1);
      const pulse = ch >= 0.999 ? 0.75 + 0.25 * Math.sin(time * 6) : 1;
      m.emissiveIntensity = (fill > 0.98 ? 3.2 * pulse : fill * 1.2) * lights + this.readyFlare * 2;
    });
    if (this.sensorLight) this.sensorLight.emissiveIntensity = !dead ? 0.6 + 0.8 * Math.max(0, Math.sin(time * 5)) : 0;

    // Floor markings: underglow breathes with danger, ring pulses when the brain feels threatened.
    const danger = b.intent.danger > 0.65 && !dead;
    this.ringMat.opacity = dead ? 0.12 : danger ? 0.55 + 0.4 * Math.max(0, Math.sin(time * 14)) : 0.75;
    this.chevronMat.opacity = dead ? 0 : 0.95;
    this.glowMat.opacity = dead ? 0.04 : (0.42 + this.readyFlare * 0.3) * (b.airborne ? Math.max(0.15, 1 - b.z * 0.6) : 1) * lights;
    this.glow.position.y = 0.018 - b.z; // stays on the floor while the bot is in the air
    this.ring.position.y = 0.024 - b.z;

    // Smoke when hurt or dead
    this.smokeTimer -= sdt;
    if (this.smokeTimer <= 0 && (hp < 0.4 || dead)) {
      this.smokeTimer = !dead ? 0.18 + hp * 0.4 : 0.08;
      emitSmoke(pos.clone().add(new THREE.Vector3(-Math.cos(b.heading) * 0.4, 0.6, Math.sin(b.heading) * 0.4)), dead);
    }

    /* ---- weapon rigs ---- */
    const w = b.weapon;
    if (this.blade) {
      this.blade.rotation.z -= sdt * (2 + w.spin * 70);
      if (this.pulley) this.pulley.rotation.y -= sdt * (2 + w.spin * 70) * 1.6;
      if (this.bladeBlur) this.bladeBlur.opacity = Math.max(0, w.spin - 0.3) * 0.5;
    }
    if (this.hammerArm) {
      let ang = 1.15; // raised
      let k = 80;
      let c = 16;
      if (w.hammerPhase === "windup") {
        ang = 1.15 + 0.5 * (1 - w.timer / 0.28); // anticipation: haul further back
        k = 140;
        c = 22;
      } else if (w.hammerPhase === "strike") {
        ang = -0.24;
        k = 1400;
        c = 22; // underdamped: slams through, bounces off the floor
      } else if (w.hammerPhase === "recover") {
        ang = -0.22 + 1.37 * Math.pow(1 - w.timer / 0.4, 2);
        k = 70;
        c = 14;
      } else if (w.cooldown > 0) ang = 1.15 - 0.15 * Math.sin(time * 2);
      if (w.hammerPhase === "strike" && this.prevPhase !== "strike") {
        this.pitch.v -= 2.5; // the whole bot kicks forward on the blow
        this.heave.v -= 1.2;
      }
      this.prevPhase = w.hammerPhase;
      const a = this.hammerSpring.step(ang, k, c, sdt);
      this.hammerArm.rotation.z = Math.max(-0.32, a);
    }
    if (this.jawL && this.jawR && this.clawUpper && this.clawFore) {
      const holding = !!b.holding;
      const open = holding ? 0.06 : w.cooldown > 0 ? 0.25 : 0.6 + Math.sin(time * 3) * 0.05;
      const jk = Math.min(1, sdt * (holding ? 20 : 10));
      this.jawL.rotation.y += (open - this.jawL.rotation.y) * jk;
      this.jawR.rotation.y += (-open - this.jawR.rotation.y) * jk;
      // Arm reaches out and down over the victim and pumps; at rest it's folded up like a scorpion tail.
      const pump = holding ? Math.sin(time * 12) * 0.08 : 0;
      const upTarget = holding ? 0.08 + pump : 0.85;
      const foreTarget = holding ? -1.05 - pump * 1.5 : -1.9;
      this.clawUpper.rotation.z += (upTarget - this.clawUpper.rotation.z) * Math.min(1, sdt * 9);
      this.clawFore.rotation.z += (foreTarget - this.clawFore.rotation.z) * Math.min(1, sdt * 9);
      if (this.clawLight) this.clawLight.emissiveIntensity = holding ? 1.5 + Math.sin(time * 12) * 1.2 : 0;
    }
    if (this.plate) {
      const a = w.flipAnim;
      const fired = a > 0.75 ? 1 : a > 0 ? Math.pow(a / 0.75, 0.6) : 0;
      // Rising edge: snap open with an overshoot, and blow off gas from the vent.
      // Rest: sloped down onto the wedge. Fired: swung up past vertical-ish (+z rotation lifts the front edge).
      const target = -0.18 + fired * 1.45;
      const k = target > this.plateSpring.x ? 1600 : 120;
      this.plateSpring.step(target, k, fired > 0.5 ? 26 : 18, sdt);
      this.plate.rotation.z = THREE.MathUtils.clamp(this.plateSpring.x, -0.22, 1.45);
      if (a > 0.9 && this.prevFlip <= 0.9 && this.ventAt) {
        const v = this.body.localToWorld(this.ventAt.clone());
        emitSmoke(v, false);
        emitSmoke(v, false);
        this.pitch.v += 2;
      }
      this.prevFlip = a;
    }
    if (this.bar) {
      this.bar.rotation.y += sdt * (1.5 + w.spin * 42);
      if (this.barBlur) this.barBlur.opacity = Math.max(0, w.spin - 0.25) * 0.38;
      // Gyroscopic precession: turning with the bar spun up leans the whole bot.
      this.roll.v += omega * w.spin * 0.7 * sdt;
    }
    if (this.flame && this.flameOuter && this.flameCore) {
      const firing = w.firing && !dead;
      this.flame.visible = firing;
      this.nozzleHeat = THREE.MathUtils.clamp(this.nozzleHeat + (firing ? sdt * 1.2 : -sdt * 0.4), 0, 1);
      if (this.nozzleMat) this.nozzleMat.emissiveIntensity = this.nozzleHeat * 2.2;
      if (this.pilot) {
        this.pilot.visible = !dead;
        const s = 0.8 + Math.sin(time * 41) * 0.15 + Math.sin(time * 27) * 0.1;
        this.pilot.scale.set(s * 1.4, s, s);
      }
      if (firing) {
        const flick = 0.85 + Math.sin(time * 47) * 0.1 + Math.sin(time * 29) * 0.05;
        this.flame.scale.set(0.75 + w.spin * 0.35, flick, flick);
        this.flameOuter.opacity = 0.4 + Math.random() * 0.2;
        this.flameOuter.color.setHSL(0.04 + Math.random() * 0.03, 1, 0.5);
        this.flameCore.opacity = 0.45 + Math.random() * 0.2;
        // Shimmer the streaks round the cone so the fire never sits still.
        if (this.flameOuter.map) this.flameOuter.map.offset.x = (time * 1.7) % 1;
        this.flame.rotation.x += sdt * 9;
      }
    }
    if (this.plow) {
      const boosting = w.boosting && !dead;
      this.plowSpring.step(boosting ? 0.12 : 0, boosting ? 400 : 120, 16, sdt);
      this.plow.position.x = this.plowSpring.x;
      const glow = boosting ? 1.6 + Math.sin(time * 40) * 0.4 : Math.max(0, this.exhaust[0].emissiveIntensity - sdt * 3);
      for (const m of this.exhaust) m.emissiveIntensity = glow;
      for (const j of this.exhaustFlames) {
        j.visible = boosting;
        if (boosting) j.scale.set(1, 0.7 + Math.random() * 0.6, 1);
      }
      if (boosting) {
        this.burnTimer -= sdt;
        if (this.burnTimer <= 0) {
          this.burnTimer = 0.05;
          emitSmoke(pos.clone().add(new THREE.Vector3(-Math.cos(b.heading) * 0.7, 1.2, Math.sin(b.heading) * 0.7)), false);
        }
      }
    }

    // Pistons last, once every moving part has its pose.
    if (this.pistons.length) {
      this.group.updateMatrixWorld(true);
      for (const p of this.pistons) p.update();
    }
  }
}

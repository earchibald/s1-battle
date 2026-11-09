import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { ARENA, padCharge, padSinceFire, pitOpenAmount, pitPhase, sawRaise, shockCharge, shockPhase, ventLevel, ventPhase } from "../sim/arena";
import type { Vec } from "../sim/math";

/** sim (x, y) -> three (x, h, -y). Sim "north" (+y) is away from the camera. */
export const toWorld = (p: Vec, h = 0) => new THREE.Vector3(p.x, h, -p.y);

/**
 * Everything static-ish in the arena: floor, walls, pit trapdoor, kill saws, stadium dressing,
 * lights, post-processing, and the cinematic camera.
 */
export class ArenaScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly composer: EffectComposer;
  readonly controls: OrbitControls;
  autoCamera = true;

  private pitDoors: THREE.Mesh[] = [];
  private pitGlow: THREE.Mesh;
  private pitLight: THREE.PointLight;
  private sawGroups: THREE.Group[] = [];
  private sawDiscs: THREE.Mesh[] = [];
  private sawLights: THREE.PointLight[] = [];
  private wallRail: THREE.MeshStandardMaterial;
  // traps
  private vents: { ring: THREE.MeshStandardMaterial; flame: THREE.Mesh; core: THREE.Mesh; light: THREE.PointLight }[] = [];
  private padHinge = new THREE.Group();
  private padArrows!: THREE.MeshBasicMaterial;
  private padLight!: THREE.PointLight;
  private shockPlates: { grid: THREE.MeshBasicMaterial; arcs: THREE.Line[]; posts: THREE.MeshStandardMaterial; light: THREE.PointLight }[] = [];

  // cinematic camera state
  private camAngle = Math.PI * 0.5 + 0.35;
  private camTarget = new THREE.Vector3(0, 0.5, 0);
  private camDist = 22;
  private shake = 0;
  private shakeSeed = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;

    this.scene.background = new THREE.Color(0x05060a);
    this.scene.fog = new THREE.FogExp2(0x05060a, 0.012);

    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);
    this.camera.position.set(0, 16, 24);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI * 0.47;
    this.controls.minDistance = 8;
    this.controls.maxDistance = 45;
    this.controls.enabled = false;

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.45, 0.4, 0.9);
    this.composer.addPass(bloom);
    this.composer.addPass(new OutputPass());

    this.buildLights();
    this.buildFloor();
    this.wallRail = this.buildWalls();
    const pit = this.buildPit();
    this.pitGlow = pit.glow;
    this.pitLight = pit.light;
    this.buildSaws();
    this.buildTraps();
    this.buildStadium();
    this.resize();
    window.addEventListener("resize", () => this.resize());
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
  }

  private buildLights() {
    this.scene.add(new THREE.HemisphereLight(0x6677bb, 0x101014, 0.9));
    const key = new THREE.DirectionalLight(0xfff2e0, 2.2);
    key.position.set(10, 22, 12);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.left = -16;
    key.shadow.camera.right = 16;
    key.shadow.camera.top = 16;
    key.shadow.camera.bottom = -16;
    key.shadow.camera.near = 5;
    key.shadow.camera.far = 60;
    key.shadow.bias = -0.0008;
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0x7fb0ff, 0.5);
    fill.position.set(-14, 12, -8);
    this.scene.add(fill);
    // Stadium spots, colored for drama.
    const spotColors = [0x66ccff, 0xff66aa, 0x66ccff, 0xff66aa];
    [
      [-14, -14],
      [14, -14],
      [14, 14],
      [-14, 14],
    ].forEach(([x, z], i) => {
      const s = new THREE.SpotLight(spotColors[i], 28, 60, 0.6, 0.6, 1.2);
      s.position.set(x, 18, z);
      s.target.position.set(0, 0, 0);
      this.scene.add(s, s.target);
    });
  }

  private floorTexture(): THREE.CanvasTexture {
    const size = 1024;
    const c = document.createElement("canvas");
    c.width = c.height = size;
    const g = c.getContext("2d")!;
    const px = size / (ARENA.half * 2);
    g.fillStyle = "#1b1e24";
    g.fillRect(0, 0, size, size);
    // Plate seams
    const plate = size / 11;
    for (let i = 0; i <= 11; i++) {
      g.strokeStyle = "rgba(0,0,0,0.55)";
      g.lineWidth = 3;
      g.beginPath();
      g.moveTo(i * plate, 0);
      g.lineTo(i * plate, size);
      g.moveTo(0, i * plate);
      g.lineTo(size, i * plate);
      g.stroke();
      g.strokeStyle = "rgba(255,255,255,0.05)";
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(i * plate + 2, 0);
      g.lineTo(i * plate + 2, size);
      g.moveTo(0, i * plate + 2);
      g.lineTo(size, i * plate + 2);
      g.stroke();
    }
    // Scuffs
    for (let i = 0; i < 900; i++) {
      g.fillStyle = `rgba(${120 + Math.random() * 60},${120 + Math.random() * 60},${130 + Math.random() * 60},${Math.random() * 0.08})`;
      const x = Math.random() * size;
      const y = Math.random() * size;
      g.fillRect(x, y, Math.random() * 40, 1 + Math.random() * 2);
    }
    // Center ring + logo
    g.strokeStyle = "rgba(90,200,255,0.35)";
    g.lineWidth = 6;
    g.beginPath();
    g.arc(size / 2, size / 2, 3.2 * px, 0, Math.PI * 2);
    g.stroke();
    g.fillStyle = "rgba(90,200,255,0.5)";
    g.font = `bold ${Math.round(px * 1.1)}px "Inter", system-ui, sans-serif`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.save();
    g.translate(size / 2, size / 2);
    g.fillText("S1 ARENA", 0, 0);
    g.restore();
    // Hazard stripes around pit and saw slots
    const stripes = (cx: number, cy: number, hw: number, hh: number) => {
      const x0 = (cx - hw + ARENA.half) * px;
      const y0 = (ARENA.half - (cy + hh)) * px;
      const w = hw * 2 * px;
      const h = hh * 2 * px;
      g.save();
      g.beginPath();
      g.rect(x0 - 18, y0 - 18, w + 36, h + 36);
      g.rect(x0, y0, w, h);
      g.clip("evenodd");
      for (let i = -size; i < size * 2; i += 28) {
        g.fillStyle = i % 56 === 0 ? "#f2c230" : "#1a1a1a";
        g.beginPath();
        g.moveTo(i, 0);
        g.lineTo(i + 28, 0);
        g.lineTo(i + 28 - size, size);
        g.lineTo(i - size, size);
        g.fill();
      }
      g.restore();
    };
    stripes(ARENA.pit.center.x, ARENA.pit.center.y, ARENA.pit.half, ARENA.pit.half);
    for (const s of ARENA.saws.slots) stripes(s.center.x, s.center.y, s.halfX, s.halfY);
    // Traps: stripes round the launch pad, scorched rings round the vents, a blue border round each shock plate.
    stripes(ARENA.pad.center.x, ARENA.pad.center.y, ARENA.pad.half, ARENA.pad.half);
    const fx = (x: number) => (x + ARENA.half) * px;
    const fy = (y: number) => (ARENA.half - y) * px;
    for (const v of ARENA.vents.slots) {
      const r = ARENA.vents.radius * px;
      const scorch = g.createRadialGradient(fx(v.x), fy(v.y), r * 0.6, fx(v.x), fy(v.y), r * 1.9);
      scorch.addColorStop(0, "rgba(0,0,0,0.75)");
      scorch.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = scorch;
      g.beginPath();
      g.arc(fx(v.x), fy(v.y), r * 1.9, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = "rgba(255,122,26,0.8)";
      g.lineWidth = 4;
      g.setLineDash([10, 8]);
      g.beginPath();
      g.arc(fx(v.x), fy(v.y), r + 6, 0, Math.PI * 2);
      g.stroke();
      g.setLineDash([]);
    }
    for (const sp of ARENA.shock.plates) {
      const h = ARENA.shock.half * px;
      g.strokeStyle = "rgba(102,221,255,0.85)";
      g.lineWidth = 5;
      g.strokeRect(fx(sp.center.x) - h - 6, fy(sp.center.y) - h - 6, h * 2 + 12, h * 2 + 12);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    return tex;
  }

  private buildFloor() {
    const tex = this.floorTexture();
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(ARENA.half * 2, ARENA.half * 2),
      new THREE.MeshStandardMaterial({ map: tex, roughness: 0.62, metalness: 0.55 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor);
    const outer = new THREE.Mesh(
      new THREE.PlaneGeometry(120, 120),
      new THREE.MeshStandardMaterial({ color: 0x0b0d12, roughness: 0.95, metalness: 0.1 }),
    );
    outer.rotation.x = -Math.PI / 2;
    outer.position.y = -0.02;
    outer.receiveShadow = true;
    this.scene.add(outer);
  }

  private buildWalls(): THREE.MeshStandardMaterial {
    const H = ARENA.half;
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x2a2e36, roughness: 0.5, metalness: 0.7 });
    const glassMat = new THREE.MeshPhysicalMaterial({
      color: 0x8ab6ff,
      transmission: 0.85,
      opacity: 0.35,
      transparent: true,
      roughness: 0.1,
      metalness: 0,
      thickness: 0.2,
    });
    const railMat = new THREE.MeshStandardMaterial({ color: 0x0b2b36, emissive: 0x33ccff, emissiveIntensity: 1.6 });
    const t = 0.35;
    const h = ARENA.wallHeight;
    const segs: [number, number, number, number][] = [
      [0, -H - t / 2, H * 2 + t * 2, t],
      [0, H + t / 2, H * 2 + t * 2, t],
      [-H - t / 2, 0, t, H * 2],
      [H + t / 2, 0, t, H * 2],
    ];
    for (const [x, z, w, d] of segs) {
      const base = new THREE.Mesh(new THREE.BoxGeometry(w, h * 0.45, d), wallMat);
      base.position.set(x, h * 0.225, z);
      base.castShadow = true;
      base.receiveShadow = true;
      this.scene.add(base);
      const glass = new THREE.Mesh(new THREE.BoxGeometry(w, h * 1.3, d * 0.3), glassMat);
      glass.position.set(x, h * 0.45 + h * 0.65, z);
      this.scene.add(glass);
      const rail = new THREE.Mesh(new THREE.BoxGeometry(w, 0.08, d * 0.5), railMat);
      rail.position.set(x, h * 0.45 + 0.04, z);
      this.scene.add(rail);
    }
    const pillarGeo = new THREE.CylinderGeometry(0.35, 0.45, h * 1.9, 12);
    for (const [x, z] of [
      [-H, -H],
      [H, -H],
      [H, H],
      [-H, H],
    ]) {
      const p = new THREE.Mesh(pillarGeo, wallMat);
      p.position.set(x, h * 0.95, z);
      p.castShadow = true;
      this.scene.add(p);
      const cap = new THREE.Mesh(new THREE.SphereGeometry(0.28, 12, 8), new THREE.MeshStandardMaterial({ color: 0x331111, emissive: 0xff3344, emissiveIntensity: 2 }));
      cap.position.set(x, h * 1.9 + 0.2, z);
      this.scene.add(cap);
    }
    return railMat;
  }

  private buildPit() {
    const { center, half } = ARENA.pit;
    const c = toWorld(center);
    const depth = 3;
    const hole = new THREE.Mesh(
      new THREE.BoxGeometry(half * 2, depth, half * 2),
      new THREE.MeshStandardMaterial({ color: 0x000000, roughness: 1, side: THREE.BackSide }),
    );
    hole.position.set(c.x, -depth / 2 - 0.01, c.z);
    this.scene.add(hole);
    const glow = new THREE.Mesh(
      new THREE.PlaneGeometry(half * 2 - 0.2, half * 2 - 0.2),
      new THREE.MeshBasicMaterial({ color: 0xff2a1a, transparent: true, opacity: 0.0 }),
    );
    glow.rotation.x = -Math.PI / 2;
    glow.position.set(c.x, -depth + 0.05, c.z);
    this.scene.add(glow);
    const light = new THREE.PointLight(0xff3020, 0, 10, 1.5);
    light.position.set(c.x, -0.4, c.z);
    this.scene.add(light);
    const doorMat = new THREE.MeshStandardMaterial({ color: 0x3a3f48, roughness: 0.45, metalness: 0.8 });
    for (const side of [-1, 1]) {
      const door = new THREE.Mesh(new THREE.BoxGeometry(half, 0.12, half * 2), doorMat);
      door.position.set(c.x + (side * half) / 2, 0.06, c.z);
      door.castShadow = true;
      door.receiveShadow = true;
      door.userData.side = side;
      this.scene.add(door);
      this.pitDoors.push(door);
    }
    const rimMat = new THREE.MeshStandardMaterial({ color: 0x331008, emissive: 0xff4422, emissiveIntensity: 0.4 });
    const rim = new THREE.Mesh(new THREE.BoxGeometry(half * 2 + 0.3, 0.05, half * 2 + 0.3), rimMat);
    rim.position.set(c.x, 0.025, c.z);
    this.scene.add(rim);
    this.pitGlow = glow;
    this.pitLight = light;
    (this as unknown as { pitRim: THREE.MeshStandardMaterial }).pitRim = rimMat;
    return { glow, light };
  }

  private buildSaws() {
    const bladeMat = new THREE.MeshStandardMaterial({ color: 0x7d838e, roughness: 0.45, metalness: 0.9 });
    const grateMat = new THREE.MeshStandardMaterial({ color: 0x0c0d10, roughness: 0.9, metalness: 0.3 });
    for (const s of ARENA.saws.slots) {
      const c = toWorld(s.center);
      const grate = new THREE.Mesh(new THREE.BoxGeometry(s.halfX * 2, 0.04, s.halfY * 2), grateMat);
      grate.position.set(c.x, 0.02, c.z);
      this.scene.add(grate);
      const group = new THREE.Group();
      group.position.set(c.x, -0.9, c.z);
      for (let i = 0; i < 4; i++) {
        const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.72, 0.72, 0.06, 28), bladeMat);
        disc.rotation.z = Math.PI / 2; // axis along x, blade lies in the y-z plane along the slot
        disc.position.set(0, 0, -s.halfY + 0.8 + i * ((s.halfY * 2 - 1.6) / 3));
        // teeth
        for (let t = 0; t < 14; t++) {
          const tooth = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.18, 0.14), bladeMat);
          const a = (t / 14) * Math.PI * 2;
          tooth.position.set(0, Math.cos(a) * 0.78, Math.sin(a) * 0.78);
          tooth.rotation.x = -a;
          disc.add(tooth);
        }
        group.add(disc);
        this.sawDiscs.push(disc);
      }
      const l = new THREE.PointLight(0xffaa44, 0, 6, 1.5);
      l.position.set(c.x, 0.6, c.z);
      this.scene.add(l);
      this.sawLights.push(l);
      this.scene.add(group);
      this.sawGroups.push(group);
    }
  }

  /** Flame vents, launch pad, shock plates. Geometry comes from ARENA; `updateArena` animates them. */
  private buildTraps() {
    // --- Flame vents: a grate, a ring that glows as a warning, and a flame cone that grows when lit.
    const grateMat = new THREE.MeshStandardMaterial({ color: 0x0c0d10, roughness: 0.9, metalness: 0.4 });
    const V = ARENA.vents;
    for (const slot of V.slots) {
      const c = toWorld(slot);
      const grate = new THREE.Mesh(new THREE.CylinderGeometry(V.radius, V.radius, 0.04, 28), grateMat);
      grate.position.set(c.x, 0.02, c.z);
      grate.receiveShadow = true;
      this.scene.add(grate);
      for (let i = -2; i <= 2; i++) {
        const w = Math.sqrt(Math.max(0.01, V.radius * V.radius - (i * 0.3) ** 2)) * 2 - 0.1;
        const bar = new THREE.Mesh(new THREE.BoxGeometry(w, 0.03, 0.07), new THREE.MeshStandardMaterial({ color: 0x3a3f48, roughness: 0.5, metalness: 0.8 }));
        bar.position.set(c.x, 0.05, c.z + i * 0.3);
        this.scene.add(bar);
      }
      const ringMat = new THREE.MeshStandardMaterial({ color: 0x2a1206, emissive: 0xff6a1a, emissiveIntensity: 0.25 });
      const ring = new THREE.Mesh(new THREE.TorusGeometry(V.radius, 0.06, 8, 36), ringMat);
      ring.rotation.x = Math.PI / 2;
      ring.position.set(c.x, 0.05, c.z);
      this.scene.add(ring);
      const flameMat = (color: number, opacity: number) =>
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
      const flame = new THREE.Mesh(new THREE.ConeGeometry(V.radius * 0.8, 1, 18, 1, true), flameMat(0xff5a12, 0.7));
      const core = new THREE.Mesh(new THREE.ConeGeometry(V.radius * 0.42, 1, 12, 1, true), flameMat(0xffe08a, 0.85));
      flame.position.set(c.x, 0, c.z);
      core.position.set(c.x, 0, c.z);
      flame.visible = core.visible = false;
      this.scene.add(flame, core);
      const light = new THREE.PointLight(0xff7a1a, 0, 7, 1.5);
      light.position.set(c.x, 1.0, c.z);
      this.scene.add(light);
      this.vents.push({ ring: ringMat, flame, core, light });
    }

    // --- Launch pad: a plate hinged on its south edge that snaps up toward the pit. Chevrons show the throw.
    const P = ARENA.pad;
    const pc = toWorld(P.center);
    const well = new THREE.Mesh(new THREE.BoxGeometry(P.half * 2, 0.02, P.half * 2), new THREE.MeshStandardMaterial({ color: 0x050506, roughness: 1 }));
    well.position.set(pc.x, 0.011, pc.z);
    this.scene.add(well);
    this.padHinge.position.set(pc.x, 0.02, pc.z + P.half); // south edge (sim -y is three +z)
    const plate = new THREE.Mesh(
      new THREE.BoxGeometry(P.half * 2 - 0.06, 0.1, P.half * 2 - 0.06),
      new THREE.MeshStandardMaterial({ color: 0x8a6a1c, roughness: 0.4, metalness: 0.85 }),
    );
    plate.position.set(0, 0.05, -P.half);
    plate.castShadow = true;
    plate.receiveShadow = true;
    this.padHinge.add(plate);
    const ac = document.createElement("canvas");
    ac.width = ac.height = 256;
    const ag = ac.getContext("2d")!;
    ag.strokeStyle = "#ffffff";
    ag.lineWidth = 22;
    ag.lineJoin = "miter";
    for (let i = 0; i < 3; i++) {
      const y = 70 + i * 62; // canvas top is north: the chevrons point at the pit
      ag.beginPath();
      ag.moveTo(56, y + 40);
      ag.lineTo(128, y - 20);
      ag.lineTo(200, y + 40);
      ag.stroke();
    }
    const arrowTex = new THREE.CanvasTexture(ac);
    this.padArrows = new THREE.MeshBasicMaterial({ map: arrowTex, color: 0xffd166, transparent: true, opacity: 0.35, depthWrite: false });
    const arrows = new THREE.Mesh(new THREE.PlaneGeometry(P.half * 2 - 0.2, P.half * 2 - 0.2), this.padArrows);
    arrows.rotation.x = -Math.PI / 2;
    arrows.position.set(0, 0.104, -P.half);
    this.padHinge.add(arrows);
    this.scene.add(this.padHinge);
    this.padLight = new THREE.PointLight(0xffc040, 0, 6, 1.5);
    this.padLight.position.set(pc.x, 0.7, pc.z);
    this.scene.add(this.padLight);

    // --- Shock plates: a dark panel with a glowing grid, four emitter posts, and arcs that crawl while charging.
    const S = ARENA.shock;
    const gc = document.createElement("canvas");
    gc.width = gc.height = 256;
    const gg = gc.getContext("2d")!;
    gg.strokeStyle = "#ffffff";
    gg.lineWidth = 5;
    for (let i = 0; i <= 6; i++) {
      const q = 8 + (i * 240) / 6;
      gg.beginPath();
      gg.moveTo(q, 8);
      gg.lineTo(q, 248);
      gg.moveTo(8, q);
      gg.lineTo(248, q);
      gg.stroke();
    }
    const gridTex = new THREE.CanvasTexture(gc);
    for (const sp of S.plates) {
      const c = toWorld(sp.center);
      const panel = new THREE.Mesh(new THREE.BoxGeometry(S.half * 2, 0.05, S.half * 2), new THREE.MeshStandardMaterial({ color: 0x10202c, roughness: 0.35, metalness: 0.9 }));
      panel.position.set(c.x, 0.025, c.z);
      panel.receiveShadow = true;
      this.scene.add(panel);
      const grid = new THREE.MeshBasicMaterial({ map: gridTex, color: 0x66ddff, transparent: true, opacity: 0.18, blending: THREE.AdditiveBlending, depthWrite: false });
      const gridMesh = new THREE.Mesh(new THREE.PlaneGeometry(S.half * 2, S.half * 2), grid);
      gridMesh.rotation.x = -Math.PI / 2;
      gridMesh.position.set(c.x, 0.056, c.z);
      this.scene.add(gridMesh);
      const posts = new THREE.MeshStandardMaterial({ color: 0x0b2b36, emissive: 0x66ddff, emissiveIntensity: 0.3 });
      for (const [sx, sz] of [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ]) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.12, 0.16, 10), posts);
        post.position.set(c.x + sx * (S.half + 0.12), 0.08, c.z + sz * (S.half + 0.12));
        this.scene.add(post);
      }
      const arcs: THREE.Line[] = [];
      for (let i = 0; i < 5; i++) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(7 * 3), 3));
        const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xbff3ff, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
        line.position.set(c.x, 0, c.z);
        line.visible = false;
        line.frustumCulled = false;
        this.scene.add(line);
        arcs.push(line);
      }
      const light = new THREE.PointLight(0x66ddff, 0, 8, 1.5);
      light.position.set(c.x, 0.8, c.z);
      this.scene.add(light);
      this.shockPlates.push({ grid, arcs, posts, light });
    }
  }

  private updateTraps(t: number) {
    // Vents: the ring blinks while a vent is about to light, then the flame stands up and flickers.
    this.vents.forEach((v, i) => {
      const phase = ventPhase(i, t);
      const level = ventLevel(i, t);
      const blink = Math.sin(t * 22) > 0 ? 1 : 0.3;
      v.ring.emissiveIntensity = phase === "erupting" ? 4 : phase === "warning" ? 0.6 + blink * 2.4 : 0.25;
      const lit = level > 0.01;
      v.flame.visible = v.core.visible = lit;
      if (lit) {
        const flick = 1 + Math.sin(t * 31 + i * 1.7) * 0.08 + Math.sin(t * 47 + i) * 0.05;
        const h = level * 3.0 * flick;
        const wide = 0.55 + level * 0.45;
        v.flame.scale.set(wide, h, wide);
        v.flame.position.y = h / 2;
        v.core.scale.set(wide, h * 0.7, wide);
        v.core.position.y = (h * 0.7) / 2;
      }
      v.light.intensity = phase === "erupting" ? 22 * level : level * 6;
    });

    // Launch pad: chevrons pulse faster as the charge builds; the plate snaps up on the kick and settles.
    const charge = padCharge(t);
    const since = padSinceFire(t);
    const kick = since < 0.07 ? since / 0.07 : since < 0.7 ? Math.max(0, 1 - (since - 0.07) / 0.63) ** 2 : 0;
    this.padHinge.rotation.x = kick * 0.85;
    const pulse = charge > 0 ? (Math.sin(t * (10 + charge * 30)) > 0 ? 1 : 0.35) : 0;
    this.padArrows.opacity = charge > 0 ? 0.35 + pulse * 0.65 : 0.3 + kick * 0.7;
    this.padLight.intensity = charge > 0 ? 2 + charge * 8 * pulse : kick * 25;

    // Shock plates: the grid brightens with charge, arcs crawl between random points, the discharge flashes.
    this.shockPlates.forEach((sp, i) => {
      const phase = shockPhase(i, t);
      const c = shockCharge(i, t);
      const live = phase === "live";
      sp.grid.opacity = live ? 1 : 0.18 + c * 0.6;
      sp.posts.emissiveIntensity = live ? 6 : 0.3 + c * 3;
      sp.light.intensity = live ? 45 : c * 7;
      const n = live ? sp.arcs.length : phase === "charging" ? 1 + Math.floor(c * 3) : 0;
      const half = ARENA.shock.half;
      sp.arcs.forEach((line, k) => {
        line.visible = k < n;
        if (!line.visible) return;
        const pos = line.geometry.getAttribute("position") as THREE.BufferAttribute;
        const a = { x: (Math.random() * 2 - 1) * half, z: (Math.random() * 2 - 1) * half };
        const b = { x: (Math.random() * 2 - 1) * half, z: (Math.random() * 2 - 1) * half };
        const tall = live ? 0.9 : 0.25 + c * 0.3;
        for (let j = 0; j < pos.count; j++) {
          const f = j / (pos.count - 1);
          const mid = Math.sin(f * Math.PI);
          pos.setXYZ(j, a.x + (b.x - a.x) * f + (Math.random() - 0.5) * 0.3 * mid, 0.08 + mid * tall * Math.random(), a.z + (b.z - a.z) * f + (Math.random() - 0.5) * 0.3 * mid);
        }
        pos.needsUpdate = true;
      });
    });
  }

  private buildStadium() {
    // A ring of light panels around the arena to give the bloom something to chew on.
    const n = 36;
    const r = 19;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const hue = i % 2 === 0 ? 0x1f6fff : 0xff2d7a;
      const m = new THREE.Mesh(
        new THREE.BoxGeometry(2.2, 0.5, 0.2),
        new THREE.MeshStandardMaterial({ color: 0x111111, emissive: hue, emissiveIntensity: 0.9 }),
      );
      m.position.set(Math.cos(a) * r, 0.5 + Math.sin(i * 1.7) * 0.15, Math.sin(a) * r);
      m.lookAt(0, 0.9, 0);
      this.scene.add(m);
      const stand = new THREE.Mesh(
        new THREE.BoxGeometry(2.4, 2.0, 1.2),
        new THREE.MeshStandardMaterial({ color: 0x15171c, roughness: 0.9 }),
      );
      stand.position.set(Math.cos(a) * (r + 1.2), 1.0, Math.sin(a) * (r + 1.2));
      stand.lookAt(0, 1.0, 0);
      this.scene.add(stand);
    }
  }

  /** Big hits shake the camera. */
  kick(amount: number) {
    this.shake = Math.min(1.2, this.shake + amount);
  }

  updateArena(fightTime: number, dt: number) {
    // Pit doors slide open/closed; the hole glows when live.
    const open = pitOpenAmount(fightTime);
    const phase = pitPhase(fightTime);
    for (const d of this.pitDoors) {
      const side = d.userData.side as number;
      d.position.x = ARENA.pit.center.x + (side * ARENA.pit.half) / 2 + side * open * (ARENA.pit.half + 0.1);
    }
    const warn = phase === "warning" ? (Math.sin(fightTime * 12) > 0 ? 1 : 0.2) : 0;
    const rim = (this as unknown as { pitRim: THREE.MeshStandardMaterial }).pitRim;
    rim.emissiveIntensity = phase === "open" ? 2.2 : 0.4 + warn * 1.8;
    (this.pitGlow.material as THREE.MeshBasicMaterial).opacity = open * 0.8;
    this.pitLight.intensity = open * 40;

    // Saws rise, spin, and glow.
    const raise = sawRaise(fightTime);
    for (const g of this.sawGroups) g.position.y = -0.95 + raise * 1.3;
    for (const d of this.sawDiscs) d.rotation.x += dt * (6 + raise * 30);
    for (const l of this.sawLights) l.intensity = raise * 5;
    this.wallRail.emissiveIntensity = 1.3 + Math.sin(fightTime * 2) * 0.3;
    this.updateTraps(fightTime);
  }

  /** Cinematic camera: frames the action, slowly orbits, shakes on hits. */
  updateCamera(focus: Vec[], dt: number, aggression = 0) {
    this.shake = Math.max(0, this.shake - dt * 2.2);
    this.shakeSeed += dt * 40;
    if (!this.autoCamera) {
      this.controls.enabled = true;
      this.controls.update();
      return;
    }
    this.controls.enabled = false;
    let cx = 0;
    let cz = 0;
    let radius = 6;
    if (focus.length) {
      for (const p of focus) {
        cx += p.x;
        cz += -p.y;
      }
      cx /= focus.length;
      cz /= focus.length;
      radius = 0;
      for (const p of focus) radius = Math.max(radius, Math.hypot(p.x - cx, -p.y - cz));
    }
    const wantDist = THREE.MathUtils.clamp(radius * 1.6 + 15 - aggression * 2.5, 19, 27);
    this.camDist += (wantDist - this.camDist) * Math.min(1, dt * 1.2);
    this.camTarget.x += (cx * 0.45 - this.camTarget.x) * Math.min(1, dt * 1.5);
    this.camTarget.z += (cz * 0.45 - this.camTarget.z) * Math.min(1, dt * 1.5);
    this.camAngle += dt * 0.05;
    const elev = 0.98 - aggression * 0.08;
    const sx = (Math.sin(this.shakeSeed * 1.3) + Math.sin(this.shakeSeed * 0.7)) * 0.5 * this.shake * 0.35;
    const sy = (Math.cos(this.shakeSeed * 1.1) + Math.sin(this.shakeSeed * 1.9)) * 0.5 * this.shake * 0.25;
    const pos = new THREE.Vector3(
      this.camTarget.x + Math.cos(this.camAngle) * this.camDist * Math.cos(elev),
      this.camDist * Math.sin(elev) + 1,
      this.camTarget.z + Math.sin(this.camAngle) * this.camDist * Math.cos(elev),
    );
    this.camera.position.lerp(pos, Math.min(1, dt * 2.5));
    this.camera.position.x += sx;
    this.camera.position.y += sy;
    this.camera.lookAt(this.camTarget.x + sx * 0.5, this.camTarget.y, this.camTarget.z);
  }

  render() {
    this.composer.render();
  }
}

import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { ARENA, pitOpenAmount, pitPhase, sawRaise } from "../sim/arena";
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

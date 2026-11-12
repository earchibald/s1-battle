import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { ARENA, padCharge, padSinceFire, pitOpenAmount, pitPhase, sawRaise, shockCharge, shockPhase, ventLevel, ventPhase } from "../sim/arena";
import type { Vec } from "../sim/math";
import { ArenaDressing, floorTextures } from "./arenaDressing";

/** sim (x, y) -> three (x, h, -y). Sim "north" (+y) is away from the camera. */
export const toWorld = (p: Vec, h = 0) => new THREE.Vector3(p.x, h, -p.y);

/** How strongly the room environment lights and reflects off everything (bots tune their materials against it). */
export const ENV_INTENSITY = 0.55;
/**
 * Linear HDR luminance a pixel needs before it blooms. Lit paint under the key tops out around 1.0–1.2, so
 * only real emissives (emissiveIntensity ≳ 2.5–3 on a saturated color, or HDR basic colors) glow.
 */
export const BLOOM_THRESHOLD = 1.45;

/** Vignette + gentle grade, applied in linear HDR before tone mapping. */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    vignette: { value: 0.42 },
    saturation: { value: 1.08 },
    lift: { value: new THREE.Vector3(0.0015, 0.0025, 0.006) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float vignette;
    uniform float saturation;
    uniform vec3 lift;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
      c.rgb = max(mix(vec3(l), c.rgb, saturation), 0.0);
      c.rgb += lift * (1.0 - smoothstep(0.0, 0.25, l));
      vec2 d = (vUv - 0.5) * vec2(1.0, 0.82);
      c.rgb *= 1.0 - vignette * smoothstep(0.2, 0.75, length(d) * 1.3);
      gl_FragColor = c;
    }`,
};

/**
 * Everything static-ish in the arena: floor, barrier, pit trapdoor, kill saws, traps, stadium dressing,
 * lights, post-processing, and the cinematic camera.
 */
export class ArenaScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly composer: EffectComposer;
  readonly controls: OrbitControls;
  autoCamera = true;

  private dressing: ArenaDressing;
  private pitDoors: THREE.Group[] = [];
  private pitGlow!: THREE.Mesh;
  private pitLight!: THREE.PointLight;
  private pitRim!: THREE.MeshStandardMaterial;
  private sawGroups: THREE.Group[] = [];
  private sawDiscs: THREE.Mesh[] = [];
  private sawLights: THREE.PointLight[] = [];
  private sawSlotGlow: THREE.MeshBasicMaterial[] = [];
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
    this.renderer.toneMappingExposure = 1.05;

    // Metals need something to reflect: a soft studio room, kept dim so the arena lights still lead.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    this.scene.environment = env;
    this.scene.environmentIntensity = ENV_INTENSITY;
    this.scene.background = this.backdrop();
    this.scene.fog = new THREE.FogExp2(0x070910, 0.014);

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
    // High threshold so only real emissives (rails, lenses, flames, arcs, visors) bloom, never lit paint or chrome.
    const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.5, 0.45, BLOOM_THRESHOLD);
    this.composer.addPass(bloom);
    this.composer.addPass(new ShaderPass(GradeShader));
    this.composer.addPass(new OutputPass());

    this.buildLights();
    this.dressing = new ArenaDressing(env);
    this.scene.add(this.dressing.group);
    this.wallRail = this.dressing.railMat;
    this.buildFloor();
    this.buildPit();
    this.buildSaws();
    this.buildTraps();
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

  /** A dark vertical gradient behind everything (only visible above the stands). */
  private backdrop(): THREE.Texture {
    const c = document.createElement("canvas");
    c.width = 4;
    c.height = 256;
    const g = c.getContext("2d")!;
    const grad = g.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, "#0c1222");
    grad.addColorStop(0.6, "#070910");
    grad.addColorStop(1, "#030407");
    g.fillStyle = grad;
    g.fillRect(0, 0, 4, 256);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  private buildLights() {
    // Low ambient: the environment map does most of the fill now.
    this.scene.add(new THREE.HemisphereLight(0x8090c0, 0x0c0d12, 0.35));
    // Overhead stadium key: near-vertical, neutral, the only shadow caster.
    const key = new THREE.DirectionalLight(0xfff6ea, 2.2);
    key.position.set(5, 26, 7);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.left = -13;
    key.shadow.camera.right = 13;
    key.shadow.camera.top = 13;
    key.shadow.camera.bottom = -13;
    key.shadow.camera.near = 8;
    key.shadow.camera.far = 45;
    key.shadow.bias = -0.0006;
    key.shadow.normalBias = 0.02;
    key.shadow.radius = 3;
    this.scene.add(key);
    // Colored rims from opposite low angles so silhouettes pick up a cyan / magenta edge.
    const rimA = new THREE.DirectionalLight(0x66c8ff, 0.9);
    rimA.position.set(-16, 7, -12);
    const rimB = new THREE.DirectionalLight(0xff5aa8, 0.6);
    rimB.position.set(16, 6, 12);
    this.scene.add(rimA, rimB);
    // Truss spots: soft pools of light on the floor, cool white.
    [
      [-12, -12],
      [12, -12],
      [12, 12],
      [-12, 12],
    ].forEach(([x, z]) => {
      const s = new THREE.SpotLight(0xdfe8ff, 22, 50, 0.55, 0.75, 1.2);
      s.position.set(x, 16, z);
      s.target.position.set(x * 0.25, 0, z * 0.25);
      this.scene.add(s, s.target);
    });
  }

  /** Floor plane with real openings for the pit and the saw slots (local plane coords = sim coords). */
  private buildFloor() {
    const H = ARENA.half;
    const rectPath = (cx: number, cy: number, hx: number, hy: number) => {
      const p = new THREE.Path();
      p.moveTo(cx - hx, cy - hy);
      p.lineTo(cx - hx, cy + hy);
      p.lineTo(cx + hx, cy + hy);
      p.lineTo(cx + hx, cy - hy);
      p.lineTo(cx - hx, cy - hy);
      return p;
    };
    const shape = new THREE.Shape();
    shape.moveTo(-H, -H);
    shape.lineTo(H, -H);
    shape.lineTo(H, H);
    shape.lineTo(-H, H);
    shape.lineTo(-H, -H);
    shape.holes.push(rectPath(ARENA.pit.center.x, ARENA.pit.center.y, ARENA.pit.half, ARENA.pit.half));
    for (const s of ARENA.saws.slots) shape.holes.push(rectPath(s.center.x, s.center.y, s.halfX, s.halfY));
    const geo = new THREE.ShapeGeometry(shape);
    const pos = geo.getAttribute("position") as THREE.BufferAttribute;
    const uv = geo.getAttribute("uv") as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) uv.setXY(i, (pos.getX(i) + H) / (2 * H), (pos.getY(i) + H) / (2 * H));
    const { map, rough } = floorTextures();
    // The floor reflects a dimmer room than the bots so it stays a mid-dark stage they read against.
    const floorMat = new THREE.MeshStandardMaterial({ map, roughnessMap: rough, roughness: 1, metalness: 0.35 });
    floorMat.envMap = this.scene.environment;
    floorMat.envMapIntensity = 0.22;
    const floor = new THREE.Mesh(geo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor);

    // Concourse floor outside the barrier (with the arena cut out so the pit stays open underneath).
    const outerShape = new THREE.Shape();
    outerShape.moveTo(-40, -40);
    outerShape.lineTo(40, -40);
    outerShape.lineTo(40, 40);
    outerShape.lineTo(-40, 40);
    outerShape.lineTo(-40, -40);
    outerShape.holes.push(rectPath(0, 0, H, H));
    const outer = new THREE.Mesh(new THREE.ShapeGeometry(outerShape), new THREE.MeshStandardMaterial({ color: 0x0a0b0f, roughness: 0.95, metalness: 0.1 }));
    outer.rotation.x = -Math.PI / 2;
    outer.position.y = -0.01;
    outer.receiveShadow = true;
    this.scene.add(outer);
  }

  /** Paint for a sunk shaft: hazard band at the lip, grimy walls fading into black. */
  private shaftTexture(tint: string): THREE.CanvasTexture {
    const c = document.createElement("canvas");
    c.width = 256;
    c.height = 256;
    const g = c.getContext("2d")!;
    const grad = g.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, tint);
    grad.addColorStop(0.55, "#0b0706");
    grad.addColorStop(1, "#000000");
    g.fillStyle = grad;
    g.fillRect(0, 0, 256, 256);
    g.fillStyle = "#d9a628";
    for (let i = -64; i < 320; i += 32) {
      g.beginPath();
      g.moveTo(i, 28);
      g.lineTo(i + 16, 28);
      g.lineTo(i + 30, 0);
      g.lineTo(i + 14, 0);
      g.fill();
    }
    for (let i = 0; i < 40; i++) {
      g.fillStyle = `rgba(0,0,0,${0.2 + Math.random() * 0.4})`;
      g.fillRect(Math.random() * 256, 28 + Math.random() * 120, 1 + Math.random() * 3, 20 + Math.random() * 80);
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  private buildPit() {
    const { center, half } = ARENA.pit;
    const c = toWorld(center);
    const depth = 3;
    // Shaft: painted inner walls (BackSide so we see them from above), dark floor.
    const wallMat = new THREE.MeshStandardMaterial({ map: this.shaftTexture("#3a1810"), roughness: 0.9, metalness: 0.2, side: THREE.BackSide });
    const dark = new THREE.MeshStandardMaterial({ color: 0x050303, roughness: 1, side: THREE.BackSide });
    const hole = new THREE.Mesh(new THREE.BoxGeometry(half * 2, depth, half * 2), [wallMat, wallMat, dark, dark, wallMat, wallMat]);
    hole.position.set(c.x, -depth / 2 - 0.005, c.z);
    this.scene.add(hole);
    // Glow at the bottom: a hot radial core.
    const gc = document.createElement("canvas");
    gc.width = gc.height = 128;
    const gg = gc.getContext("2d")!;
    const rg = gg.createRadialGradient(64, 64, 4, 64, 64, 64);
    rg.addColorStop(0, "rgba(255,200,120,1)");
    rg.addColorStop(0.35, "rgba(255,60,20,0.9)");
    rg.addColorStop(1, "rgba(120,0,0,0.25)");
    gg.fillStyle = rg;
    gg.fillRect(0, 0, 128, 128);
    const glow = new THREE.Mesh(
      new THREE.PlaneGeometry(half * 2 - 0.05, half * 2 - 0.05),
      new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(gc), color: 0xffffff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    glow.rotation.x = -Math.PI / 2;
    glow.position.set(c.x, -depth + 0.05, c.z);
    this.scene.add(glow);
    const light = new THREE.PointLight(0xff3020, 0, 10, 1.5);
    light.position.set(c.x, -0.6, c.z);
    this.scene.add(light);

    // Trapdoors: two leaves hinged at their outer edges, flush with the floor, that swing down into the shaft.
    const dc = document.createElement("canvas");
    dc.width = 256;
    dc.height = 512;
    const dg = dc.getContext("2d")!;
    dg.fillStyle = "#2c3038";
    dg.fillRect(0, 0, 256, 512);
    dg.save();
    dg.globalAlpha = 0.5;
    dg.fillStyle = "#b8871e";
    for (let i = -512; i < 768; i += 64) {
      dg.beginPath();
      dg.moveTo(i, 512);
      dg.lineTo(i + 32, 512);
      dg.lineTo(i + 32 + 512, 0);
      dg.lineTo(i + 512, 0);
      dg.fill();
    }
    dg.restore();
    dg.strokeStyle = "rgba(0,0,0,0.6)";
    dg.lineWidth = 10;
    dg.strokeRect(5, 5, 246, 502);
    dg.fillStyle = "#6a707b";
    for (const [x, y] of [
      [20, 20],
      [236, 20],
      [20, 492],
      [236, 492],
      [20, 256],
      [236, 256],
    ]) {
      dg.beginPath();
      dg.arc(x, y, 7, 0, Math.PI * 2);
      dg.fill();
    }
    const doorTex = new THREE.CanvasTexture(dc);
    doorTex.colorSpace = THREE.SRGBColorSpace;
    const doorMat = new THREE.MeshStandardMaterial({ map: doorTex, roughness: 0.5, metalness: 0.7 });
    for (const side of [-1, 1]) {
      const hinge = new THREE.Group();
      hinge.position.set(c.x + side * half, 0, c.z);
      const door = new THREE.Mesh(new THREE.BoxGeometry(half - 0.03, 0.1, half * 2 - 0.04), doorMat);
      door.position.set((-side * half) / 2, -0.05, 0);
      door.castShadow = true;
      door.receiveShadow = true;
      hinge.add(door);
      hinge.userData.side = side;
      this.scene.add(hinge);
      this.pitDoors.push(hinge);
    }
    // Lip: a steel frame round the opening that glows red when live.
    this.pitRim = new THREE.MeshStandardMaterial({ color: 0x2a0c06, emissive: 0xff3a1a, emissiveIntensity: 0.4, roughness: 0.5, metalness: 0.6 });
    const t = 0.08;
    for (const [x, z, w, d] of [
      [0, -half - t / 2, half * 2 + t * 2, t],
      [0, half + t / 2, half * 2 + t * 2, t],
      [-half - t / 2, 0, t, half * 2],
      [half + t / 2, 0, t, half * 2],
    ]) {
      const lip = new THREE.Mesh(new THREE.BoxGeometry(w, 0.04, d), this.pitRim);
      lip.position.set(c.x + x, 0.02, c.z + z);
      this.scene.add(lip);
    }
    this.pitGlow = glow;
    this.pitLight = light;
  }

  private buildSaws() {
    const bladeMat = new THREE.MeshStandardMaterial({ color: 0x9aa1ad, roughness: 0.3, metalness: 0.95 });
    const steel = new THREE.MeshStandardMaterial({ color: 0x3a3f48, roughness: 0.45, metalness: 0.85 });
    const shaftMat = new THREE.MeshStandardMaterial({ map: this.shaftTexture("#2a1a0c"), roughness: 0.9, metalness: 0.3, side: THREE.BackSide });
    const dark = new THREE.MeshStandardMaterial({ color: 0x050403, roughness: 1, side: THREE.BackSide });
    // One merged blade (disc + hub + teeth) lying in the y-z plane, spun about x.
    const parts: THREE.BufferGeometry[] = [new THREE.CylinderGeometry(0.72, 0.72, 0.06, 32).rotateZ(Math.PI / 2), new THREE.CylinderGeometry(0.16, 0.16, 0.12, 12).rotateZ(Math.PI / 2)];
    for (let t = 0; t < 14; t++) {
      const a = (t / 14) * Math.PI * 2;
      // a raked tooth: a wedge-ish box tangent to the rim
      parts.push(new THREE.BoxGeometry(0.07, 0.2, 0.13).rotateX(-a + 0.35).translate(0, Math.cos(a) * 0.76, Math.sin(a) * 0.76));
    }
    const bladeGeo = mergeGeometries(parts.map((g) => g.toNonIndexed()));
    for (const s of ARENA.saws.slots) {
      const c = toWorld(s.center);
      const depth = 2;
      const shaft = new THREE.Mesh(new THREE.BoxGeometry(s.halfX * 2, depth, s.halfY * 2), [shaftMat, shaftMat, dark, dark, shaftMat, shaftMat]);
      shaft.position.set(c.x, -depth / 2 - 0.005, c.z);
      this.scene.add(shaft);
      // Grate: cross bars either side of a center gap the blades come up through, plus the long rails.
      const gap = 0.13;
      const bars: THREE.BufferGeometry[] = [];
      const n = Math.floor((s.halfY * 2) / 0.32);
      for (let i = 0; i <= n; i++) {
        const z = -s.halfY + 0.08 + (i * (s.halfY * 2 - 0.16)) / n;
        for (const side of [-1, 1]) {
          const len = s.halfX - gap;
          const b = new THREE.BoxGeometry(len, 0.05, 0.06);
          b.translate(side * (gap + len / 2), -0.03, z);
          bars.push(b);
        }
      }
      for (const side of [-1, 1]) {
        const rail = new THREE.BoxGeometry(0.06, 0.07, s.halfY * 2);
        rail.translate(side * gap, -0.04, 0);
        bars.push(rail);
      }
      const grate = new THREE.Mesh(mergeGeometries(bars), steel);
      grate.position.set(c.x, 0, c.z);
      grate.receiveShadow = true;
      this.scene.add(grate);
      // A warm glow line in the gap while the saws are up.
      const glowMat = new THREE.MeshBasicMaterial({ color: 0xff8a2a, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
      glowMat.color.multiplyScalar(2);
      const glow = new THREE.Mesh(new THREE.PlaneGeometry(gap * 2, s.halfY * 2), glowMat);
      glow.rotation.x = -Math.PI / 2;
      glow.position.set(c.x, -0.25, c.z);
      this.scene.add(glow);
      this.sawSlotGlow.push(glowMat);

      const group = new THREE.Group();
      group.position.set(c.x, -0.9, c.z);
      for (let i = 0; i < 4; i++) {
        const disc = new THREE.Mesh(bladeGeo, bladeMat);
        disc.position.set(0, 0, -s.halfY + 0.8 + i * ((s.halfY * 2 - 1.6) / 3));
        disc.castShadow = true;
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
    const barMat = new THREE.MeshStandardMaterial({ color: 0x3a3f48, roughness: 0.5, metalness: 0.8 });
    for (const slot of V.slots) {
      const c = toWorld(slot);
      const grate = new THREE.Mesh(new THREE.CylinderGeometry(V.radius, V.radius, 0.04, 28), grateMat);
      grate.position.set(c.x, 0.02, c.z);
      grate.receiveShadow = true;
      this.scene.add(grate);
      const ventBars: THREE.BufferGeometry[] = [];
      for (let i = -2; i <= 2; i++) {
        const w = Math.sqrt(Math.max(0.01, V.radius * V.radius - (i * 0.3) ** 2)) * 2 - 0.1;
        ventBars.push(new THREE.BoxGeometry(w, 0.03, 0.07).translate(0, 0, i * 0.3));
      }
      const bars = new THREE.Mesh(mergeGeometries(ventBars), barMat);
      bars.position.set(c.x, 0.05, c.z);
      this.scene.add(bars);
      const ringMat = new THREE.MeshStandardMaterial({ color: 0x2a1206, emissive: 0xff6a1a, emissiveIntensity: 0.25 });
      const ring = new THREE.Mesh(new THREE.TorusGeometry(V.radius, 0.06, 8, 36), ringMat);
      ring.rotation.x = Math.PI / 2;
      ring.position.set(c.x, 0.05, c.z);
      this.scene.add(ring);
      // HDR colors (×2) so the flames clear the bloom threshold.
      const flameMat = (color: number, opacity: number) => {
        const m = new THREE.MeshBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
        m.color.multiplyScalar(2);
        return m;
      };
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
    this.padArrows.color.multiplyScalar(1.8);
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
      grid.color.multiplyScalar(2.2);
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
      v.ring.emissiveIntensity = phase === "erupting" ? 9 : phase === "warning" ? 0.8 + blink * 6 : 0.35;
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
      sp.grid.opacity = live ? 1 : 0.1 + c * 0.45;
      sp.posts.emissiveIntensity = live ? 14 : 0.5 + c * 6;
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

  /** Big hits shake the camera (and get the crowd on its feet). */
  kick(amount: number) {
    this.shake = Math.min(1.2, this.shake + amount);
    this.dressing.cheer(amount);
  }

  updateArena(fightTime: number, dt: number) {
    // Pit doors swing down into the shaft; the hole glows when live.
    const open = pitOpenAmount(fightTime);
    const phase = pitPhase(fightTime);
    const swing = open * 1.72;
    for (const d of this.pitDoors) d.rotation.z = (d.userData.side as number) * swing;
    const warn = phase === "warning" ? (Math.sin(fightTime * 12) > 0 ? 1 : 0.2) : 0;
    this.pitRim.emissiveIntensity = phase === "open" ? 6 + Math.sin(fightTime * 6) * 1.2 : 0.5 + warn * 6;
    (this.pitGlow.material as THREE.MeshBasicMaterial).opacity = open;
    this.pitLight.intensity = open * 40;

    // Saws rise, spin, and glow.
    const raise = sawRaise(fightTime);
    for (const g of this.sawGroups) g.position.y = -0.95 + raise * 1.3;
    for (const d of this.sawDiscs) d.rotation.x += dt * (6 + raise * 30);
    for (const l of this.sawLights) l.intensity = raise * 5;
    for (const m of this.sawSlotGlow) m.opacity = raise * 0.9;
    this.wallRail.emissiveIntensity = 2.3 + Math.sin(fightTime * 2) * 0.35;
    this.dressing.update(fightTime, dt, phase === "open" ? 2 : phase === "warning" ? 1 : 0);
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

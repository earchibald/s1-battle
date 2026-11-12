import * as THREE from "three";

/**
 * Punchy, pooled particle effects. Nothing here allocates per frame:
 *
 *   sparks   – velocity-stretched streaks (LineSegments) with a glowing head dot; they cool from
 *              white-hot through their tint to dark red as they die, and bounce off the floor.
 *              Embers share the pool with negative gravity and a slow wobble.
 *   smoke    – soft, rotating, growing puffs (a Points shader with per-particle size/alpha/rotation).
 *   debris   – tumbling chunks (one InstancedMesh) that bounce, skid and settle, then shrink away.
 *   scorch   – dark radial decals on the floor that fade over ~20 s.
 *   rings    – floor shockwaves: a thin bright leading edge over a soft fill, eased outward.
 *   flashes  – a few short-lived point lights for hit illumination.
 */

const tmpColor = new THREE.Color();
const tmpObj = new THREE.Object3D();

function canvasTex(size: number, draw: (g: CanvasRenderingContext2D, s: number) => void): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  draw(c.getContext("2d")!, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const softDot = () =>
  canvasTex(64, (g, s) => {
    const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grad.addColorStop(0, "rgba(255,255,255,1)");
    grad.addColorStop(0.25, "rgba(255,255,255,0.75)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, s, s);
  });

/** A lumpy cloud: several overlapping soft blobs, so a rotating puff doesn't read as a perfect disc. */
const puffTex = () =>
  canvasTex(128, (g, s) => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 9; i++) {
      const a = rnd() * Math.PI * 2;
      const d = rnd() * s * 0.2;
      const x = s / 2 + Math.cos(a) * d;
      const y = s / 2 + Math.sin(a) * d;
      const r = s * (0.14 + rnd() * 0.14);
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, "rgba(255,255,255,0.5)");
      grad.addColorStop(0.55, "rgba(255,255,255,0.2)");
      grad.addColorStop(1, "rgba(255,255,255,0)");
      g.fillStyle = grad;
      g.fillRect(0, 0, s, s);
    }
  });

/** Shockwave ring texture: soft fill toward a crisp bright rim at the outer edge. */
const ringTex = () =>
  canvasTex(256, (g, s) => {
    const c = s / 2;
    const grad = g.createRadialGradient(c, c, 0, c, c, c);
    grad.addColorStop(0, "rgba(255,255,255,0)");
    grad.addColorStop(0.55, "rgba(255,255,255,0.05)");
    grad.addColorStop(0.86, "rgba(255,255,255,0.22)");
    grad.addColorStop(0.93, "rgba(255,255,255,1)");
    grad.addColorStop(0.965, "rgba(255,255,255,0.55)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, s, s);
  });

/** Scorch decal: a sooty center with a ragged, streaky edge. Drawn white; the material tints it black. */
const scorchTex = () =>
  canvasTex(256, (g, s) => {
    const c = s / 2;
    const grad = g.createRadialGradient(c, c, 0, c, c, c);
    grad.addColorStop(0, "rgba(255,255,255,0.95)");
    grad.addColorStop(0.35, "rgba(255,255,255,0.8)");
    grad.addColorStop(0.7, "rgba(255,255,255,0.3)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, s, s);
    g.strokeStyle = "rgba(255,255,255,0.35)";
    g.lineCap = "round";
    for (let i = 0; i < 26; i++) {
      const a = (i / 26) * Math.PI * 2 + Math.sin(i * 12.9) * 0.2;
      const r0 = s * 0.12;
      const r1 = s * (0.32 + ((Math.sin(i * 78.2) + 1) / 2) * 0.16);
      g.lineWidth = 2 + ((Math.sin(i * 3.7) + 1) / 2) * 6;
      g.beginPath();
      g.moveTo(c + Math.cos(a) * r0, c + Math.sin(a) * r0);
      g.lineTo(c + Math.cos(a) * r1, c + Math.sin(a) * r1);
      g.stroke();
    }
  });

/* --------------------------------------------------------------------------------------- sparks -- */

/** Structure-of-arrays pool of streak particles. Dead particles are swap-removed. */
class SparkPool {
  readonly lines: THREE.LineSegments;
  readonly heads: THREE.Points;
  private n = 0;
  private readonly p: Float32Array; // x y z
  private readonly v: Float32Array; // vx vy vz
  private readonly c: Float32Array; // tint r g b
  private readonly life: Float32Array;
  private readonly maxLife: Float32Array;
  private readonly grav: Float32Array;
  private readonly linePos: Float32Array;
  private readonly lineCol: Float32Array;
  private readonly headPos: Float32Array;
  private readonly headCol: Float32Array;

  constructor(readonly max: number) {
    this.p = new Float32Array(max * 3);
    this.v = new Float32Array(max * 3);
    this.c = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.grav = new Float32Array(max);
    this.linePos = new Float32Array(max * 6);
    this.lineCol = new Float32Array(max * 6);
    this.headPos = new Float32Array(max * 3);
    this.headCol = new Float32Array(max * 3);
    const lg = new THREE.BufferGeometry();
    lg.setAttribute("position", new THREE.BufferAttribute(this.linePos, 3).setUsage(THREE.DynamicDrawUsage));
    lg.setAttribute("color", new THREE.BufferAttribute(this.lineCol, 3).setUsage(THREE.DynamicDrawUsage));
    this.lines = new THREE.LineSegments(
      lg,
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
    );
    this.lines.frustumCulled = false;
    const hg = new THREE.BufferGeometry();
    hg.setAttribute("position", new THREE.BufferAttribute(this.headPos, 3).setUsage(THREE.DynamicDrawUsage));
    hg.setAttribute("color", new THREE.BufferAttribute(this.headCol, 3).setUsage(THREE.DynamicDrawUsage));
    this.heads = new THREE.Points(
      hg,
      new THREE.PointsMaterial({ size: 0.11, map: softDot(), vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true, toneMapped: false }),
    );
    this.heads.frustumCulled = false;
  }

  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, r: number, g: number, b: number, gravity: number) {
    let i = this.n;
    if (i >= this.max) i = Math.floor(Math.random() * this.max); // full: overwrite a random one
    else this.n++;
    const k = i * 3;
    this.p[k] = x;
    this.p[k + 1] = y;
    this.p[k + 2] = z;
    this.v[k] = vx;
    this.v[k + 1] = vy;
    this.v[k + 2] = vz;
    this.c[k] = r;
    this.c[k + 1] = g;
    this.c[k + 2] = b;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.grav[i] = gravity;
  }

  private kill(i: number) {
    const last = --this.n;
    if (i === last) return;
    const k = i * 3;
    const l = last * 3;
    for (let j = 0; j < 3; j++) {
      this.p[k + j] = this.p[l + j];
      this.v[k + j] = this.v[l + j];
      this.c[k + j] = this.c[l + j];
    }
    this.life[i] = this.life[last];
    this.maxLife[i] = this.maxLife[last];
    this.grav[i] = this.grav[last];
  }

  update(dt: number, time: number) {
    for (let i = this.n - 1; i >= 0; i--) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) this.kill(i);
    }
    const { p, v } = this;
    for (let i = 0; i < this.n; i++) {
      const k = i * 3;
      const gr = this.grav[i];
      v[k + 1] -= gr * dt;
      if (gr < 0) {
        // Embers: drift and wobble on the heat, with drag so they float rather than rocket.
        v[k] += Math.sin(time * 5 + i) * dt * 1.6;
        v[k + 2] += Math.cos(time * 4 + i * 1.3) * dt * 1.6;
        const drag = Math.exp(-dt * 1.5);
        v[k] *= drag;
        v[k + 2] *= drag;
      }
      p[k] += v[k] * dt;
      p[k + 1] += v[k + 1] * dt;
      p[k + 2] += v[k + 2] * dt;
      if (p[k + 1] < 0.02 && gr > 0) {
        p[k + 1] = 0.02;
        v[k + 1] *= -0.3;
        v[k] *= 0.6;
        v[k + 2] *= 0.6;
      }
      // Heat: 1 = just born (white-hot), 0 = dead (dull red, then nothing).
      const t = this.life[i] / this.maxLife[i];
      const hot = Math.max(0, (t - 0.82) / 0.18) ** 1.5; // a brief white-hot flash, then the tint
      const fade = Math.min(1, t * 2.2);
      const cr = this.c[k];
      const cg = this.c[k + 1];
      const cb = this.c[k + 2];
      // Blend tint toward white while hot; toward deep red as it cools.
      const cool = 1 - Math.min(1, t * 1.6);
      const r = (cr + (1 - cr) * hot) * fade;
      const g = (cg * (1 - cool * 0.75) + (1 - cg) * hot) * fade;
      const b = (cb * (1 - cool) + (1 - cb) * hot) * fade;
      // Streak: head at the particle, tail trailing along velocity (longer when fast, capped).
      const sx = v[k];
      const sy = v[k + 1];
      const sz = v[k + 2];
      const sp = Math.hypot(sx, sy, sz);
      const len = gr < 0 ? 0.05 : Math.min(0.34, sp * 0.032);
      const inv = sp > 1e-4 ? len / sp : 0;
      const o = i * 6;
      this.linePos[o] = p[k];
      this.linePos[o + 1] = p[k + 1];
      this.linePos[o + 2] = p[k + 2];
      this.linePos[o + 3] = p[k] - sx * inv;
      this.linePos[o + 4] = p[k + 1] - sy * inv;
      this.linePos[o + 5] = p[k + 2] - sz * inv;
      this.lineCol[o] = r;
      this.lineCol[o + 1] = g;
      this.lineCol[o + 2] = b;
      this.lineCol[o + 3] = r * 0.15;
      this.lineCol[o + 4] = g * 0.1;
      this.lineCol[o + 5] = b * 0.08;
      this.headPos[k] = p[k];
      this.headPos[k + 1] = p[k + 1];
      this.headPos[k + 2] = p[k + 2];
      this.headCol[k] = r * 0.7;
      this.headCol[k + 1] = g * 0.7;
      this.headCol[k + 2] = b * 0.7;
    }
    const lg = this.lines.geometry;
    lg.setDrawRange(0, this.n * 2);
    (lg.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (lg.attributes.color as THREE.BufferAttribute).needsUpdate = true;
    const hg = this.heads.geometry;
    hg.setDrawRange(0, this.n);
    (hg.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (hg.attributes.color as THREE.BufferAttribute).needsUpdate = true;
  }
}

/* ---------------------------------------------------------------------------------------- smoke -- */

const SMOKE_VERT = /* glsl */ `
  attribute float aSize;
  attribute float aAlpha;
  attribute float aRot;
  attribute vec3 aColor;
  uniform float uScale;
  varying float vAlpha;
  varying float vRot;
  varying vec3 vColor;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = aSize * uScale * projectionMatrix[1][1] / max(0.1, -mv.z);
    vAlpha = aAlpha;
    vRot = aRot;
    vColor = aColor;
  }`;
const SMOKE_FRAG = /* glsl */ `
  uniform sampler2D uMap;
  varying float vAlpha;
  varying float vRot;
  varying vec3 vColor;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float s = sin(vRot), k = cos(vRot);
    vec2 uv = vec2(k * c.x - s * c.y, s * c.x + k * c.y) + 0.5;
    float a = texture2D(uMap, uv).a * vAlpha;
    if (a < 0.004) discard;
    gl_FragColor = vec4(vColor, a);
  }`;

class SmokePool {
  readonly points: THREE.Points;
  private n = 0;
  private readonly p: Float32Array;
  private readonly v: Float32Array;
  private readonly life: Float32Array;
  private readonly maxLife: Float32Array;
  private readonly size0: Float32Array;
  private readonly alpha0: Float32Array;
  private readonly spin: Float32Array;
  private readonly shade: Float32Array;
  private readonly aPos: Float32Array;
  private readonly aSize: Float32Array;
  private readonly aAlpha: Float32Array;
  private readonly aRot: Float32Array;
  private readonly aColor: Float32Array;
  private readonly mat: THREE.ShaderMaterial;

  constructor(readonly max: number) {
    this.p = new Float32Array(max * 3);
    this.v = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.size0 = new Float32Array(max);
    this.alpha0 = new Float32Array(max);
    this.spin = new Float32Array(max);
    this.shade = new Float32Array(max * 3);
    this.aPos = new Float32Array(max * 3);
    this.aSize = new Float32Array(max);
    this.aAlpha = new Float32Array(max);
    this.aRot = new Float32Array(max);
    this.aColor = new Float32Array(max * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(this.aPos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute("aSize", new THREE.BufferAttribute(this.aSize, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute("aAlpha", new THREE.BufferAttribute(this.aAlpha, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute("aRot", new THREE.BufferAttribute(this.aRot, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute("aColor", new THREE.BufferAttribute(this.aColor, 3).setUsage(THREE.DynamicDrawUsage));
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: puffTex() }, uScale: { value: 400 } },
      vertexShader: SMOKE_VERT,
      fragmentShader: SMOKE_FRAG,
      transparent: true,
      depthWrite: false,
    });
    this.points = new THREE.Points(geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 2;
  }

  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, size: number, alpha: number, r: number, g: number, b: number) {
    let i = this.n;
    if (i >= this.max) i = Math.floor(Math.random() * this.max);
    else this.n++;
    const k = i * 3;
    this.p[k] = x;
    this.p[k + 1] = y;
    this.p[k + 2] = z;
    this.v[k] = vx;
    this.v[k + 1] = vy;
    this.v[k + 2] = vz;
    this.shade[k] = r;
    this.shade[k + 1] = g;
    this.shade[k + 2] = b;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.size0[i] = size;
    this.alpha0[i] = alpha;
    this.spin[i] = (Math.random() - 0.5) * 1.2;
    this.aRot[i] = Math.random() * Math.PI * 2;
  }

  private kill(i: number) {
    const last = --this.n;
    if (i === last) return;
    const k = i * 3;
    const l = last * 3;
    for (let j = 0; j < 3; j++) {
      this.p[k + j] = this.p[l + j];
      this.v[k + j] = this.v[l + j];
      this.shade[k + j] = this.shade[l + j];
    }
    this.life[i] = this.life[last];
    this.maxLife[i] = this.maxLife[last];
    this.size0[i] = this.size0[last];
    this.alpha0[i] = this.alpha0[last];
    this.spin[i] = this.spin[last];
    this.aRot[i] = this.aRot[last];
  }

  update(dt: number) {
    // Points are sized in pixels; scale by drawing-buffer height so puffs keep their world size.
    this.mat.uniforms.uScale.value = window.innerHeight * Math.min(window.devicePixelRatio, 2) * 0.5;
    for (let i = this.n - 1; i >= 0; i--) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) this.kill(i);
    }
    const drag = Math.exp(-dt * 0.9);
    for (let i = 0; i < this.n; i++) {
      const k = i * 3;
      this.v[k] *= drag;
      this.v[k + 2] *= drag;
      this.v[k + 1] = this.v[k + 1] * Math.exp(-dt * 0.4) + dt * 0.25; // buoyancy, slowing as it cools
      this.p[k] += this.v[k] * dt;
      this.p[k + 1] += this.v[k + 1] * dt;
      this.p[k + 2] += this.v[k + 2] * dt;
      const age = 1 - this.life[i] / this.maxLife[i]; // 0 → 1
      this.aPos[k] = this.p[k];
      this.aPos[k + 1] = this.p[k + 1];
      this.aPos[k + 2] = this.p[k + 2];
      this.aSize[i] = this.size0[i] * (0.55 + age * 2.1);
      // Quick fade in, long fade out.
      this.aAlpha[i] = this.alpha0[i] * Math.min(1, age * 8) * (1 - age) ** 1.4;
      this.aRot[i] += this.spin[i] * dt;
      // Smoke lightens a little as it thins out.
      const lift = age * 0.08;
      this.aColor[k] = this.shade[k] + lift;
      this.aColor[k + 1] = this.shade[k + 1] + lift;
      this.aColor[k + 2] = this.shade[k + 2] + lift;
    }
    const geo = this.points.geometry;
    geo.setDrawRange(0, this.n);
    for (const name of ["position", "aSize", "aAlpha", "aRot", "aColor"]) (geo.attributes[name] as THREE.BufferAttribute).needsUpdate = true;
  }
}

/* --------------------------------------------------------------------------------------- debris -- */

class DebrisPool {
  readonly mesh: THREE.InstancedMesh;
  private n = 0;
  private readonly p: Float32Array;
  private readonly v: Float32Array;
  private readonly rot: Float32Array;
  private readonly av: Float32Array;
  private readonly scl: Float32Array; // x y z per chunk
  private readonly life: Float32Array;
  private readonly col: Float32Array;

  constructor(readonly max: number) {
    // A chipped wedge reads as "broken armor" better than a cube.
    const geo = new THREE.CylinderGeometry(0.5, 0.5, 1, 3, 1);
    geo.rotateZ(Math.PI / 2);
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.45, metalness: 0.7 });
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.p = new Float32Array(max * 3);
    this.v = new Float32Array(max * 3);
    this.rot = new Float32Array(max * 3);
    this.av = new Float32Array(max * 3);
    this.scl = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.col = new Float32Array(max * 3);
  }

  emit(at: THREE.Vector3, dir: THREE.Vector3, speed: number, color: THREE.Color, sizeMul: number) {
    let i = this.n;
    if (i >= this.max) i = Math.floor(Math.random() * this.max);
    else this.n++;
    const k = i * 3;
    this.p[k] = at.x + (Math.random() - 0.5) * 0.3;
    this.p[k + 1] = at.y + Math.random() * 0.2;
    this.p[k + 2] = at.z + (Math.random() - 0.5) * 0.3;
    const s = speed * (0.5 + Math.random() * 0.8);
    this.v[k] = dir.x * s + (Math.random() - 0.5) * 2.4;
    this.v[k + 1] = 2.5 + Math.random() * 3.5 * Math.min(1.5, speed / 4);
    this.v[k + 2] = dir.z * s + (Math.random() - 0.5) * 2.4;
    for (let j = 0; j < 3; j++) {
      this.rot[k + j] = Math.random() * Math.PI * 2;
      this.av[k + j] = (Math.random() - 0.5) * 22;
    }
    const base = (0.06 + Math.random() * 0.1) * sizeMul;
    this.scl[k] = base * (1 + Math.random());
    this.scl[k + 1] = base * (0.6 + Math.random() * 0.5);
    this.scl[k + 2] = base * (0.8 + Math.random() * 0.8);
    this.life[i] = 3.5 + Math.random() * 3;
    // Mostly the bot's paint; some bare steel and some soot.
    const roll = Math.random();
    if (roll < 0.25) tmpColor.setRGB(0.55, 0.57, 0.6);
    else if (roll < 0.4) tmpColor.setRGB(0.08, 0.08, 0.09);
    else tmpColor.copy(color).multiplyScalar(0.75 + Math.random() * 0.3);
    this.col[k] = tmpColor.r;
    this.col[k + 1] = tmpColor.g;
    this.col[k + 2] = tmpColor.b;
  }

  private kill(i: number) {
    const last = --this.n;
    if (i === last) return;
    const k = i * 3;
    const l = last * 3;
    for (let j = 0; j < 3; j++) {
      this.p[k + j] = this.p[l + j];
      this.v[k + j] = this.v[l + j];
      this.rot[k + j] = this.rot[l + j];
      this.av[k + j] = this.av[l + j];
      this.scl[k + j] = this.scl[l + j];
      this.col[k + j] = this.col[l + j];
    }
    this.life[i] = this.life[last];
  }

  update(dt: number) {
    for (let i = this.n - 1; i >= 0; i--) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) this.kill(i);
    }
    const { p, v, rot, av } = this;
    for (let i = 0; i < this.n; i++) {
      const k = i * 3;
      v[k + 1] -= 16 * dt;
      p[k] += v[k] * dt;
      p[k + 1] += v[k + 1] * dt;
      p[k + 2] += v[k + 2] * dt;
      const floor = this.scl[k + 1] * 0.5;
      if (p[k + 1] < floor) {
        p[k + 1] = floor;
        if (v[k + 1] < -1) {
          v[k + 1] *= -0.38;
          v[k] *= 0.65;
          v[k + 2] *= 0.65;
          for (let j = 0; j < 3; j++) av[k + j] *= 0.6;
        } else {
          // Resting: skid to a stop and lie flat-ish.
          v[k + 1] = 0;
          const f = Math.exp(-dt * 6);
          v[k] *= f;
          v[k + 2] *= f;
          av[k] *= f;
          av[k + 1] *= f;
          av[k + 2] *= f;
          rot[k] += (Math.round(rot[k] / Math.PI) * Math.PI - rot[k]) * Math.min(1, dt * 6);
          rot[k + 2] += (Math.round(rot[k + 2] / Math.PI) * Math.PI - rot[k + 2]) * Math.min(1, dt * 6);
        }
      }
      rot[k] += av[k] * dt;
      rot[k + 1] += av[k + 1] * dt;
      rot[k + 2] += av[k + 2] * dt;
      const shrink = Math.min(1, this.life[i] / 0.8);
      tmpObj.position.set(p[k], p[k + 1], p[k + 2]);
      tmpObj.rotation.set(rot[k], rot[k + 1], rot[k + 2]);
      tmpObj.scale.set(this.scl[k] * shrink, this.scl[k + 1] * shrink, this.scl[k + 2] * shrink);
      tmpObj.updateMatrix();
      this.mesh.setMatrixAt(i, tmpObj.matrix);
      this.mesh.instanceColor!.setXYZ(i, this.col[k], this.col[k + 1], this.col[k + 2]);
    }
    this.mesh.count = this.n;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor!.needsUpdate = true;
  }
}

/* -------------------------------------------------------------------------------------- effects -- */

interface Ring {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  life: number;
  max: number;
  from: number;
  to: number;
}
interface Scorch {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  /** Additive orange copy that glows like hot metal for the first couple of seconds. */
  heat: THREE.Mesh;
  heatMat: THREE.MeshBasicMaterial;
  life: number;
  strength: number;
}

const SCORCH_LIFE = 20;
const SCORCH_HEAT = 2.5;

export class Effects {
  readonly group = new THREE.Group();
  private sparks = new SparkPool(1400);
  private smoke = new SmokePool(500);
  private chunks = new DebrisPool(220);
  private rings: Ring[] = [];
  private ringNext = 0;
  private scorches: Scorch[] = [];
  private scorchNext = 0;
  private flashes: { light: THREE.PointLight; life: number }[] = [];
  private time = 0;
  private v = new THREE.Vector3();

  constructor() {
    this.group.add(this.sparks.lines, this.sparks.heads, this.smoke.points, this.chunks.mesh);
    const rt = ringTex();
    const plane = new THREE.PlaneGeometry(2, 2);
    plane.rotateX(-Math.PI / 2);
    for (let i = 0; i < 16; i++) {
      const mat = new THREE.MeshBasicMaterial({ map: rt, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
      const mesh = new THREE.Mesh(plane, mat);
      mesh.visible = false;
      mesh.renderOrder = 1;
      this.group.add(mesh);
      this.rings.push({ mesh, mat, life: 0, max: 1, from: 0, to: 1 });
    }
    const st = scorchTex();
    for (let i = 0; i < 28; i++) {
      const mat = new THREE.MeshBasicMaterial({
        map: st,
        color: 0x000000,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      });
      const mesh = new THREE.Mesh(plane, mat);
      mesh.visible = false;
      const heatMat = new THREE.MeshBasicMaterial({ map: st, color: 0xff5a10, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
      const heat = new THREE.Mesh(plane, heatMat);
      heat.scale.setScalar(0.45);
      heat.position.y = 0.002;
      mesh.add(heat);
      this.group.add(mesh);
      this.scorches.push({ mesh, mat, heat, heatMat, life: 0, strength: 0 });
    }
    for (let i = 0; i < 6; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 9, 1.8);
      this.group.add(l);
      this.flashes.push({ light: l, life: 0 });
    }
  }

  /** Burst of streaking sparks at a point. `dir` is the rough direction of the hit; intensity 0..1. */
  sparkBurst(at: THREE.Vector3, dir: THREE.Vector3, intensity: number, color: THREE.Color | number = 0xffc864) {
    const c = tmpColor.set(color);
    const r = c.r;
    const g = c.g;
    const b = c.b;
    const n = Math.round(10 + intensity * 48);
    for (let i = 0; i < n; i++) {
      const sx = (Math.random() - 0.5) * 2;
      const sy = Math.random() * 1.0 + 0.25;
      const sz = (Math.random() - 0.5) * 2;
      const fwd = 2 + Math.random() * 6 * intensity;
      const spread = 2.5 + intensity * 4.5;
      this.sparks.emit(
        at.x + (Math.random() - 0.5) * 0.25,
        at.y + Math.random() * 0.25,
        at.z + (Math.random() - 0.5) * 0.25,
        dir.x * fwd + sx * spread,
        dir.y * fwd + sy * spread,
        dir.z * fwd + sz * spread,
        0.25 + Math.random() * 0.55,
        Math.min(1, r * (0.85 + Math.random() * 0.3)),
        Math.min(1, g * (0.7 + Math.random() * 0.4)),
        Math.min(1, b * (0.6 + Math.random() * 0.5)),
        13,
      );
    }
    this.flash(at, 0.6 + intensity * 1.6, c);
  }

  /** Rising, drifting embers (burning or wrecked bots). */
  embers(at: THREE.Vector3, count = 4) {
    for (let i = 0; i < count; i++) {
      this.sparks.emit(
        at.x + (Math.random() - 0.5) * 0.6,
        at.y + Math.random() * 0.3,
        at.z + (Math.random() - 0.5) * 0.6,
        (Math.random() - 0.5) * 0.8,
        0.6 + Math.random() * 1.2,
        (Math.random() - 0.5) * 0.8,
        0.9 + Math.random() * 1.4,
        1,
        0.42 + Math.random() * 0.2,
        0.08,
        -0.8,
      );
    }
  }

  /** A puff of smoke. Heavy smoke (wrecks) is darker, bigger, and throws the odd ember. */
  smokePuff(at: THREE.Vector3, heavy: boolean) {
    const n = heavy ? 2 : 1;
    for (let i = 0; i < n; i++) {
      // Linear values: these land around #1a1a1c (wreck smoke) and #6a6a6e (light puffs) on screen.
      const shade = heavy ? 0.008 + Math.random() * 0.012 : 0.1 + Math.random() * 0.08;
      this.smoke.emit(
        at.x + (Math.random() - 0.5) * 0.35,
        at.y,
        at.z + (Math.random() - 0.5) * 0.35,
        (Math.random() - 0.5) * 0.5,
        0.7 + Math.random() * 0.7,
        (Math.random() - 0.5) * 0.5,
        heavy ? 2.4 + Math.random() * 1.4 : 1.4 + Math.random() * 1.0,
        heavy ? 1.0 + Math.random() * 0.5 : 0.55 + Math.random() * 0.35,
        heavy ? 0.85 : 0.5,
        shade,
        shade,
        shade * 1.04 + 0.01,
      );
    }
    if (heavy && Math.random() < 0.35) this.embers(at, 1);
  }

  /** Tumbling chunks thrown from a hit: `dir` is the throw direction, `color` the victim's paint. */
  debris(at: THREE.Vector3, dir: THREE.Vector3, count: number, color: THREE.Color | number = 0x9aa0aa, size = 1) {
    const c = new THREE.Color(color);
    const d = this.v.set(dir.x, 0, dir.z);
    const speed = d.length() > 0.01 ? 3.2 : 1.0;
    d.normalize();
    for (let i = 0; i < count; i++) this.chunks.emit(at, d, speed, c, size);
  }

  /** A dark burn mark on the floor that fades over ~20 s. `size` is the radius in meters. */
  scorch(at: THREE.Vector3, size = 1, strength = 0.7) {
    const s = this.scorches[this.scorchNext];
    this.scorchNext = (this.scorchNext + 1) % this.scorches.length;
    s.mesh.position.set(at.x, 0.012, at.z);
    s.mesh.rotation.y = Math.random() * Math.PI * 2;
    s.mesh.scale.setScalar(size);
    s.mesh.visible = true;
    s.life = SCORCH_LIFE;
    s.strength = strength;
  }

  /** Shockwave ring on the floor (hammer strikes, landings, flips). */
  ring(at: THREE.Vector3, color: number, scale = 1) {
    const r = this.rings[this.ringNext];
    this.ringNext = (this.ringNext + 1) % this.rings.length;
    r.mesh.position.set(at.x, 0.06, at.z);
    r.mat.color.set(color);
    r.max = r.life = 0.45 + scale * 0.12;
    r.from = 0.25 * scale;
    r.to = 1.8 * scale;
    r.mesh.scale.setScalar(r.from);
    r.mesh.visible = true;
  }

  private flash(at: THREE.Vector3, intensity: number, color: THREE.Color) {
    let slot = this.flashes[0];
    for (const f of this.flashes) if (f.life < slot.life) slot = f;
    slot.light.position.set(at.x, at.y + 0.6, at.z);
    slot.light.color.copy(color);
    slot.light.intensity = intensity * 12;
    slot.life = 0.18;
  }

  update(dt: number) {
    this.time += dt;
    this.sparks.update(dt, this.time);
    this.smoke.update(dt);
    this.chunks.update(dt);
    for (const r of this.rings) {
      if (!r.mesh.visible) continue;
      r.life -= dt;
      if (r.life <= 0) {
        r.mesh.visible = false;
        continue;
      }
      const t = 1 - r.life / r.max; // 0 → 1
      const ease = 1 - (1 - t) ** 3;
      r.mesh.scale.setScalar(r.from + (r.to - r.from) * ease);
      r.mat.opacity = (1 - t) ** 1.5 * 1.1;
    }
    for (const s of this.scorches) {
      if (!s.mesh.visible) continue;
      s.life -= dt;
      if (s.life <= 0) {
        s.mesh.visible = false;
        continue;
      }
      // Hold, then fade over the last third of life.
      s.mat.opacity = s.strength * Math.min(1, s.life / (SCORCH_LIFE / 3));
      const hot = Math.max(0, (s.life - (SCORCH_LIFE - SCORCH_HEAT)) / SCORCH_HEAT);
      s.heatMat.opacity = s.strength * hot * hot;
      s.heat.visible = hot > 0;
    }
    for (const f of this.flashes) {
      if (f.life > 0) {
        f.life -= dt;
        f.light.intensity *= Math.exp(-dt * 14);
        if (f.life <= 0) f.light.intensity = 0;
      }
    }
  }
}

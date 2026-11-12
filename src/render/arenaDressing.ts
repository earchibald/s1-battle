import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { ARENA } from "../sim/arena";

/**
 * Static-ish set dressing for the arena: the floor textures, the barrier, the stands and crowd, the overhead
 * truss with its light cones, and the LED boards. Everything here is decoration; gameplay geometry (pit, saws,
 * traps) lives in scene.ts and comes from ARENA. Instanced / merged so the whole surround is a handful of draws.
 */

/** Small deterministic RNG so canvas textures redraw identically (fonts load late and force a redraw). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FONT = `"Inter", "Arial Black", system-ui, sans-serif`;
const MONO = `"JetBrains Mono", ui-monospace, Menlo, monospace`;

/** Redraw a canvas texture once web fonts are in, so text drawn at startup doesn't keep the fallback face. */
function redrawWhenFontsLoad(draw: () => void, tex: THREE.Texture) {
  const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
  fonts?.ready.then(() => {
    draw();
    tex.needsUpdate = true;
  });
}

/* ------------------------------------------------------------------------------------------------ floor */

/**
 * Floor color + roughness maps. 20 m of floor on 2048 px. Sim north is the top of the canvas, matching
 * the floor mesh's UVs (local plane coords = sim coords).
 */
export function floorTextures(): { map: THREE.CanvasTexture; rough: THREE.CanvasTexture } {
  const size = 2048;
  const H = ARENA.half;
  const px = size / (H * 2);
  const fx = (x: number) => (x + H) * px;
  const fy = (y: number) => (H - y) * px;
  const c = document.createElement("canvas");
  const r = document.createElement("canvas");
  c.width = c.height = r.width = r.height = size;
  const g = c.getContext("2d")!;
  const gr = r.getContext("2d")!;

  const draw = () => {
    const rand = rng(1234);
    // --- Steel plates: 2 m panels, each its own tone and brush direction.
    const plates = 10;
    const P = size / plates;
    for (let i = 0; i < plates; i++) {
      for (let j = 0; j < plates; j++) {
        const d = Math.round((rand() - 0.5) * 9);
        g.fillStyle = `rgb(${22 + d},${25 + d},${30 + d})`;
        g.fillRect(i * P, j * P, P, P);
        const rv = 150 + Math.round((rand() - 0.5) * 50);
        gr.fillStyle = `rgb(${rv},${rv},${rv})`;
        gr.fillRect(i * P, j * P, P, P);
        // brushed grain
        const vertical = (i + j) % 2 === 0;
        for (let k = 0; k < 70; k++) {
          const o = rand() * P;
          const a = rand() * 0.035;
          g.strokeStyle = rand() < 0.5 ? `rgba(255,255,255,${a})` : `rgba(0,0,0,${a * 1.5})`;
          g.lineWidth = 1 + rand() * 1.5;
          g.beginPath();
          if (vertical) {
            g.moveTo(i * P + o, j * P);
            g.lineTo(i * P + o, j * P + P);
          } else {
            g.moveTo(i * P, j * P + o);
            g.lineTo(i * P + P, j * P + o);
          }
          g.stroke();
        }
      }
    }
    // Seams: a dark groove with a lit lip, and rougher in the roughness map.
    for (let i = 0; i <= plates; i++) {
      const q = i * P;
      g.strokeStyle = "rgba(0,0,0,0.7)";
      g.lineWidth = 5;
      g.beginPath();
      g.moveTo(q, 0);
      g.lineTo(q, size);
      g.moveTo(0, q);
      g.lineTo(size, q);
      g.stroke();
      g.strokeStyle = "rgba(255,255,255,0.07)";
      g.lineWidth = 1.5;
      g.beginPath();
      g.moveTo(q + 3.5, 0);
      g.lineTo(q + 3.5, size);
      g.moveTo(0, q + 3.5);
      g.lineTo(size, q + 3.5);
      g.stroke();
      gr.strokeStyle = "rgb(235,235,235)";
      gr.lineWidth = 6;
      gr.beginPath();
      gr.moveTo(q, 0);
      gr.lineTo(q, size);
      gr.moveTo(0, q);
      gr.lineTo(size, q);
      gr.stroke();
    }
    // Countersunk bolts at every plate corner.
    for (let i = 0; i < plates; i++) {
      for (let j = 0; j < plates; j++) {
        for (const [ox, oy] of [
          [16, 16],
          [P - 16, 16],
          [16, P - 16],
          [P - 16, P - 16],
        ]) {
          const x = i * P + ox;
          const y = j * P + oy;
          g.fillStyle = "rgba(0,0,0,0.55)";
          g.beginPath();
          g.arc(x + 1, y + 1.5, 7, 0, Math.PI * 2);
          g.fill();
          g.fillStyle = "#5a606b";
          g.beginPath();
          g.arc(x, y, 5.5, 0, Math.PI * 2);
          g.fill();
          g.fillStyle = "rgba(255,255,255,0.35)";
          g.beginPath();
          g.arc(x - 1.5, y - 1.5, 2, 0, Math.PI * 2);
          g.fill();
          gr.fillStyle = "rgb(90,90,90)";
          gr.beginPath();
          gr.arc(x, y, 5.5, 0, Math.PI * 2);
          gr.fill();
        }
      }
    }
    // Tire scuffs: paired arcs of rubber, kept off the center so the middle stays calm.
    for (let k = 0; k < 46; k++) {
      const cx = (rand() * 2 - 1) * (H - 1);
      const cy = (rand() * 2 - 1) * (H - 1);
      const rad = 1 + rand() * 3.5;
      const a0 = rand() * Math.PI * 2;
      const span = 0.4 + rand() * 1.1;
      const mid = { x: cx + Math.cos(a0 + span / 2) * rad, y: cy + Math.sin(a0 + span / 2) * rad };
      if (Math.hypot(mid.x, mid.y) < 3.4) continue;
      const alpha = 0.04 + rand() * 0.08;
      for (const off of [-0.5, 0.5]) {
        g.strokeStyle = `rgba(6,6,8,${alpha})`;
        g.lineWidth = 0.13 * px;
        g.lineCap = "round";
        g.beginPath();
        g.arc(fx(cx), fy(cy), (rad + off) * px, a0, a0 + span);
        g.stroke();
        gr.strokeStyle = `rgba(215,215,215,${alpha * 2.5})`;
        gr.lineWidth = 0.13 * px;
        gr.beginPath();
        gr.arc(fx(cx), fy(cy), (rad + off) * px, a0, a0 + span);
        gr.stroke();
      }
    }
    g.lineCap = "butt";
    // Grime / ambient occlusion along the walls.
    const edge = 1.1 * px;
    for (const [x0, y0, x1, y1] of [
      [0, 0, 0, edge],
      [0, size, 0, size - edge],
      [0, 0, edge, 0],
      [size, 0, size - edge, 0],
    ]) {
      const grad = g.createLinearGradient(x0, y0, x1, y1);
      grad.addColorStop(0, "rgba(0,0,0,0.55)");
      grad.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = grad;
      g.fillRect(0, 0, size, size);
    }
    // Boundary: a painted yellow line 0.45 m in from the barrier.
    const inset = 0.45 * px;
    g.strokeStyle = "rgba(240,196,64,0.85)";
    g.lineWidth = 0.09 * px;
    g.strokeRect(inset, inset, size - inset * 2, size - inset * 2);
    gr.strokeStyle = "rgb(95,95,95)";
    gr.lineWidth = 0.09 * px;
    gr.strokeRect(inset, inset, size - inset * 2, size - inset * 2);

    // Center: a thin double ring with ticks, and a clean wordmark south of the launch pad.
    const ccx = fx(0);
    const ccy = fy(0);
    g.strokeStyle = "rgba(110,200,255,0.32)";
    g.lineWidth = 0.06 * px;
    g.beginPath();
    g.arc(ccx, ccy, 3.2 * px, 0, Math.PI * 2);
    g.stroke();
    g.lineWidth = 0.025 * px;
    g.beginPath();
    g.arc(ccx, ccy, 3.4 * px, 0, Math.PI * 2);
    g.stroke();
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2;
      const r0 = 3.4 * px;
      const r1 = (k % 6 === 0 ? 3.75 : 3.55) * px;
      g.beginPath();
      g.moveTo(ccx + Math.cos(a) * r0, ccy + Math.sin(a) * r0);
      g.lineTo(ccx + Math.cos(a) * r1, ccy + Math.sin(a) * r1);
      g.stroke();
    }
    g.save();
    g.translate(ccx, fy(-1.35));
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.font = `800 ${Math.round(0.72 * px)}px ${FONT}`;
    (g as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = `${Math.round(0.12 * px)}px`;
    g.fillStyle = "rgba(110,200,255,0.26)";
    g.fillText("S1 ARENA", 0, 0);
    (g as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = `${Math.round(0.06 * px)}px`;
    g.font = `700 ${Math.round(0.2 * px)}px ${MONO}`;
    g.fillStyle = "rgba(110,200,255,0.22)";
    g.fillText("JEV · SYSTEM ONE ROBOT COMBAT", 0, 0.62 * px);
    (g as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = "0px";
    g.restore();
    gr.fillStyle = "rgb(110,110,110)";
    gr.fillRect(ccx - 3 * px, fy(-1.0), 6 * px, 1.1 * px);

    // Hazard stripes round the pit, saw slots and pad: worn yellow/black, glossier paint.
    const stripes = (cx: number, cy: number, hw: number, hh: number, band = 0.2) => {
      const x0 = fx(cx - hw);
      const y0 = fy(cy + hh);
      const w = hw * 2 * px;
      const h = hh * 2 * px;
      const b = band * px;
      for (const ctx of [g, gr]) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(x0 - b, y0 - b, w + b * 2, h + b * 2);
        ctx.rect(x0, y0, w, h);
        ctx.clip("evenodd");
        const step = 0.22 * px;
        for (let i = -size, n = 0; i < size * 2; i += step, n++) {
          ctx.fillStyle = ctx === g ? (n % 2 === 0 ? "#d9a628" : "#17181b") : n % 2 === 0 ? "rgb(110,110,110)" : "rgb(160,160,160)";
          ctx.beginPath();
          ctx.moveTo(i, 0);
          ctx.lineTo(i + step, 0);
          ctx.lineTo(i + step - size, size);
          ctx.lineTo(i - size, size);
          ctx.fill();
        }
        ctx.restore();
      }
      // wear
      g.save();
      g.beginPath();
      g.rect(x0 - b, y0 - b, w + b * 2, h + b * 2);
      g.rect(x0, y0, w, h);
      g.clip("evenodd");
      for (let k = 0; k < 160; k++) {
        g.fillStyle = `rgba(30,32,36,${0.2 + rand() * 0.5})`;
        g.fillRect(x0 - b + rand() * (w + b * 2), y0 - b + rand() * (h + b * 2), 2 + rand() * 14, 1 + rand() * 4);
      }
      g.restore();
    };
    stripes(ARENA.pit.center.x, ARENA.pit.center.y, ARENA.pit.half, ARENA.pit.half, 0.26);
    for (const s of ARENA.saws.slots) stripes(s.center.x, s.center.y, s.halfX, s.halfY, 0.2);
    stripes(ARENA.pad.center.x, ARENA.pad.center.y, ARENA.pad.half, ARENA.pad.half, 0.16);

    // Flame vents: scorch halo + dashed orange warning ring.
    for (const v of ARENA.vents.slots) {
      const rr = ARENA.vents.radius * px;
      const scorch = g.createRadialGradient(fx(v.x), fy(v.y), rr * 0.5, fx(v.x), fy(v.y), rr * 2.1);
      scorch.addColorStop(0, "rgba(8,4,2,0.85)");
      scorch.addColorStop(0.5, "rgba(30,14,6,0.45)");
      scorch.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = scorch;
      g.beginPath();
      g.arc(fx(v.x), fy(v.y), rr * 2.1, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = "rgba(255,122,26,0.85)";
      g.lineWidth = 0.06 * px;
      g.setLineDash([0.16 * px, 0.11 * px]);
      g.beginPath();
      g.arc(fx(v.x), fy(v.y), rr + 0.1 * px, 0, Math.PI * 2);
      g.stroke();
      g.setLineDash([]);
    }
    // Shock plates: a blue border with corner brackets.
    for (const sp of ARENA.shock.plates) {
      const h = ARENA.shock.half * px;
      const o = 0.1 * px;
      const x = fx(sp.center.x);
      const y = fy(sp.center.y);
      g.strokeStyle = "rgba(102,221,255,0.55)";
      g.lineWidth = 0.05 * px;
      g.strokeRect(x - h - o, y - h - o, (h + o) * 2, (h + o) * 2);
    }
    // Start corners: open brackets with the slot number, quiet white paint.
    ARENA.starts.forEach((s, i) => {
      const x = fx(s.x);
      const y = fy(s.y);
      const hh = 0.85 * px;
      const arm = 0.35 * px;
      g.strokeStyle = "rgba(235,240,250,0.42)";
      g.lineWidth = 0.06 * px;
      for (const [sx, sy] of [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ]) {
        g.beginPath();
        g.moveTo(x + sx * hh, y + sy * (hh - arm));
        g.lineTo(x + sx * hh, y + sy * hh);
        g.lineTo(x + sx * (hh - arm), y + sy * hh);
        g.stroke();
      }
      g.fillStyle = "rgba(235,240,250,0.3)";
      g.font = `700 ${Math.round(0.42 * px)}px ${MONO}`;
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(String(i + 1), x, y);
    });
  };
  draw();
  const map = new THREE.CanvasTexture(c);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 8;
  const rough = new THREE.CanvasTexture(r);
  rough.anisotropy = 8;
  redrawWhenFontsLoad(draw, map);
  return { map, rough };
}

/** A tiling yellow/black hazard stripe strip (for the barrier kick plate band). */
function hazardTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 32;
  const g = c.getContext("2d")!;
  g.fillStyle = "#16171a";
  g.fillRect(0, 0, 128, 32);
  g.fillStyle = "#e0ad2a";
  for (let i = -64; i < 192; i += 32) {
    g.beginPath();
    g.moveTo(i, 32);
    g.lineTo(i + 16, 32);
    g.lineTo(i + 32, 0);
    g.lineTo(i + 16, 0);
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  return t;
}

/** Scrolling LED ribbon: project names on a dot-matrix strip. */
function ledTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 2048;
  c.height = 128;
  const g = c.getContext("2d")!;
  const items: [string, string][] = [
    ["S1 ARENA", "#6ee7ff"],
    ["◆", "#ff3d8b"],
    ["JEV · SYSTEM ONE", "#ffffff"],
    ["◆", "#ffb020"],
    ["TYPESAFE", "#c9a2ff"],
    ["◆", "#6ee7ff"],
    ["ROBOT COMBAT", "#ff3d8b"],
    ["◆", "#ffffff"],
  ];
  const draw = () => {
    g.fillStyle = "#04050a";
    g.fillRect(0, 0, c.width, c.height);
    // Lay the items out once across the strip with even gaps so the wrap is seamless.
    let font = 76;
    g.font = `800 ${font}px ${FONT}`;
    let tw = items.map(([t]) => g.measureText(t).width);
    let sum = tw.reduce((a, b) => a + b, 0);
    if (sum > c.width * 0.85) {
      font = Math.floor(font * ((c.width * 0.85) / sum));
      g.font = `800 ${font}px ${FONT}`;
      tw = items.map(([t]) => g.measureText(t).width);
      sum = tw.reduce((a, b) => a + b, 0);
    }
    const gap = (c.width - sum) / items.length;
    g.textBaseline = "middle";
    let x = gap / 2;
    items.forEach(([t, col], i) => {
      g.fillStyle = col;
      g.fillText(t, x, 66);
      x += tw[i] + gap;
    });
    // dot-matrix mask
    g.fillStyle = "rgba(0,0,0,0.55)";
    for (let y = 0; y < c.height; y += 6) g.fillRect(0, y, c.width, 2);
    for (let xx = 0; xx < c.width; xx += 6) g.fillRect(xx, 0, 2, c.height);
  };
  draw();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.anisotropy = 4;
  redrawWhenFontsLoad(draw, t);
  return t;
}

/** Big stand-top screen: the wordmark. */
function screenTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 1024;
  c.height = 384;
  const g = c.getContext("2d")!;
  const draw = () => {
    const bg = g.createLinearGradient(0, 0, 0, c.height);
    bg.addColorStop(0, "#071226");
    bg.addColorStop(1, "#0a0414");
    g.fillStyle = bg;
    g.fillRect(0, 0, c.width, c.height);
    g.strokeStyle = "#6ee7ff";
    g.lineWidth = 6;
    g.strokeRect(10, 10, c.width - 20, c.height - 20);
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillStyle = "#ffffff";
    g.font = `800 150px ${FONT}`;
    g.fillText("S1 ARENA", c.width / 2, 165);
    g.fillStyle = "#ff3d8b";
    g.font = `700 44px ${MONO}`;
    g.fillText("JEV · TYPESAFE SYSTEM ONE", c.width / 2, 290);
    g.fillStyle = "rgba(0,0,0,0.4)";
    for (let y = 0; y < c.height; y += 4) g.fillRect(0, y, c.width, 1);
  };
  draw();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  redrawWhenFontsLoad(draw, t);
  return t;
}

/* ------------------------------------------------------------------------------------------------ dressing */

/** The four sides of a square ring at distance `d`: center point, inward normal, and yaw that faces the center. */
function sides(d: number) {
  return [
    { x: 0, z: -d, nx: 0, nz: 1, yaw: 0 },
    { x: 0, z: d, nx: 0, nz: -1, yaw: Math.PI },
    { x: -d, z: 0, nx: 1, nz: 0, yaw: Math.PI / 2 },
    { x: d, z: 0, nx: -1, nz: 0, yaw: -Math.PI / 2 },
  ];
}

export class ArenaDressing {
  readonly group = new THREE.Group();
  /** Lit rail strips on the barrier (pulse in updateArena). */
  readonly railMat: THREE.MeshStandardMaterial;
  private beaconMat: THREE.MeshStandardMaterial;
  private led!: THREE.CanvasTexture;
  private crowd!: THREE.InstancedMesh;
  private crowdBaseY!: Float32Array;
  private crowdPhase!: Float32Array;
  private phones!: THREE.Points;
  private phoneTimer = 0;
  private excite = 0;
  private cones: THREE.MeshBasicMaterial[] = [];

  constructor(private env: THREE.Texture | null) {
    this.railMat = new THREE.MeshStandardMaterial({ color: 0x0b2b36, emissive: 0x33ccff, emissiveIntensity: 2.3 });
    this.beaconMat = new THREE.MeshStandardMaterial({ color: 0x331a08, emissive: 0xffa020, emissiveIntensity: 1.5 });
    this.buildBarrier();
    this.buildStands();
    this.buildTruss();
  }

  /** Dressing materials reflect a dimmer room than the hero props. */
  private dim<T extends THREE.MeshStandardMaterial>(m: T, envIntensity = 0.25): T {
    if (this.env) {
      m.envMap = this.env;
      m.envMapIntensity = envIntensity;
    }
    return m;
  }

  private buildBarrier() {
    const H = ARENA.half;
    const t = 0.35;
    const kickH = 0.55;
    const topY = 2.12;
    const L = H * 2 + t * 2;
    const steel = new THREE.MeshStandardMaterial({ color: 0x30353e, roughness: 0.42, metalness: 0.85 });
    const darkSteel = new THREE.MeshStandardMaterial({ color: 0x1a1d22, roughness: 0.5, metalness: 0.8 });
    const panelMat = new THREE.MeshStandardMaterial({
      color: 0xa8d0ff,
      transparent: true,
      opacity: 0.1,
      roughness: 0.04,
      metalness: 0.1,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.dim(panelMat, 0.18);
    const hazard = hazardTexture();
    hazard.repeat.set(L / 0.6, 1);
    const hazardMat = new THREE.MeshStandardMaterial({ map: hazard, roughness: 0.5, metalness: 0.3 });

    const kickGeos: THREE.BufferGeometry[] = [];
    const frameGeos: THREE.BufferGeometry[] = [];
    const railGeos: THREE.BufferGeometry[] = [];
    const panelGeos: THREE.BufferGeometry[] = [];
    for (const s of sides(H + t / 2)) {
      const along = Math.abs(s.nz) > 0 ? "x" : "z";
      const place = (geo: THREE.BufferGeometry, inward: number, y: number) => {
        if (along === "z") geo.rotateY(Math.PI / 2);
        geo.translate(s.x + s.nx * inward, y, s.z + s.nz * inward);
        return geo;
      };
      kickGeos.push(place(new THREE.BoxGeometry(L, kickH, t), 0, kickH / 2));
      // lit strip on top of the kick plate, and the top rail
      railGeos.push(place(new THREE.BoxGeometry(L, 0.05, 0.1), t / 2 - 0.05, kickH + 0.025));
      railGeos.push(place(new THREE.BoxGeometry(L, 0.05, 0.08), 0, topY + 0.07));
      // frame rails
      frameGeos.push(place(new THREE.BoxGeometry(L, 0.08, 0.14), 0, topY));
      frameGeos.push(place(new THREE.BoxGeometry(L, 0.06, 0.12), 0, kickH + 0.08));
      // polycarbonate
      panelGeos.push(place(new THREE.BoxGeometry(L, topY - kickH - 0.1, 0.03), 0, (topY + kickH) / 2));
      // posts every ~3.4 m
      const n = 6;
      for (let i = 1; i < n; i++) {
        const u = -L / 2 + (i * L) / n;
        const post = new THREE.BoxGeometry(0.14, topY - kickH, 0.2);
        post.translate(u, 0, 0);
        frameGeos.push(place(post, 0.02, (topY + kickH) / 2));
      }
      // hazard band on the inner face of the kick plate
      const band = new THREE.PlaneGeometry(L - t * 2, 0.16);
      band.rotateY(s.yaw);
      band.translate(s.x + s.nx * (t / 2 + 0.004), 0.36, s.z + s.nz * (t / 2 + 0.004));
      const bandMesh = new THREE.Mesh(band, hazardMat);
      bandMesh.receiveShadow = true;
      this.group.add(bandMesh);
    }
    const kick = new THREE.Mesh(mergeGeometries(kickGeos), this.dim(steel, 0.6));
    kick.castShadow = kick.receiveShadow = true;
    const frame = new THREE.Mesh(mergeGeometries(frameGeos), this.dim(darkSteel, 0.5));
    frame.castShadow = true;
    const rail = new THREE.Mesh(mergeGeometries(railGeos), this.railMat);
    const panels = new THREE.Mesh(mergeGeometries(panelGeos), panelMat);
    panels.renderOrder = 2;
    this.group.add(kick, frame, rail, panels);

    // Corner pillars with warning beacons.
    const pillarGeo = new THREE.BoxGeometry(0.6, 2.7, 0.6);
    const capGeo = new THREE.CylinderGeometry(0.17, 0.2, 0.22, 16);
    const lensGeo = new THREE.CylinderGeometry(0.15, 0.15, 0.2, 16);
    for (const [x, z] of [
      [-H - t / 2, -H - t / 2],
      [H + t / 2, -H - t / 2],
      [H + t / 2, H + t / 2],
      [-H - t / 2, H + t / 2],
    ]) {
      const p = new THREE.Mesh(pillarGeo, steel);
      p.position.set(x, 1.35, z);
      p.castShadow = true;
      const cap = new THREE.Mesh(capGeo, darkSteel);
      cap.position.set(x, 2.81, z);
      const lens = new THREE.Mesh(lensGeo, this.beaconMat);
      lens.position.set(x, 3.02, z);
      this.group.add(p, cap, lens);
    }
  }

  private buildStands() {
    const H = ARENA.half;
    const front = H + 2.2;
    const fasciaH = 1.0;
    const tiers = 7;
    const depth = 1.0;
    const rise = 0.55;
    const concrete = this.dim(new THREE.MeshStandardMaterial({ color: 0x15171d, roughness: 0.95, metalness: 0.1 }), 0.15);
    const geos: THREE.BufferGeometry[] = [];
    // fascia wall under the LED ribbon
    for (const s of sides(front + 0.1)) {
      const g = new THREE.BoxGeometry((front + 0.2) * 2, fasciaH, 0.2);
      g.rotateY(s.yaw);
      g.translate(s.x, fasciaH / 2, s.z);
      geos.push(g);
    }
    for (let i = 0; i < tiers; i++) {
      const d = front + 0.2 + i * depth + depth / 2;
      const h = fasciaH + i * rise;
      for (const s of sides(d)) {
        const g = new THREE.BoxGeometry((d + depth / 2) * 2, h, depth);
        g.rotateY(s.yaw);
        g.translate(s.x, h / 2, s.z);
        geos.push(g);
      }
    }
    // back wall
    const back = front + 0.2 + tiers * depth + 0.15;
    const backH = fasciaH + tiers * rise + 2.2;
    for (const s of sides(back)) {
      const g = new THREE.BoxGeometry((back + 0.15) * 2, backH, 0.3);
      g.rotateY(s.yaw);
      g.translate(s.x, backH / 2, s.z);
      geos.push(g);
    }
    const stands = new THREE.Mesh(mergeGeometries(geos), concrete);
    stands.receiveShadow = true;
    this.group.add(stands);

    // LED ribbon on the fascia
    this.led = ledTexture();
    const ledMat = new THREE.MeshBasicMaterial({ map: this.led, color: 0xbfbfbf });
    for (const s of sides(front - 0.005)) {
      const len = front * 2;
      const g = new THREE.PlaneGeometry(len, 0.72);
      // repeat by length: scale the UVs (one texture, shared material)
      const uv = g.getAttribute("uv") as THREE.BufferAttribute;
      for (let k = 0; k < uv.count; k++) uv.setX(k, uv.getX(k) * (len / 14));
      g.rotateY(s.yaw);
      g.translate(s.x, 0.52, s.z);
      this.group.add(new THREE.Mesh(g, ledMat));
    }
    // big screens on the back wall
    const screenMat = new THREE.MeshBasicMaterial({ map: screenTexture(), color: 0xd0d0d0 });
    for (const s of sides(back - 0.16)) {
      for (const off of [-0.45, 0.45]) {
        const g = new THREE.PlaneGeometry(6.4, 2.4);
        g.translate(off * back, 0, 0);
        g.rotateY(s.yaw);
        g.translate(s.x, fasciaH + tiers * rise + 1.5, s.z);
        this.group.add(new THREE.Mesh(g, screenMat));
      }
    }

    // Crowd: one instanced silhouette (torso + head), seated on every tier, a few empty seats.
    const body = new THREE.BoxGeometry(0.38, 0.5, 0.26);
    body.translate(0, 0.25, 0);
    const head = new THREE.IcosahedronGeometry(0.12, 0);
    head.translate(0, 0.64, 0.02);
    const shoulders = new THREE.BoxGeometry(0.46, 0.12, 0.24);
    shoulders.translate(0, 0.46, 0);
    const person = mergeGeometries([body.toNonIndexed(), head.toNonIndexed(), shoulders.toNonIndexed()]);
    const rand = rng(77);
    const seats: { x: number; y: number; z: number; yaw: number; s: number }[] = [];
    for (let i = 0; i < tiers; i++) {
      const d = front + 0.2 + i * depth + depth * 0.55;
      const y = fasciaH + i * rise;
      for (const s of sides(d)) {
        const ns = Math.abs(s.nz) > 0;
        const lim = ns ? d : d - 0.7;
        for (let u = -lim; u <= lim; u += 0.6) {
          if (rand() < 0.2) continue;
          const j = (rand() - 0.5) * 0.16;
          const x = ns ? u + j : s.x;
          const z = ns ? s.z : u + j;
          seats.push({ x: x - s.nx * 0.05, y, z: z - s.nz * 0.05, yaw: s.yaw + (rand() - 0.5) * 0.4, s: 0.88 + rand() * 0.24 });
        }
      }
    }
    const crowdMat = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0 });
    this.dim(crowdMat, 0.12);
    this.crowd = new THREE.InstancedMesh(person, crowdMat, seats.length);
    this.crowdBaseY = new Float32Array(seats.length);
    this.crowdPhase = new Float32Array(seats.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const col = new THREE.Color();
    const phonePos: number[] = [];
    seats.forEach((p, k) => {
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.yaw);
      m.compose(new THREE.Vector3(p.x, p.y, p.z), q, new THREE.Vector3(p.s, p.s, p.s));
      this.crowd.setMatrixAt(k, m);
      this.crowdBaseY[k] = p.y;
      this.crowdPhase[k] = rand() * Math.PI * 2;
      // shirts: mostly dark, some team-ish colors catching the arena light
      const hue = rand();
      col.setHSL(hue, 0.15 + rand() * 0.2, rand() < 0.15 ? 0.075 : 0.02 + rand() * 0.035);
      this.crowd.setColorAt(k, col);
      if (rand() < 0.07) phonePos.push(p.x + Math.sin(p.yaw) * 0.25, p.y + 0.62 * p.s, p.z + Math.cos(p.yaw) * 0.25);
    });
    this.crowd.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.crowd.receiveShadow = false;
    this.group.add(this.crowd);

    const phoneGeo = new THREE.BufferGeometry();
    phoneGeo.setAttribute("position", new THREE.Float32BufferAttribute(phonePos, 3));
    const pc = new Float32Array(phonePos.length);
    for (let k = 0; k < pc.length; k += 3) {
      const on = rand() < 0.7 ? 1 : 0;
      pc[k] = 0.75 * on;
      pc[k + 1] = 0.85 * on;
      pc[k + 2] = 1.0 * on;
    }
    phoneGeo.setAttribute("color", new THREE.BufferAttribute(pc, 3));
    this.phones = new THREE.Points(
      phoneGeo,
      new THREE.PointsMaterial({ size: 0.09, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true }),
    );
    this.group.add(this.phones);
  }

  private buildTruss() {
    const d = ARENA.half + 6.5;
    const y = 15;
    const steel = this.dim(new THREE.MeshStandardMaterial({ color: 0x23262c, roughness: 0.5, metalness: 0.85 }), 0.3);
    const geos: THREE.BufferGeometry[] = [];
    const L = d * 2 + 0.6;
    for (const s of sides(d)) {
      for (const [oy, oi] of [
        [0.3, 0.3],
        [0.3, -0.3],
        [-0.3, 0.3],
        [-0.3, -0.3],
      ]) {
        const g = new THREE.BoxGeometry(L, 0.07, 0.07);
        g.rotateY(s.yaw);
        g.translate(s.x + s.nx * oi, y + oy, s.z + s.nz * oi);
        geos.push(g);
      }
      // zig-zag lacing on the two vertical faces
      const n = Math.round(L / 0.6);
      for (let i = 0; i < n; i++) {
        const u = -L / 2 + (i + 0.5) * (L / n);
        for (const oi of [0.3, -0.3]) {
          const g = new THREE.BoxGeometry(0.04, 0.72, 0.04);
          g.rotateZ(i % 2 ? 0.7 : -0.7);
          g.translate(u, 0, oi);
          g.rotateY(s.yaw);
          g.translate(s.x, y, s.z);
          geos.push(g);
        }
      }
    }
    // hangers down to the back wall corners
    for (const [x, z] of [
      [-d, -d],
      [d, -d],
      [d, d],
      [-d, d],
    ]) {
      const g = new THREE.BoxGeometry(0.25, y, 0.25);
      g.translate(x, y / 2, z);
      geos.push(g);
    }
    const truss = new THREE.Mesh(mergeGeometries(geos), steel);
    this.group.add(truss);

    // Fixtures: cans hanging off the truss, a glowing lens, and a faint additive beam to the floor.
    const canGeo = new THREE.CylinderGeometry(0.22, 0.3, 0.55, 12);
    const lensGeo = new THREE.CircleGeometry(0.27, 16);
    const lensMat = new THREE.MeshBasicMaterial({ color: 0xfff4e0 });
    lensMat.color.multiplyScalar(3); // HDR so the lenses bloom
    const beamTex = (() => {
      const c = document.createElement("canvas");
      c.width = 4;
      c.height = 128;
      const g = c.getContext("2d")!;
      const grad = g.createLinearGradient(0, 0, 0, 128);
      // Cone UVs put the lamp at the canvas top: brightest just below the lens, gone well before the floor.
      grad.addColorStop(0, "rgba(255,255,255,0)");
      grad.addColorStop(0.05, "rgba(255,255,255,1)");
      grad.addColorStop(0.2, "rgba(255,255,255,0.75)");
      grad.addColorStop(0.55, "rgba(255,255,255,0)");
      grad.addColorStop(1, "rgba(255,255,255,0)");
      g.fillStyle = grad;
      g.fillRect(0, 0, 4, 128);
      return new THREE.CanvasTexture(c);
    })();
    const rand = rng(5);
    for (const s of sides(d)) {
      for (const u of [-0.55, 0, 0.55]) {
        const ns = Math.abs(s.nz) > 0;
        const px = ns ? u * d : s.x;
        const pz = ns ? s.z : u * d;
        const pos = new THREE.Vector3(px + s.nx * 0.1, y - 0.55, pz + s.nz * 0.1);
        const target = new THREE.Vector3(px * 0.35 + (rand() - 0.5) * 3, 0, pz * 0.35 + (rand() - 0.5) * 3);
        const can = new THREE.Group();
        can.position.copy(pos);
        can.lookAt(target);
        const body = new THREE.Mesh(canGeo, steel);
        body.rotation.x = Math.PI / 2;
        const lens = new THREE.Mesh(lensGeo, lensMat);
        lens.position.z = 0.28;
        can.add(body, lens);
        this.group.add(can);
        const len = pos.distanceTo(target);
        const cone = new THREE.ConeGeometry(1.5, len, 20, 1, true);
        cone.translate(0, -len / 2, 0);
        cone.rotateX(-Math.PI / 2);
        const warm = rand() < 0.5;
        const mat = new THREE.MeshBasicMaterial({
          map: beamTex,
          color: warm ? 0xffe2b8 : 0xbfdcff,
          transparent: true,
          opacity: 0.06,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          side: THREE.DoubleSide,
          fog: false,
        });
        const beam = new THREE.Mesh(cone, mat);
        beam.position.copy(pos);
        beam.lookAt(target);
        beam.renderOrder = 3;
        this.group.add(beam);
        this.cones.push(mat);
      }
    }
  }

  /** The crowd jumps on big moments (called from ArenaScene.kick). */
  cheer(amount: number) {
    this.excite = Math.min(1, this.excite + amount * 0.8);
  }

  /** `alarm`: 0 calm, 1 warning, 2 pit open. */
  update(t: number, dt: number, alarm: 0 | 1 | 2) {
    this.led.offset.x = (this.led.offset.x + dt * 0.04) % 1;
    // Beacons: slow amber breathing; fast red strobe while the pit warns or is open.
    if (alarm === 0) {
      this.beaconMat.emissive.setHex(0xffa020);
      this.beaconMat.emissiveIntensity = 1.5 + 3 * Math.max(0, Math.sin(t * 2.2));
    } else {
      this.beaconMat.emissive.setHex(0xff2a1a);
      this.beaconMat.emissiveIntensity = Math.sin(t * (alarm === 1 ? 14 : 9)) > 0 ? 10 : 0.5;
    }
    // Crowd bob: only touches the instance buffer while they're excited.
    if (this.excite > 0.01) {
      this.excite = Math.max(0, this.excite - dt * 0.45);
      const arr = this.crowd.instanceMatrix.array as Float32Array;
      const e = this.excite;
      for (let k = 0; k < this.crowdBaseY.length; k++) {
        arr[k * 16 + 13] = this.crowdBaseY[k] + Math.max(0, Math.sin(t * 11 + this.crowdPhase[k])) * 0.16 * e;
      }
      this.crowd.instanceMatrix.needsUpdate = true;
    }
    // Phone lights twinkle.
    this.phoneTimer -= dt;
    if (this.phoneTimer <= 0) {
      this.phoneTimer = 0.12;
      const c = this.phones.geometry.getAttribute("color") as THREE.BufferAttribute;
      for (let k = 0; k < 4; k++) {
        const i = Math.floor(Math.random() * c.count);
        const on = Math.random() < 0.6 + this.excite * 0.3 ? 1 : 0;
        c.setXYZ(i, 0.75 * on, 0.85 * on, on);
      }
      c.needsUpdate = true;
    }
    for (const m of this.cones) m.opacity = 0.06 + this.excite * 0.04;
  }
}

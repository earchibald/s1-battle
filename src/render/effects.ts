import * as THREE from "three";

/**
 * Cheap, punchy particle effects: sparks (additive points), smoke (soft sprites), and
 * expanding impact rings. All pooled, all updated per frame.
 */

interface Particle {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  life: number;
  maxLife: number;
  size: number;
}

class PointPool {
  readonly points: THREE.Points;
  private readonly geo: THREE.BufferGeometry;
  private readonly positions: Float32Array;
  private readonly colors: Float32Array;
  private readonly sizes: Float32Array;
  readonly particles: Particle[] = [];
  readonly color = new THREE.Color();
  constructor(readonly max: number, readonly gravity: number, material: THREE.PointsMaterial) {
    this.geo = new THREE.BufferGeometry();
    this.positions = new Float32Array(max * 3);
    this.colors = new Float32Array(max * 3);
    this.sizes = new Float32Array(max);
    this.geo.setAttribute("position", new THREE.BufferAttribute(this.positions, 3));
    this.geo.setAttribute("color", new THREE.BufferAttribute(this.colors, 3));
    this.points = new THREE.Points(this.geo, material);
    this.points.frustumCulled = false;
  }
  emit(p: Particle, r: number, g: number, b: number) {
    if (this.particles.length >= this.max) this.particles.shift();
    (p as Particle & { c: [number, number, number] }).c = [r, g, b];
    this.particles.push(p);
  }
  update(dt: number, fade: (p: Particle, t: number, out: THREE.Color) => void) {
    const ps = this.particles;
    for (let i = ps.length - 1; i >= 0; i--) {
      const p = ps[i];
      p.life -= dt;
      if (p.life <= 0) {
        ps.splice(i, 1);
        continue;
      }
      p.vel.y -= this.gravity * dt;
      p.pos.addScaledVector(p.vel, dt);
      if (p.pos.y < 0.02 && this.gravity > 0) {
        p.pos.y = 0.02;
        p.vel.y *= -0.35;
        p.vel.x *= 0.7;
        p.vel.z *= 0.7;
      }
    }
    for (let i = 0; i < this.max; i++) {
      if (i < ps.length) {
        const p = ps[i] as Particle & { c: [number, number, number] };
        this.positions[i * 3] = p.pos.x;
        this.positions[i * 3 + 1] = p.pos.y;
        this.positions[i * 3 + 2] = p.pos.z;
        this.color.setRGB(p.c[0], p.c[1], p.c[2]);
        fade(p, p.life / p.maxLife, this.color);
        this.colors[i * 3] = this.color.r;
        this.colors[i * 3 + 1] = this.color.g;
        this.colors[i * 3 + 2] = this.color.b;
      } else {
        this.positions[i * 3 + 1] = -100;
      }
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.color.needsUpdate = true;
    this.geo.setDrawRange(0, Math.max(1, ps.length));
  }
}

function softDot(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.4, "rgba(255,255,255,0.6)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  return t;
}

export class Effects {
  readonly group = new THREE.Group();
  private sparks: PointPool;
  private smoke: PointPool;
  private rings: { mesh: THREE.Mesh; life: number; max: number; grow: number }[] = [];
  private ringGeo = new THREE.RingGeometry(0.6, 0.8, 40);
  private flashes: { light: THREE.PointLight; life: number }[] = [];

  constructor() {
    const dot = softDot();
    this.sparks = new PointPool(
      900,
      14,
      new THREE.PointsMaterial({ size: 0.16, map: dot, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true }),
    );
    this.smoke = new PointPool(
      400,
      -0.6,
      new THREE.PointsMaterial({ size: 0.9, map: dot, vertexColors: true, transparent: true, opacity: 0.35, depthWrite: false, sizeAttenuation: true }),
    );
    this.group.add(this.sparks.points, this.smoke.points);
    for (let i = 0; i < 6; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 9, 1.8);
      this.group.add(l);
      this.flashes.push({ light: l, life: 0 });
    }
  }

  /** Burst of sparks at a point. `dir` is the rough direction of the hit; intensity 0..1. */
  sparkBurst(at: THREE.Vector3, dir: THREE.Vector3, intensity: number, color: THREE.Color | number = 0xffc864) {
    const c = new THREE.Color(color);
    const n = Math.round(8 + intensity * 40);
    for (let i = 0; i < n; i++) {
      const spread = new THREE.Vector3((Math.random() - 0.5) * 2, Math.random() * 1.6, (Math.random() - 0.5) * 2);
      const vel = dir.clone().multiplyScalar(2 + Math.random() * 5 * intensity).add(spread.multiplyScalar(3 + intensity * 4));
      this.sparks.emit(
        { pos: at.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.3, Math.random() * 0.3, (Math.random() - 0.5) * 0.3)), vel, life: 0.3 + Math.random() * 0.6, maxLife: 0.9, size: 1 },
        c.r * (0.8 + Math.random() * 0.4),
        c.g * (0.6 + Math.random() * 0.4),
        c.b * (0.5 + Math.random() * 0.5),
      );
    }
    this.flash(at, 0.6 + intensity * 1.6, c);
  }

  smokePuff(at: THREE.Vector3, heavy: boolean) {
    const n = heavy ? 3 : 1;
    for (let i = 0; i < n; i++) {
      const shade = heavy ? 0.12 + Math.random() * 0.1 : 0.3 + Math.random() * 0.2;
      this.smoke.emit(
        {
          pos: at.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.4, 0, (Math.random() - 0.5) * 0.4)),
          vel: new THREE.Vector3((Math.random() - 0.5) * 0.6, 1.0 + Math.random() * 0.8, (Math.random() - 0.5) * 0.6),
          life: 1.2 + Math.random() * 1.2,
          maxLife: 2.2,
          size: 1,
        },
        shade,
        shade,
        shade + 0.02,
      );
    }
  }

  /** Shockwave ring on the floor (hammer strikes, landings, flips). */
  ring(at: THREE.Vector3, color: number, scale = 1) {
    const m = new THREE.Mesh(this.ringGeo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }));
    m.rotation.x = -Math.PI / 2;
    m.position.copy(at).setY(0.05);
    m.scale.setScalar(0.3 * scale);
    this.group.add(m);
    this.rings.push({ mesh: m, life: 0.5, max: 0.5, grow: 5 * scale });
  }

  private flash(at: THREE.Vector3, intensity: number, color: THREE.Color) {
    const slot = this.flashes.sort((a, b) => a.life - b.life)[0];
    slot.light.position.copy(at).setY(at.y + 0.6);
    slot.light.color.copy(color);
    slot.light.intensity = intensity * 12;
    slot.life = 0.18;
  }

  update(dt: number) {
    this.sparks.update(dt, (p, t, c) => c.multiplyScalar(Math.min(1, t * 2)));
    this.smoke.update(dt, (p, t, c) => c.multiplyScalar(Math.sin(t * Math.PI) * 0.9));
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.life -= dt;
      if (r.life <= 0) {
        this.group.remove(r.mesh);
        (r.mesh.material as THREE.Material).dispose();
        this.rings.splice(i, 1);
        continue;
      }
      r.mesh.scale.addScalar(r.grow * dt);
      (r.mesh.material as THREE.MeshBasicMaterial).opacity = (r.life / r.max) * 0.9;
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

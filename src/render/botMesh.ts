import * as THREE from "three";
import type { Bot } from "../sim/bot";
import { toWorld } from "./scene";

/**
 * Procedural robot models. Every bot shares a chassis + wheels, and each kind gets a mechanically
 * honest weapon rig that animates from the simulation's weapon state. The build shows on the body:
 * armor level adds side plates, motor level grows the wheels, weapon power scales the rig, frame
 * level scales the chassis.
 *
 * Weapon rigs:
 *   saw     – vertical disc that spins with `weapon.spin`
 *   hammer  – arm that swings through windup / strike / recover
 *   grabber – jaws that open/close, a top claw that comes down while holding
 *   flipper – front plate that kicks up when fired
 */

const WHEEL_MAT = new THREE.MeshStandardMaterial({ color: 0x15161a, roughness: 0.9, metalness: 0.2 });
const HUB_MAT = new THREE.MeshStandardMaterial({ color: 0x9aa0aa, roughness: 0.4, metalness: 0.9 });
const STEEL = new THREE.MeshStandardMaterial({ color: 0xb8bec8, roughness: 0.28, metalness: 0.95 });
const DARK_STEEL = new THREE.MeshStandardMaterial({ color: 0x3b3f47, roughness: 0.5, metalness: 0.85 });

function wheel(radius: number, width: number): THREE.Group {
  const g = new THREE.Group();
  const tire = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, width, 20), WHEEL_MAT);
  tire.rotation.x = Math.PI / 2;
  tire.castShadow = true;
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.55, radius * 0.55, width + 0.02, 12), HUB_MAT);
  hub.rotation.x = Math.PI / 2;
  g.add(tire, hub);
  return g;
}

export class BotMesh {
  readonly group = new THREE.Group();
  readonly bot: Bot;
  private body: THREE.Group;
  private bodyMats: THREE.MeshStandardMaterial[] = [];
  private wheels: THREE.Group[] = [];
  private ring: THREE.Mesh;
  private ringMat: THREE.MeshBasicMaterial;
  private wheelSpin = 0;
  private tilt = 0;
  // weapon rigs
  private blade?: THREE.Group;
  private hammerArm?: THREE.Group;
  private jawL?: THREE.Group;
  private jawR?: THREE.Group;
  private claw?: THREE.Group;
  private plate?: THREE.Group;
  private smokeTimer = 0;
  private wheelScale = 1;
  private rigScale = 1;

  constructor(bot: Bot) {
    this.bot = bot;
    const L = bot.def.build.levels;
    this.wheelScale = 0.85 + L.motor * 0.05;
    this.rigScale = 0.82 + L.power * 0.06;
    this.body = new THREE.Group();
    this.body.scale.setScalar(1.18 * (0.955 + L.frame * 0.015));
    this.group.add(this.body);
    this.ringMat = new THREE.MeshBasicMaterial({ color: bot.def.color, transparent: true, opacity: 0.55, side: THREE.DoubleSide });
    this.ring = new THREE.Mesh(new THREE.RingGeometry(bot.radius + 0.12, bot.radius + 0.26, 40), this.ringMat);
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.02;
    this.group.add(this.ring);
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
    }
    this.addArmor(L.armor);
  }

  /** Armor plating: one riveted side plate per level, alternating sides, front to back. */
  private addArmor(level: number) {
    if (level <= 0) return;
    const plateMat = this.mat(0x4a4f5a, { roughness: 0.42, metalness: 0.92 });
    const r = this.bot.radius;
    for (let i = 0; i < level; i++) {
      const side = i % 2 === 0 ? 1 : -1;
      const x = 0.25 - Math.floor(i / 2) * 0.32;
      const z = side * (r * 0.62 + 0.02);
      const plate = this.box(0.3, 0.2, 0.06, plateMat, x, 0.5, z);
      plate.rotation.x = side * 0.1;
      for (const dx of [-0.1, 0.1]) {
        const rivet = new THREE.Mesh(new THREE.SphereGeometry(0.022, 6, 6), STEEL);
        rivet.position.set(x + dx, 0.5, z + side * 0.035);
        this.body.add(rivet);
      }
    }
  }

  private mat(color: number, extra: Partial<THREE.MeshStandardMaterialParameters> = {}): THREE.MeshStandardMaterial {
    const m = new THREE.MeshStandardMaterial({ color, roughness: 0.45, metalness: 0.6, ...extra });
    this.bodyMats.push(m);
    return m;
  }

  private addWheels(x: number, z: number, r: number, w: number, count = 2) {
    for (let i = 0; i < count; i++) {
      const xi = count === 1 ? 0 : x * (i === 0 ? 1 : -1);
      for (const side of [-1, 1]) {
        const wh = wheel(r * this.wheelScale, w);
        wh.position.set(xi, r * this.wheelScale, side * z);
        this.body.add(wh);
        this.wheels.push(wh);
      }
    }
  }

  private box(w: number, h: number, d: number, m: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.body.add(mesh);
    return mesh;
  }

  /** RIPSAW: wedge chassis, yellow/black hazard livery, big vertical disc up front. */
  private buildSaw() {
    const c = this.bot.def.color;
    const main = this.mat(c);
    const trim = this.mat(this.bot.def.accent, { roughness: 0.6 });
    this.box(1.1, 0.34, 1.05, main, -0.1, 0.36);
    // sloped nose
    const nose = this.box(0.7, 0.3, 1.0, trim, 0.5, 0.3);
    nose.rotation.z = 0.35;
    this.box(0.5, 0.12, 0.6, trim, -0.5, 0.6); // rear motor hump
    // Blade pylons
    this.box(0.08, 0.5, 0.1, STEEL, 0.55, 0.62, 0.14);
    this.box(0.08, 0.5, 0.1, STEEL, 0.55, 0.62, -0.14);
    this.blade = new THREE.Group();
    this.blade.position.set(this.bot.radius + 0.22, 0.62, 0);
    this.blade.scale.setScalar(this.rigScale);
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.56, 0.56, 0.07, 32), STEEL);
    disc.rotation.x = Math.PI / 2; // axis along z: disc stands vertical, facing forward
    disc.castShadow = true;
    this.blade.add(disc);
    const toothMat = this.mat(0xe8ecf2, { metalness: 1, roughness: 0.2 });
    for (let t = 0; t < 16; t++) {
      const a = (t / 16) * Math.PI * 2;
      const tooth = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.18, 0.09), toothMat);
      tooth.position.set(Math.cos(a) * 0.6, Math.sin(a) * 0.6, 0);
      tooth.rotation.z = a + 0.5;
      this.blade.add(tooth);
    }
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.12, 12), DARK_STEEL);
    hub.rotation.x = Math.PI / 2;
    this.blade.add(hub);
    this.body.add(this.blade);
    this.addWheels(0.35, 0.56, 0.22, 0.14);
  }

  /** PILEDRIVER: brick of armor with a long hammer arm pivoting at the back. */
  private buildHammer() {
    const main = this.mat(this.bot.def.color, { roughness: 0.55, metalness: 0.5 });
    const trim = this.mat(this.bot.def.accent, { roughness: 0.5, metalness: 0.8 });
    this.box(1.5, 0.55, 1.35, main, 0, 0.42);
    this.box(1.6, 0.1, 1.45, trim, 0, 0.72); // top plate
    this.box(0.3, 0.3, 1.4, trim, 0.78, 0.3); // front bumper
    // Rivets
    const rivet = new THREE.SphereGeometry(0.04, 6, 6);
    for (let i = -2; i <= 2; i++) {
      for (const z of [-0.62, 0.62]) {
        const r = new THREE.Mesh(rivet, STEEL);
        r.position.set(i * 0.3, 0.78, z);
        this.body.add(r);
      }
    }
    // Pivot tower
    this.box(0.25, 0.5, 0.3, trim, -0.5, 0.95, 0.22);
    this.box(0.25, 0.5, 0.3, trim, -0.5, 0.95, -0.22);
    this.hammerArm = new THREE.Group();
    this.hammerArm.position.set(-0.5, 1.12, 0);
    this.hammerArm.scale.set(1, this.rigScale, this.rigScale);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.14, 0.22), STEEL);
    arm.position.set(0.95, 0, 0);
    arm.castShadow = true;
    this.hammerArm.add(arm);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.42, 0.55), trim);
    head.scale.setScalar(this.rigScale);
    head.position.set(1.95, -0.05, 0);
    head.castShadow = true;
    this.hammerArm.add(head);
    const spike = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.3, 8), STEEL);
    spike.position.set(1.95, -0.4, 0);
    spike.rotation.x = Math.PI;
    this.hammerArm.add(spike);
    const piston = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.9, 10), HUB_MAT);
    piston.position.set(0.35, -0.3, 0);
    piston.rotation.z = 0.9;
    this.hammerArm.add(piston);
    this.body.add(this.hammerArm);
    this.addWheels(0.5, 0.74, 0.26, 0.2);
  }

  /** CLAMP: teal chassis, two hydraulic jaws at the front, a crushing claw on top. */
  private buildGrabber() {
    const main = this.mat(this.bot.def.color, { roughness: 0.4, metalness: 0.6 });
    const trim = this.mat(this.bot.def.accent, { roughness: 0.6 });
    this.box(1.25, 0.4, 1.15, main, -0.1, 0.38);
    this.box(0.8, 0.14, 0.9, trim, -0.2, 0.66);
    this.box(0.4, 0.3, 0.3, trim, -0.55, 0.85); // hydraulic reservoir
    const cyl = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.6, 10), HUB_MAT);
    cyl.rotation.z = Math.PI / 2;
    cyl.position.set(-0.1, 0.85, 0);
    this.body.add(cyl);
    const makeJaw = (side: number) => {
      const g = new THREE.Group();
      g.position.set(0.5, 0.42, side * 0.5);
      const arm = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.18, 0.14), STEEL);
      arm.position.set(0.55, 0, 0);
      arm.castShadow = true;
      g.add(arm);
      const tip = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.3, 0.14), trim);
      tip.position.set(1.08, 0, side * -0.05);
      tip.rotation.y = side * 0.5;
      g.add(tip);
      for (let i = 0; i < 3; i++) {
        const tooth = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.14, 6), STEEL);
        tooth.position.set(0.5 + i * 0.25, 0, -side * 0.1);
        tooth.rotation.x = side * (Math.PI / 2);
        g.add(tooth);
      }
      this.body.add(g);
      return g;
    };
    this.jawL = makeJaw(1);
    this.jawR = makeJaw(-1);
    this.jawL.scale.set(this.rigScale, this.rigScale, 1);
    this.jawR.scale.set(this.rigScale, this.rigScale, 1);
    this.claw = new THREE.Group();
    this.claw.position.set(0.35, 0.9, 0);
    const clawArm = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.12, 0.18), STEEL);
    clawArm.position.set(0.6, 0, 0);
    this.claw.add(clawArm);
    const clawTip = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.35, 8), trim);
    clawTip.position.set(1.2, -0.2, 0);
    clawTip.rotation.x = Math.PI;
    this.claw.add(clawTip);
    this.body.add(this.claw);
    this.addWheels(0.4, 0.62, 0.24, 0.18);
  }

  /** LAUNCHER: low orange wedge, big front plate hinged at its back edge. */
  private buildFlipper() {
    const main = this.mat(this.bot.def.color, { roughness: 0.45, metalness: 0.55 });
    const trim = this.mat(this.bot.def.accent, { roughness: 0.6 });
    this.box(1.1, 0.3, 1.25, main, -0.25, 0.3);
    this.box(0.5, 0.12, 0.7, trim, -0.5, 0.5);
    // Gas tank
    const tank = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.8, 12), HUB_MAT);
    tank.rotation.x = Math.PI / 2;
    tank.position.set(-0.55, 0.62, 0);
    this.body.add(tank);
    // Hinge
    const hinge = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1.3, 10), STEEL);
    hinge.rotation.x = Math.PI / 2;
    hinge.position.set(0.2, 0.42, 0);
    this.body.add(hinge);
    this.plate = new THREE.Group();
    this.plate.position.set(0.2, 0.42, 0);
    this.plate.scale.set(this.rigScale, 1, 1);
    const plate = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.06, 1.25), STEEL);
    plate.position.set(0.48, 0, 0);
    plate.castShadow = true;
    this.plate.add(plate);
    const lip = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 1.25), trim);
    lip.position.set(0.95, 0.02, 0);
    this.plate.add(lip);
    this.body.add(this.plate);
    // Wedge underside
    const wedge = this.box(0.9, 0.22, 1.2, trim, 0.5, 0.17);
    wedge.rotation.z = -0.2;
    this.addWheels(0.35, 0.66, 0.2, 0.16);
  }

  /** Animate from sim state. `dt` is unscaled render delta for smoothness. */
  update(dt: number, time: number, emitSmoke: (p: THREE.Vector3, heavy: boolean) => void) {
    const b = this.bot;
    const pos = toWorld(b.p, b.z);
    this.group.position.copy(pos);
    this.group.rotation.y = b.heading;

    // Pitted: sink and spin away.
    if (b.eliminated === "pitted") {
      this.group.position.y = -b.pitFall * 4.5;
      this.group.rotation.x = b.pitFall * 1.2;
      this.group.rotation.z = b.pitFall * 2.0;
      this.ring.visible = false;
      this.group.visible = b.pitFall < 1;
      return;
    }

    // Lean into acceleration/turns; flop when airborne.
    const speed = Math.hypot(b.vel.x + b.knock.x, b.vel.y + b.knock.y);
    const wantTilt = b.airborne ? Math.sin(time * 6) * 0.5 : -b.steer * Math.min(1, speed / 6) * 0.08;
    this.tilt += (wantTilt - this.tilt) * Math.min(1, dt * 8);
    this.body.rotation.x = this.tilt;
    this.body.rotation.z = b.airborne ? Math.sin(time * 4.3) * 0.5 : b.stun > 0 ? Math.sin(time * 30) * 0.03 : 0;

    this.wheelSpin += (b.controllable ? (b.vel.x * Math.cos(b.heading) + b.vel.y * Math.sin(b.heading)) : 0) * dt * 4;
    for (const w of this.wheels) w.rotation.z = -this.wheelSpin;

    // Health ring
    const hp = b.hpFrac;
    const ringColor = new THREE.Color().setHSL(hp * 0.33, 1, 0.5);
    this.ringMat.color.copy(ringColor);
    this.ringMat.opacity = b.alive ? 0.45 + (b.intent.danger > 0.65 ? Math.sin(time * 14) * 0.25 + 0.25 : 0) : 0.15;

    // Hit flash and destroyed tint
    const sinceHit = time - b.lastDamagedAt;
    const flash = sinceHit < 0.12 ? 1 : 0;
    for (const m of this.bodyMats) {
      m.emissive.setRGB(flash, flash * 0.9, flash * 0.8);
      if (!b.alive && b.eliminated === "destroyed") {
        m.color.lerp(new THREE.Color(0x2a2a2e), Math.min(1, dt * 1.5));
        m.emissive.setRGB(0.25 * Math.max(0, Math.sin(time * 9)), 0.05, 0);
      }
    }

    // Smoke when hurt or dead
    this.smokeTimer -= dt;
    if (this.smokeTimer <= 0 && (hp < 0.4 || !b.alive)) {
      this.smokeTimer = b.alive ? 0.18 + hp * 0.4 : 0.08;
      emitSmoke(pos.clone().add(new THREE.Vector3(-Math.cos(b.heading) * 0.4, 0.6, Math.sin(b.heading) * 0.4)), !b.alive);
    }

    // Weapon rigs
    const w = b.weapon;
    if (this.blade) this.blade.rotation.z -= dt * (2 + w.spin * 70);
    if (this.hammerArm) {
      let ang = 1.15; // raised
      if (w.hammerPhase === "windup") ang = 1.15 + 0.45 * (1 - w.timer / 0.28);
      else if (w.hammerPhase === "strike") ang = -0.22;
      else if (w.hammerPhase === "recover") ang = -0.22 + 1.37 * Math.pow(1 - w.timer / 0.4, 2);
      else if (w.cooldown > 0) ang = 1.15 - 0.15 * Math.sin(time * 2);
      this.hammerArm.rotation.z = this.hammerArm.rotation.z + (ang - this.hammerArm.rotation.z) * Math.min(1, dt * (w.hammerPhase === "strike" ? 60 : 14));
    }
    if (this.jawL && this.jawR && this.claw) {
      const open = b.holding ? 0.08 : w.cooldown > 0 ? 0.25 : 0.6 + Math.sin(time * 3) * 0.05;
      this.jawL.rotation.y += (open - this.jawL.rotation.y) * Math.min(1, dt * 12);
      this.jawR.rotation.y += (-open - this.jawR.rotation.y) * Math.min(1, dt * 12);
      const clawDown = b.holding ? 0.55 + Math.sin(time * 12) * 0.05 : -0.35;
      this.claw.rotation.z += (clawDown - this.claw.rotation.z) * Math.min(1, dt * 10);
    }
    if (this.plate) {
      const a = w.flipAnim;
      const fired = a > 0.75 ? 1 : a > 0 ? Math.pow(a / 0.75, 0.6) : 0;
      this.plate.rotation.z = -(0.08 + fired * 1.25);
    }
  }
}

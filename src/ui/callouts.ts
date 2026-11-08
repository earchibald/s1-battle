import * as THREE from "three";
import type { Vec } from "../sim/math";
import { toWorld } from "../render/scene";

/**
 * Comic-book callouts ("WHAM!", "SHRED!") that pop at a world position for the hits worth shouting about.
 * Pure DOM + CSS; the starburst is a clip-path. Positioned every frame like the labels.
 */

const WORDS = {
  saw: ["SHRED!", "RRRIP!", "BUZZKILL!", "SHREEEK!"],
  hammer: ["WHAM!", "KRUNCH!", "SLAM!", "CLONK!"],
  flip: ["YEET!", "LAUNCHED!", "AIRMAIL!"],
  landing: ["SPLAT!", "THUD!", "OOF!"],
  wall: ["CLANG!", "KRANG!", "WALLOP!"],
  saws: ["GRIND!", "CHEWED!"],
  crush: ["SQUEEZE!", "CRUNCH!"],
  pitted: ["BYE-BYE!", "SEE YA!", "GONE!"],
  destroyed: ["K.O.!", "WRECKED!", "SCRAPPED!"],
  crit: ["CRITICAL!", "DEVASTATING!", "BRUTAL!"],
} as const;
export type CalloutKind = keyof typeof WORDS;

const pick = <T>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)];

interface Callout {
  el: HTMLElement;
  pos: THREE.Vector3;
  life: number;
  max: number;
  drift: number;
}

export class Callouts {
  private items: Callout[] = [];
  private v = new THREE.Vector3();
  private lastAt = 0;
  constructor(private container: HTMLElement, private camera: THREE.Camera) {}

  /**
   * `size` 1 = normal, 2 = huge. `crit` adds a "CRITICAL!" ribbon. Rate-limited so a saw grinding on a
   * wreck doesn't carpet the screen.
   */
  show(at: Vec, kind: CalloutKind, opts: { size?: number; crit?: boolean; color?: string; now: number }) {
    const { now } = opts;
    if (now - this.lastAt < 0.18 && !opts.crit && (opts.size ?? 1) < 2) return;
    this.lastAt = now;
    const el = document.createElement("div");
    el.className = `callout ${kind}${opts.crit ? " crit" : ""}`;
    el.style.setProperty("--rot", `${(Math.random() * 24 - 12).toFixed(1)}deg`);
    el.style.setProperty("--size", String(opts.size ?? 1));
    if (opts.color) el.style.setProperty("--c", opts.color);
    const word = pick(WORDS[kind]);
    el.innerHTML = `${opts.crit ? `<div class="callout-crit">${pick(WORDS.crit)}</div>` : ""}<div class="callout-word">${word}</div>`;
    this.container.appendChild(el);
    const max = 0.9 + (opts.size ?? 1) * 0.35 + (opts.crit ? 0.4 : 0);
    this.items.push({ el, pos: toWorld(at, 1.6 + Math.random() * 0.6), life: max, max, drift: 0.6 + Math.random() * 0.4 });
  }

  update(dt: number) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const c = this.items[i];
      c.life -= dt;
      if (c.life <= 0) {
        c.el.remove();
        this.items.splice(i, 1);
        continue;
      }
      c.pos.y += dt * c.drift;
      this.v.copy(c.pos).project(this.camera);
      const x = (this.v.x * 0.5 + 0.5) * window.innerWidth;
      const y = (-this.v.y * 0.5 + 0.5) * window.innerHeight;
      const t = 1 - c.life / c.max;
      // Pop in fast (overshoot), hold, fade out.
      const pop = t < 0.12 ? 0.4 + (t / 0.12) * 0.8 : t < 0.2 ? 1.2 - ((t - 0.12) / 0.08) * 0.2 : 1;
      const fade = c.life < 0.3 ? c.life / 0.3 : 1;
      c.el.style.transform = `translate(-50%, -50%) translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) rotate(var(--rot)) scale(${(pop * (0.9 + 0.3 * Number(c.el.style.getPropertyValue("--size")))).toFixed(3)})`;
      c.el.style.opacity = fade.toFixed(2);
      c.el.style.display = this.v.z < 1 ? "" : "none";
    }
  }
}

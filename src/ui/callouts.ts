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
  spinner: ["WHANG!", "SPIN-OUT!", "SMACK!", "BOING!"],
  torch: ["FWOOSH!", "SIZZLE!", "TOASTY!", "CRISPY!"],
  ram: ["WHUMP!", "BULLDOZED!", "SHUNT!", "FLATTENED!"],
  pitted: ["BYE-BYE!", "SEE YA!", "GONE!"],
  destroyed: ["K.O.!", "WRECKED!", "SCRAPPED!"],
  crit: ["CRITICAL!", "DEVASTATING!", "BRUTAL!"],
} as const;
export type CalloutKind = keyof typeof WORDS;

const pick = <T>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)];

interface Callout {
  el: HTMLElement;
  pos: THREE.Vector3;
  /** Screen-space offset from the anchor, chosen once so the burst sits beside the action, not on it. */
  dx: number;
  dy: number;
  life: number;
  max: number;
  drift: number;
}

/** Screen regions the HUD occupies; callouts stay out of them. */
const HUD_LEFT = 300;
const HUD_RIGHT_TICKER = 380;
const HUD_TOP = 90;
const HUD_BOTTOM = 110;

export class Callouts {
  private items: Callout[] = [];
  private v = new THREE.Vector3();
  private lastAt = 0;
  /**
   * @param avoid world points the callout should keep clear of (the bots), queried at show time.
   */
  constructor(private container: HTMLElement, private camera: THREE.Camera, private avoid: () => Vec[]) {}

  private toScreen(p: THREE.Vector3): { x: number; y: number } {
    this.v.copy(p).project(this.camera);
    return { x: (this.v.x * 0.5 + 0.5) * window.innerWidth, y: (-this.v.y * 0.5 + 0.5) * window.innerHeight };
  }

  /** Pick the offset around the anchor that is farthest from every bot, other callouts, and the HUD. */
  private placeOffset(anchor: { x: number; y: number }, size: number): { dx: number; dy: number } {
    const W = window.innerWidth;
    const H = window.innerHeight;
    const obstacles = this.avoid().map((p) => this.toScreen(toWorld(p, 0.6)));
    for (const c of this.items) {
      const s = this.toScreen(c.pos);
      obstacles.push({ x: s.x + c.dx, y: s.y + c.dy });
    }
    const halfW = 90 * size;
    const halfH = 40 * size;
    let best = { dx: 0, dy: -120 };
    let bestScore = -Infinity;
    for (const radius of [130, 190, 250]) {
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2 - Math.PI / 2;
        const dx = Math.cos(a) * radius;
        const dy = Math.sin(a) * radius * 0.7;
        const x = anchor.x + dx;
        const y = anchor.y + dy;
        let score = Infinity;
        for (const o of obstacles) score = Math.min(score, Math.hypot(x - o.x, y - o.y));
        // Clear of the HUD and the viewport edges, else heavy penalty.
        const inTicker = y > H * 0.45 && x + halfW > W - HUD_RIGHT_TICKER;
        const inJevPanel = y - halfH < 160 && x + halfW > W - 250;
        if (inJevPanel || x - halfW < HUD_LEFT || x + halfW > W - 20 || y - halfH < HUD_TOP || y + halfH > H - HUD_BOTTOM || inTicker) score -= 1000;
        // Mild preference for closer, upward placements so the burst still reads as "about that hit".
        score -= radius * 0.35 + Math.max(0, dy) * 0.3;
        if (score > bestScore) {
          bestScore = score;
          best = { dx, dy };
        }
      }
    }
    return best;
  }

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
    const pos = toWorld(at, 1.2);
    const { dx, dy } = this.placeOffset(this.toScreen(pos), opts.size ?? 1);
    this.items.push({ el, pos, dx, dy, life: max, max, drift: 0.4 + Math.random() * 0.3 });
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
      const x = (this.v.x * 0.5 + 0.5) * window.innerWidth + c.dx;
      const y = (-this.v.y * 0.5 + 0.5) * window.innerHeight + c.dy;
      const t = 1 - c.life / c.max;
      // Pop in fast (overshoot), hold, fade out.
      const pop = t < 0.12 ? 0.4 + (t / 0.12) * 0.8 : t < 0.2 ? 1.2 - ((t - 0.12) / 0.08) * 0.2 : 1;
      const fade = c.life < 0.3 ? c.life / 0.3 : 1;
      c.el.style.transform = `translate(-50%, -50%) translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) rotate(var(--rot)) scale(${(pop * (0.75 + 0.2 * Number(c.el.style.getPropertyValue("--size")))).toFixed(3)})`;
      c.el.style.opacity = fade.toFixed(2);
      c.el.style.display = this.v.z < 1 ? "" : "none";
    }
  }
}

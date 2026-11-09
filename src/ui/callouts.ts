import * as THREE from "three";
import type { Vec } from "../sim/math";
import { toWorld } from "../render/scene";
import type { CalloutKind, CalloutPick } from "./calloutPolicy";

/**
 * Comic-book callouts ("WHAM!", "K.O.!") that pop beside the action for the few moments worth shouting about.
 * Which moments qualify is decided by CalloutDirector (calloutPolicy.ts); this file only draws them.
 * One short word in a starburst, an optional CRIT badge, and a plain caption saying who did what to whom.
 */

const WORDS: Record<CalloutKind, readonly string[]> = {
  saw: ["SHRED!", "RRRIP!"],
  hammer: ["WHAM!", "KRUNCH!"],
  flip: ["YEET!", "FLIPPED!"],
  landing: ["SPLAT!", "THUD!"],
  wall: ["CLANG!", "KRANG!"],
  saws: ["GRIND!"],
  crush: ["CRUNCH!"],
  spinner: ["WHANG!", "SMACK!"],
  torch: ["FWOOSH!", "TOAST!"],
  ram: ["WHUMP!", "SLAM!"],
  vent: ["FWOOSH!"],
  shock: ["ZAP!"],
  pitted: ["PITTED!"],
  destroyed: ["K.O.!"],
};

const pick = <T>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)];

function div(cls: string, text: string): HTMLDivElement {
  const d = document.createElement("div");
  d.className = cls;
  d.textContent = text;
  return d;
}

interface Callout {
  el: HTMLElement;
  pos: THREE.Vector3;
  /** Screen-space offset from the anchor, chosen once so the burst sits beside the action, not on it. */
  dx: number;
  dy: number;
  life: number;
  max: number;
  size: number;
  priority: number;
}

/** HUD panels callouts must not cover; measured at show time so open/closed panels are respected. */
const BLOCKERS = ".hud-cards, .hud-side, .hud-top, .hud-controls, .hud-ticker .line, .evlog, .hud-news:not(.hidden)";
/** At most this many on screen; the oldest makes room. */
const MAX_VISIBLE = 2;

export class Callouts {
  private items: Callout[] = [];
  private v = new THREE.Vector3();
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
    const halfW = 100 * size;
    const halfH = 52 * size;
    const pad = 8;
    const blockers = [...document.querySelectorAll(BLOCKERS)].map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0);
    const blocked = (x: number, y: number) =>
      blockers.some((r) => x + halfW > r.left - pad && x - halfW < r.right + pad && y + halfH > r.top - pad && y - halfH < r.bottom + pad);
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
        if (blocked(x, y) || x - halfW < 10 || x + halfW > W - 10 || y - halfH < 10 || y + halfH > H - 10) score -= 1000;
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

  private remove(i: number) {
    this.items[i].el.remove();
    this.items.splice(i, 1);
  }

  show(at: Vec, c: CalloutPick) {
    // An elimination outranks everything on screen: clear the lesser bursts so the K.O. reads alone.
    for (let i = this.items.length - 1; i >= 0; i--) if (this.items[i].priority < c.priority) this.remove(i);
    while (this.items.length >= MAX_VISIBLE) this.remove(0);
    const el = document.createElement("div");
    el.className = `callout ${c.kind}${c.crit ? " crit" : ""}`;
    el.style.setProperty("--rot", `${(Math.random() * 14 - 7).toFixed(1)}deg`);
    if (c.crit) el.append(div("callout-crit", "CRIT"));
    el.append(div("callout-word", pick(WORDS[c.kind])), div("callout-caption", c.caption));
    this.container.appendChild(el);
    const max = 1.6 + c.size * 0.4;
    const pos = toWorld(at, 1.2);
    const { dx, dy } = this.placeOffset(this.toScreen(pos), c.size);
    this.items.push({ el, pos, dx, dy, life: max, max, size: c.size, priority: c.priority });
  }

  clear() {
    for (let i = this.items.length - 1; i >= 0; i--) this.remove(i);
  }

  update(dt: number) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const c = this.items[i];
      c.life -= dt;
      if (c.life <= 0) {
        this.remove(i);
        continue;
      }
      c.pos.y += dt * 0.25;
      this.v.copy(c.pos).project(this.camera);
      const x = (this.v.x * 0.5 + 0.5) * window.innerWidth + c.dx;
      const y = (-this.v.y * 0.5 + 0.5) * window.innerHeight + c.dy;
      const t = 1 - c.life / c.max;
      // Pop in fast (overshoot), hold, fade out.
      const pop = t < 0.08 ? 0.4 + (t / 0.08) * 0.8 : t < 0.14 ? 1.2 - ((t - 0.08) / 0.06) * 0.2 : 1;
      const fade = c.life < 0.35 ? c.life / 0.35 : 1;
      c.el.style.transform = `translate(-50%, -50%) translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) rotate(var(--rot)) scale(${(pop * (0.7 + 0.25 * c.size)).toFixed(3)})`;
      c.el.style.opacity = fade.toFixed(2);
      c.el.style.display = this.v.z < 1 ? "" : "none";
    }
  }
}

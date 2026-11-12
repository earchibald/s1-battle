import * as THREE from "three";
import type { Bot } from "../sim/bot";
import type { Vec } from "../sim/math";
import { toWorld } from "../render/scene";

interface Tag {
  root: HTMLElement;
  chip: HTMLElement;
  bubble: HTMLElement;
  hp: HTMLElement;
  ghost: HTMLElement;
  status: HTMLElement;
  until: number;
  /** Lagging HP fraction: the white "recent damage" segment drains down to the real value after a beat. */
  ghostFrac: number;
  ghostHold: number;
  lastHp: number;
  lastStatus: string;
  /** Chip width in px, for decluttering; re-measured when the status text changes. */
  width?: number;
  bubbleWidth?: number;
}

function el(tag: string, cls: string, parent?: HTMLElement): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  parent?.appendChild(e);
  return e;
}

/**
 * HTML overlays positioned over world points: a name chip with an HP bar and status flag over each bot, the
 * brain's decision bubble above it, and floating damage numbers.
 */
export class Labels {
  private tags = new Map<string, Tag>();
  private floaters: { el: HTMLElement; pos: THREE.Vector3; life: number; drift: number }[] = [];
  private v = new THREE.Vector3();

  constructor(private container: HTMLElement, private camera: THREE.Camera) {}

  ensure(bot: Bot) {
    if (this.tags.has(bot.id)) return;
    const root = el("div", "tag");
    root.style.setProperty("--c", "#" + bot.def.color.toString(16).padStart(6, "0"));
    const bubble = el("div", "bubble", root);
    const chip = el("div", "tag-chip", root);
    const row = el("div", "tag-row", chip);
    el("span", "tag-name", row).textContent = bot.id;
    const status = el("span", "tag-status", row);
    const bar = el("div", "tag-hp", chip);
    const ghost = el("i", "ghost", bar);
    const hp = el("i", "fill", bar);
    this.container.appendChild(root);
    this.tags.set(bot.id, { root, chip, bubble, hp, ghost, status, until: 0, ghostFrac: bot.hpFrac, ghostHold: 0, lastHp: bot.hpFrac, lastStatus: "" });
  }

  say(botId: string, text: string, source: "jev" | "baseline" | "fallback" | "trained", now: number) {
    const t = this.tags.get(botId);
    if (!t) return;
    t.bubble.textContent = text;
    t.bubble.dataset.source = source;
    t.bubble.classList.add("show");
    t.until = now + 2.4;
    t.bubbleWidth = t.bubble.offsetWidth || undefined; // measured once per decision, for decluttering
  }

  damage(at: Vec, amount: number, cls: string) {
    const f = el("div", `floater ${cls}`);
    f.textContent = `-${Math.round(amount)}`;
    this.container.appendChild(f);
    this.floaters.push({ el: f, pos: toWorld(at, 1.2), life: 1.1, drift: (Math.random() - 0.5) * 0.8 });
  }

  private project(p: THREE.Vector3): { x: number; y: number; visible: boolean } {
    this.v.copy(p).project(this.camera);
    return { x: (this.v.x * 0.5 + 0.5) * window.innerWidth, y: (-this.v.y * 0.5 + 0.5) * window.innerHeight, visible: this.v.z < 1 };
  }

  private statusOf(b: Bot): string {
    if (!b.alive) return b.eliminated === "pitted" ? "PITTED" : "WRECKED";
    if (b.heldBy) return "HELD";
    if (b.burn > 0) return "ON FIRE";
    if (b.airborne) return "AIRBORNE";
    if (b.stun > 0) return "DAZED";
    return "";
  }

  update(bots: Bot[], dt: number, now: number) {
    for (const [id, t] of this.tags) {
      if (!bots.some((b) => b.id === id)) {
        t.root.remove();
        this.tags.delete(id);
      }
    }
    const placed: { t: Tag; x: number; y: number; w: number; h: number }[] = [];
    for (const b of bots) {
      this.ensure(b);
      const t = this.tags.get(b.id)!;
      if (!b.alive && (b.eliminated === "pitted" ? b.pitFall > 0.3 : false)) {
        t.root.style.display = "none";
        continue;
      }
      const s = this.project(toWorld(b.p, b.z + 1.75));
      t.root.style.display = s.visible ? "" : "none";
      t.root.classList.toggle("dead", !b.alive);
      if (now > t.until) t.bubble.classList.remove("show");
      const talking = t.bubble.classList.contains("show");
      const w = Math.max(t.width ?? 110, talking ? (t.bubbleWidth ?? 160) : 0);
      if (s.visible) placed.push({ t, x: s.x, y: s.y, w, h: talking ? 62 : 38 });

      // HP bar with a draining "recent damage" ghost, colored by how much is left.
      const hp = b.alive ? b.hpFrac : 0;
      if (hp < t.lastHp - 1e-4) {
        t.ghostHold = 0.45;
        t.chip.classList.remove("hit");
        void t.chip.offsetWidth; // restart the hit pulse
        t.chip.classList.add("hit");
      }
      t.lastHp = hp;
      if (t.ghostHold > 0) t.ghostHold -= dt;
      else t.ghostFrac = Math.max(hp, t.ghostFrac - dt * 0.8);
      if (t.ghostFrac < hp) t.ghostFrac = hp;
      t.hp.style.width = `${(hp * 100).toFixed(1)}%`;
      t.hp.style.background = hp > 0.6 ? "#4ade80" : hp > 0.3 ? "#fbbf24" : "#f87171";
      t.ghost.style.width = `${(t.ghostFrac * 100).toFixed(1)}%`;
      t.chip.classList.toggle("low", b.alive && hp < 0.3);

      const status = this.statusOf(b);
      if (status !== t.lastStatus || t.width === undefined) {
        t.status.textContent = status;
        t.status.dataset.kind = status.toLowerCase().replace(" ", "-");
        t.lastStatus = status;
        t.width = t.chip.offsetWidth || undefined; // measured only when the text changes, not every frame
      }
    }
    // Declutter: when bots bunch up, stack their tags instead of letting them overprint. The tag lower on screen
    // (nearer the camera) keeps its spot; the other one moves up.
    for (let pass = 0; pass < 3; pass++) {
      for (let i = 0; i < placed.length; i++) {
        for (let j = 0; j < placed.length; j++) {
          if (i === j) continue;
          const a = placed[i];
          const c = placed[j];
          if (a.y > c.y || (a.y === c.y && i > j)) continue; // a is the upper one
          const overlapX = Math.abs(a.x - c.x) < (a.w + c.w) / 2 + 4;
          const gap = c.y - a.y;
          if (overlapX && gap < c.h) a.y = c.y - c.h;
        }
      }
    }
    for (const p of placed) p.t.root.style.transform = `translate(-50%, -100%) translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px)`;
    for (let i = this.floaters.length - 1; i >= 0; i--) {
      const f = this.floaters[i];
      f.life -= dt;
      if (f.life <= 0) {
        f.el.remove();
        this.floaters.splice(i, 1);
        continue;
      }
      f.pos.y += dt * 1.3;
      f.pos.x += dt * f.drift;
      const s = this.project(f.pos);
      const age = 1.1 - f.life;
      // Pop in big, settle, then fade.
      const scale = age < 0.12 ? 0.6 + (age / 0.12) * 0.7 : 1.3 - Math.min(0.3, (age - 0.12) * 0.9);
      f.el.style.transform = `translate(-50%, -50%) translate(${s.x.toFixed(1)}px, ${s.y.toFixed(1)}px) scale(${scale.toFixed(3)})`;
      f.el.style.opacity = String(Math.min(1, f.life * 2.2));
    }
  }
}

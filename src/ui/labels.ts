import * as THREE from "three";
import type { Bot } from "../sim/bot";
import type { Vec } from "../sim/math";
import { toWorld } from "../render/scene";

/** HTML overlays positioned over world points: name tags, decision bubbles, floating damage numbers. */
export class Labels {
  private tags = new Map<string, { root: HTMLElement; name: HTMLElement; bubble: HTMLElement; until: number }>();
  private floaters: { el: HTMLElement; pos: THREE.Vector3; life: number }[] = [];
  private v = new THREE.Vector3();

  constructor(private container: HTMLElement, private camera: THREE.Camera) {}

  ensure(bot: Bot) {
    if (this.tags.has(bot.id)) return;
    const root = document.createElement("div");
    root.className = "tag";
    const name = document.createElement("div");
    name.className = "tag-name";
    name.textContent = bot.id;
    name.style.setProperty("--c", "#" + bot.def.color.toString(16).padStart(6, "0"));
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    root.append(bubble, name);
    this.container.appendChild(root);
    this.tags.set(bot.id, { root, name, bubble, until: 0 });
  }

  say(botId: string, text: string, source: "jev" | "baseline" | "fallback", now: number) {
    const t = this.tags.get(botId);
    if (!t) return;
    t.bubble.textContent = text;
    t.bubble.dataset.source = source;
    t.bubble.classList.add("show");
    t.until = now + 2.4;
  }

  damage(at: Vec, amount: number, cls: string) {
    const el = document.createElement("div");
    el.className = `floater ${cls}`;
    el.textContent = `-${Math.round(amount)}`;
    this.container.appendChild(el);
    this.floaters.push({ el, pos: toWorld(at, 1.2), life: 1.0 });
  }

  private project(p: THREE.Vector3): { x: number; y: number; visible: boolean } {
    this.v.copy(p).project(this.camera);
    return { x: (this.v.x * 0.5 + 0.5) * window.innerWidth, y: (-this.v.y * 0.5 + 0.5) * window.innerHeight, visible: this.v.z < 1 };
  }

  update(bots: Bot[], dt: number, now: number) {
    for (const b of bots) {
      this.ensure(b);
      const t = this.tags.get(b.id)!;
      if (!b.alive && (b.eliminated === "pitted" ? b.pitFall > 0.3 : false)) {
        t.root.style.display = "none";
        continue;
      }
      const s = this.project(toWorld(b.p, b.z + 1.5));
      t.root.style.display = s.visible ? "" : "none";
      t.root.style.transform = `translate(-50%, -100%) translate(${s.x.toFixed(1)}px, ${s.y.toFixed(1)}px)`;
      t.root.classList.toggle("dead", !b.alive);
      if (now > t.until) t.bubble.classList.remove("show");
    }
    for (let i = this.floaters.length - 1; i >= 0; i--) {
      const f = this.floaters[i];
      f.life -= dt;
      if (f.life <= 0) {
        f.el.remove();
        this.floaters.splice(i, 1);
        continue;
      }
      f.pos.y += dt * 1.4;
      const s = this.project(f.pos);
      f.el.style.transform = `translate(-50%, -50%) translate(${s.x.toFixed(1)}px, ${s.y.toFixed(1)}px) scale(${0.8 + (1 - f.life) * 0.5})`;
      f.el.style.opacity = String(Math.min(1, f.life * 2));
    }
  }
}

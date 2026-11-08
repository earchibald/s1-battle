import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import type { BotBuild, Condition, PartKey, Rule, Speculative, SubjectKey, SubjectType, TargetSel } from "@shared/build";
import {
  BUDGET,
  LEVEL_COST,
  MAX_LEVEL,
  PART_INFO,
  PART_KEYS,
  SUBJECTS,
  SUBJECT_BY_KEY,
  TARGET_SELS,
  TECHNIQUES,
  TECHNIQUE_BY_M,
  WEAPONS,
  cloneBuild,
  costOf,
  derive,
  fmtLevelValue,
  normalizeBuild,
  techniqueAllowed,
  validateBuild,
} from "@shared/build";
import { STOCK_BUILDS, defaultTechniqueLogic, stockBuild } from "@shared/bots/index";
import { buildQuestions, defFromBuild, evalCondition, makeContext } from "@shared/logic";
import type { BotKind, Maneuver } from "@shared/types";
import { BOT_KINDS } from "@shared/types";
import type { Brain } from "../brain/brains";
import { BotMesh } from "../render/botMesh";
import { Bot } from "../sim/bot";
import { sense } from "../sim/perception";
import { median, quickSim } from "../sim/quicksim";
import type { World } from "../sim/world";
import { WEAPON_ICON, maneuverLabel } from "./hud";

/**
 * The Garage: a full-screen designer for the four roster slots. Left: a live 3D turntable of the build.
 * Center: BUILD (weapon system, parts, techniques), BASELINE BRAIN (the rule tree) and JEV BRAIN (gates,
 * descriptions, prompts, speculative questions). Right: the spec sheet, budget, problems and a quick sim.
 *
 * Brain edits apply live to the bot fighting right now; part changes need a redeploy because they change
 * the body. While a match runs, the rule tree and gates light up with the conditions that hold this instant.
 */

export interface DesignerCallbacks {
  /** Start a new match with the current roster. */
  deploy(): void;
  /** Push brain-only changes (logic + techniques) into the bot that is fighting right now. */
  applyLive(slot: number, build: BotBuild): void;
  botForSlot(slot: number): Bot | undefined;
  brainForSlot(slot: number): Brain | undefined;
  world(): World | undefined;
  onChange(builds: BotBuild[]): void;
  toast(text: string): void;
}

type Tab = "build" | "baseline" | "jev";

const SWATCHES = [0xe6a92b, 0xd13b3b, 0x2dd4bf, 0xff7a1a, 0x6ee7ff, 0xb57bff, 0x7cff6e, 0xff5fa2, 0xf4f4f4, 0x8b93a7];
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const hex = (c: number) => "#" + c.toString(16).padStart(6, "0");
const uid = () => Math.random().toString(36).slice(2, 7);

export class Designer {
  open = false;
  builds: BotBuild[];
  private slot = 0;
  private tab: Tab = "build";
  private root: HTMLElement;
  private editorEl!: HTMLElement;
  private specEl!: HTMLElement;
  private previewEl!: HTMLElement;
  private rosterEl!: HTMLElement;
  private liveAcc = 0;
  private simRunning = false;
  private simHtml = "";

  // 3D preview
  private pRenderer: THREE.WebGLRenderer | null = null;
  private pScene = new THREE.Scene();
  private pCamera = new THREE.PerspectiveCamera(32, 1, 0.1, 50);
  private pMesh: BotMesh | null = null;
  private pBot: Bot | null = null;
  private pTime = 0;

  constructor(root: HTMLElement, builds: BotBuild[], private cb: DesignerCallbacks) {
    this.root = root;
    this.builds = builds;
    root.className = "dz hidden";
    root.innerHTML = `
      <div class="dz-shell">
        <header class="dz-head">
          <div class="dz-brand">
            <div class="dz-kicker">S1 ARENA</div>
            <h1>GARAGE</h1>
            <div class="dz-sub">Build the machine. Write the mind.</div>
          </div>
          <nav class="dz-roster" id="dz-roster"></nav>
          <div class="dz-actions">
            <button data-a="sim" title="Run 12 headless matches with the current roster (baseline brains)">⚗ Simulate</button>
            <button data-a="import">⇪ Import</button>
            <button data-a="export">⇩ Export</button>
            <button data-a="deploy" class="primary">DEPLOY ▶</button>
            <button data-a="close" class="dz-close" title="Esc">✕</button>
            <input type="file" accept="application/json" id="dz-file" hidden />
          </div>
        </header>
        <div class="dz-body">
          <aside class="dz-preview" id="dz-preview"></aside>
          <main class="dz-editor">
            <nav class="dz-tabs">
              <button data-tab="build">BUILD</button>
              <button data-tab="baseline">BASELINE BRAIN</button>
              <button data-tab="jev">JEV BRAIN</button>
            </nav>
            <div class="dz-editor-body" id="dz-editor"></div>
          </main>
          <aside class="dz-spec" id="dz-spec"></aside>
        </div>
      </div>`;
    this.editorEl = root.querySelector("#dz-editor")!;
    this.specEl = root.querySelector("#dz-spec")!;
    this.previewEl = root.querySelector("#dz-preview")!;
    this.rosterEl = root.querySelector("#dz-roster")!;
    root.querySelectorAll<HTMLButtonElement>(".dz-tabs button").forEach((b) => (b.onclick = () => this.setTab(b.dataset.tab as Tab)));
    root.querySelector<HTMLButtonElement>('[data-a="close"]')!.onclick = () => this.hide();
    root.querySelector<HTMLButtonElement>('[data-a="deploy"]')!.onclick = () => this.deploy();
    root.querySelector<HTMLButtonElement>('[data-a="export"]')!.onclick = () => this.exportJson();
    root.querySelector<HTMLButtonElement>('[data-a="sim"]')!.onclick = () => void this.simulate();
    const file = root.querySelector<HTMLInputElement>("#dz-file")!;
    root.querySelector<HTMLButtonElement>('[data-a="import"]')!.onclick = () => file.click();
    file.onchange = () => {
      const f = file.files?.[0];
      if (!f) return;
      void f.text().then((t) => this.importJson(t));
      file.value = "";
    };
    this.buildPreview();
  }

  get b(): BotBuild {
    return this.builds[this.slot];
  }

  /* ------------------------------------------------------------------ open / close --------------- */

  show() {
    this.open = true;
    this.root.classList.remove("hidden");
    this.renderAll();
    requestAnimationFrame(() => this.resizePreview());
  }
  hide() {
    this.open = false;
    this.root.classList.add("hidden");
  }
  toggle() {
    this.open ? this.hide() : this.show();
  }

  private setTab(t: Tab) {
    this.tab = t;
    this.root.querySelectorAll<HTMLButtonElement>(".dz-tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === t));
    this.renderEditor();
  }
  private select(slot: number) {
    this.slot = slot;
    this.renderAll();
  }

  /* ------------------------------------------------------------------ state changes --------------- */

  /** `structural`: re-render the editor. Brain edits are pushed live; everything is persisted. */
  private changed(structural = false, brain = true) {
    this.cb.onChange(this.builds);
    if (brain) this.cb.applyLive(this.slot, this.b);
    this.renderSpec();
    this.renderRoster();
    if (structural) this.renderEditor();
  }

  private deploy() {
    const errors = this.builds.flatMap((b) => validateBuild(b).filter((p) => p.level === "error").map((p) => `${b.name}: ${p.text}`));
    if (errors.length) {
      this.cb.toast(errors[0]);
      return;
    }
    this.cb.deploy();
    this.hide();
  }

  private exportJson() {
    const json = JSON.stringify({ version: 1, builds: this.builds }, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "s1-garage.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    void navigator.clipboard?.writeText(json).catch(() => undefined);
    this.cb.toast("Garage exported (and copied to the clipboard)");
  }

  private importJson(text: string) {
    try {
      const raw = JSON.parse(text) as unknown;
      const list = Array.isArray(raw) ? raw : ((raw as { builds?: unknown[] }).builds ?? []);
      if (!Array.isArray(list) || list.length === 0) throw new Error("no builds in file");
      for (let i = 0; i < this.builds.length && i < list.length; i++) this.builds[i] = normalizeBuild(list[i], stockBuild, `slot-${i}`);
      this.cb.onChange(this.builds);
      this.renderAll();
      this.cb.toast(`Imported ${Math.min(list.length, this.builds.length)} builds. Deploy to fight with them.`);
    } catch (err) {
      this.cb.toast(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private resetSlot() {
    const stock = stockBuild(this.b.kind);
    this.builds[this.slot] = { ...stock, id: this.b.id };
    this.changed(true);
    this.cb.toast(`${this.b.name} reset to stock`);
  }

  private setKind(kind: BotKind) {
    if (kind === this.b.kind) return;
    const stock = stockBuild(kind);
    const keep = this.b;
    this.builds[this.slot] = { ...stock, id: keep.id, name: keep.name, color: keep.color, accent: keep.accent, levels: { ...keep.levels } };
    this.rebuildPreview();
    this.changed(true, false);
    this.cb.toast(`${keep.name} refitted with the ${WEAPONS[kind].label.toLowerCase()}: stock brain loaded for it. Deploy to apply.`);
  }

  private setLevel(k: PartKey, lvl: number) {
    this.b.levels[k] = Math.max(0, Math.min(MAX_LEVEL, lvl));
    this.rebuildPreview();
    this.changed(true, false);
  }

  private toggleTechnique(m: Maneuver) {
    const t = TECHNIQUE_BY_M[m];
    if (!t || t.required || !techniqueAllowed(m, this.b.kind)) return;
    const i = this.b.techniques.indexOf(m);
    if (i >= 0) this.b.techniques.splice(i, 1);
    else {
      this.b.techniques.push(m);
      if (!this.b.logic.jev.techniques[m]) this.b.logic.jev.techniques[m] = defaultTechniqueLogic(m, this.b.kind);
    }
    this.changed(true);
  }

  /* ------------------------------------------------------------------ rendering ------------------- */

  private renderAll() {
    this.renderRoster();
    this.renderPreviewPanel();
    this.root.querySelectorAll<HTMLButtonElement>(".dz-tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === this.tab));
    this.renderEditor();
    this.renderSpec();
    this.rebuildPreview();
  }

  private renderRoster() {
    this.rosterEl.innerHTML = this.builds
      .map((b, i) => {
        const c = costOf(b);
        const bad = validateBuild(b).some((p) => p.level === "error");
        return `<button class="dz-slot ${i === this.slot ? "on" : ""} ${bad ? "bad" : ""}" data-slot="${i}" style="--c:${hex(b.color)}">
          <span class="dz-slot-icon">${WEAPON_ICON[b.kind]}</span>
          <span class="dz-slot-text"><b>${esc(b.name)}</b><small>${WEAPONS[b.kind].label} · ${c.total}/${BUDGET}</small></span>
        </button>`;
      })
      .join("");
    this.rosterEl.querySelectorAll<HTMLButtonElement>("[data-slot]").forEach((el) => (el.onclick = () => this.select(Number(el.dataset.slot))));
  }

  private renderPreviewPanel() {
    const b = this.b;
    this.previewEl.innerHTML = `
      <div class="dz-stage" id="dz-stage"><canvas id="dz-canvas"></canvas><div class="dz-stage-glow" style="--c:${hex(b.color)}"></div></div>
      <label class="dz-field"><span>Callsign</span><input id="dz-name" maxlength="14" value="${esc(b.name)}" spellcheck="false" /></label>
      <label class="dz-field"><span>Tagline</span><input id="dz-tagline" maxlength="60" value="${esc(b.tagline)}" spellcheck="false" /></label>
      <div class="dz-field"><span>Livery</span><div class="dz-swatches">${SWATCHES.map((c) => `<button class="dz-swatch ${c === b.color ? "on" : ""}" data-color="${c}" style="--c:${hex(c)}"></button>`).join("")}</div></div>
      <div class="dz-preview-foot">
        <button data-a="reset" class="dz-ghost">↺ Reset to stock</button>
      </div>`;
    const name = this.previewEl.querySelector<HTMLInputElement>("#dz-name")!;
    name.oninput = () => {
      this.b.name = name.value.toUpperCase().slice(0, 14);
      this.cb.onChange(this.builds);
      this.renderRoster();
    };
    name.onblur = () => {
      if (!this.b.name.trim()) {
        this.b.name = STOCK_BUILDS[this.b.kind].name;
        name.value = this.b.name;
      }
      this.changed(false, false);
    };
    const tag = this.previewEl.querySelector<HTMLInputElement>("#dz-tagline")!;
    tag.oninput = () => {
      this.b.tagline = tag.value;
      this.cb.onChange(this.builds);
    };
    this.previewEl.querySelectorAll<HTMLButtonElement>("[data-color]").forEach((el) => {
      el.onclick = () => {
        this.b.color = Number(el.dataset.color);
        this.rebuildPreview();
        this.renderPreviewPanel();
        this.changed(false, false);
      };
    });
    this.previewEl.querySelector<HTMLButtonElement>('[data-a="reset"]')!.onclick = () => this.resetSlot();
    this.attachPreviewCanvas();
  }

  private renderEditor() {
    switch (this.tab) {
      case "build":
        this.editorEl.innerHTML = this.htmlBuild();
        break;
      case "baseline":
        this.editorEl.innerHTML = this.htmlBaseline();
        break;
      case "jev":
        this.editorEl.innerHTML = this.htmlJev();
        break;
    }
    this.bindEditor();
  }

  /* ---------------------------------------------------------------- BUILD tab -------------------- */

  private htmlBuild(): string {
    const b = this.b;
    const weapons = BOT_KINDS.map((k) => {
      const w = WEAPONS[k];
      return `<button class="dz-weapon ${k === b.kind ? "on" : ""}" data-kind="${k}" style="--c:${hex(STOCK_BUILDS[k].color)}">
        <span class="dz-weapon-icon">${WEAPON_ICON[k]}</span>
        <span class="dz-weapon-text"><b>${w.label}</b><small>${esc(w.blurb)}</small></span>
        <span class="dz-weapon-mass">${w.mass.toFixed(2)} t</span>
      </button>`;
    }).join("");

    const part = (k: PartKey) => {
      const info = PART_INFO[k];
      const lvl = b.levels[k];
      const segs = Array.from({ length: MAX_LEVEL }, (_, i) => {
        const L = i + 1;
        const delta = LEVEL_COST[L] - LEVEL_COST[lvl];
        return `<button class="dz-seg ${L <= lvl ? "on" : ""}" data-part="${k}" data-level="${L}" title="Level ${L}: ${delta >= 0 ? "+" : ""}${delta} pts"></button>`;
      }).join("");
      return `<div class="dz-part">
        <div class="dz-part-head"><b>${info.label}</b><span class="dz-cost">${LEVEL_COST[lvl]} pts</span></div>
        <div class="dz-part-blurb">${esc(info.blurb)}</div>
        <div class="dz-part-row"><div class="dz-segs" style="--c:${hex(b.color)}">${segs}</div><span class="dz-lvl">${lvl}</span></div>
        <div class="dz-part-value">${esc(fmtLevelValue(b, k))}</div>
      </div>`;
    };

    const chips = TECHNIQUES.map((t) => {
      const on = b.techniques.includes(t.m);
      const allowed = techniqueAllowed(t.m, b.kind);
      const cls = ["dz-chip", on ? "on" : "", allowed ? "" : "locked", t.required ? "required" : ""].join(" ");
      const lock = allowed ? "" : `<i class="dz-chip-lock">needs ${WEAPONS[t.kind!].label.toLowerCase()}</i>`;
      return `<button class="${cls}" data-tech="${t.m}" title="${esc(t.blurb)}"><b>${t.label}</b><span class="dz-chip-cost">${t.cost === 0 ? "free" : t.cost + " pt" + (t.cost > 1 ? "s" : "")}</span>${lock}</button>`;
    }).join("");

    return `
      <section class="dz-sec">
        <header><h2>Weapon system</h2><p>Defines the mechanics, the model and which techniques fit. Switching loads that weapon's stock brain.</p></header>
        <div class="dz-weapons">${weapons}</div>
      </section>
      <section class="dz-sec">
        <header><h2>Chassis</h2><p>Every level costs more than the last (${LEVEL_COST.slice(1).join(" / ")} pts) and armor, frame and weapon power add mass. Mass drags on speed, acceleration and turning.</p></header>
        <div class="dz-parts">${(["armor", "motor", "frame", "steering"] as PartKey[]).map(part).join("")}</div>
      </section>
      <section class="dz-sec">
        <header><h2>Weapon</h2><p>Power buys damage, throw and grip. Cycle buys recharge or spin-up speed.</p></header>
        <div class="dz-parts">${(["power", "cycle"] as PartKey[]).map(part).join("")}</div>
      </section>
      <section class="dz-sec">
        <header><h2>Techniques</h2><p>The maneuver vocabulary both brains may use. Jev only ever chooses among installed techniques; baseline rules that use an uninstalled one are skipped.</p></header>
        <div class="dz-chips">${chips}</div>
      </section>`;
  }

  /* ---------------------------------------------------------------- condition editor ------------- */

  private htmlCondition(c: Condition, path: string, idx: number): string {
    const subj = SUBJECT_BY_KEY[c.s];
    const groups: Record<string, string[]> = {};
    for (const s of SUBJECTS) (groups[s.group] ??= []).push(`<option value="${s.key}" ${s.key === c.s ? "selected" : ""}>${esc(s.label)}</option>`);
    const subjectSel = `<select class="dz-sel subj" data-cpath="${path}" data-cidx="${idx}" data-ck="s">${Object.entries(groups)
      .map(([g, opts]) => `<optgroup label="${g}">${opts.join("")}</optgroup>`)
      .join("")}</select>`;
    let op = "";
    let val = "";
    switch (subj.type) {
      case "bool":
        op = `<span class="dz-op">is</span>`;
        val = `<select class="dz-sel val" data-cpath="${path}" data-cidx="${idx}" data-ck="v"><option value="true" ${c.v === true ? "selected" : ""}>yes</option><option value="false" ${c.v === false ? "selected" : ""}>no</option></select>`;
        break;
      case "kind":
        op = `<select class="dz-sel op" data-cpath="${path}" data-cidx="${idx}" data-ck="op"><option value="is" ${c.op === "is" ? "selected" : ""}>is</option><option value="not" ${c.op === "not" ? "selected" : ""}>is not</option></select>`;
        val = `<select class="dz-sel val" data-cpath="${path}" data-cidx="${idx}" data-ck="v">${BOT_KINDS.map((k) => `<option value="${k}" ${c.v === k ? "selected" : ""}>${WEAPONS[k].label.toLowerCase()}</option>`).join("")}</select>`;
        break;
      default: {
        op = `<select class="dz-sel op" data-cpath="${path}" data-cidx="${idx}" data-ck="op"><option value="<" ${c.op === "<" ? "selected" : ""}>&lt;</option><option value=">" ${c.op === ">" ? "selected" : ""}>&gt;</option></select>`;
        const r = rangeFor(subj.type);
        val = `<span class="dz-range"><input type="range" min="${r.min}" max="${r.max}" step="${r.step}" value="${Number(c.v)}" data-cpath="${path}" data-cidx="${idx}" data-ck="v" /><output>${fmtValue(subj.type, Number(c.v))}</output></span>`;
      }
    }
    return `<div class="dz-cond" data-cond="${path}:${idx}"><i class="dz-dot"></i>${subjectSel}${op}${val}<button class="dz-x" data-cdel="${path}" data-cidx="${idx}" title="Remove condition">×</button></div>`;
  }

  /** Resolve a condition list by path: "rule:<id>", "gate:<maneuver>", "spec:<index>". */
  private condList(path: string): Condition[] | undefined {
    const [kind, key] = path.split(":");
    if (kind === "rule") return this.b.logic.rules.find((r) => r.id === key)?.when;
    if (kind === "gate") return this.b.logic.jev.techniques[key as Maneuver]?.when;
    if (kind === "spec") return this.b.logic.jev.speculative[Number(key)]?.when;
    return undefined;
  }

  private bindConditions(scope: HTMLElement) {
    scope.querySelectorAll<HTMLSelectElement | HTMLInputElement>("[data-cpath][data-ck]").forEach((el) => {
      const list = this.condList(el.dataset.cpath!);
      const idx = Number(el.dataset.cidx);
      const key = el.dataset.ck as "s" | "op" | "v";
      if (!list || !list[idx]) return;
      const c = list[idx];
      if (el instanceof HTMLInputElement && el.type === "range") {
        const out = el.parentElement?.querySelector("output");
        el.oninput = () => {
          c.v = Number(el.value);
          if (out) out.textContent = fmtValue(SUBJECT_BY_KEY[c.s].type, Number(el.value));
          this.cb.onChange(this.builds);
          this.cb.applyLive(this.slot, this.b);
        };
        el.onchange = () => this.changed(false);
        return;
      }
      el.onchange = () => {
        if (key === "s") {
          const subj = SUBJECT_BY_KEY[el.value as SubjectKey];
          c.s = subj.key;
          // Re-seat op and value for the new subject's type.
          if (subj.type === "bool") {
            c.op = "is";
            c.v = true;
          } else if (subj.type === "kind") {
            c.op = c.op === "not" ? "not" : "is";
            c.v = BOT_KINDS.includes(c.v as BotKind) ? c.v : "saw";
          } else {
            c.op = c.op === ">" ? ">" : "<";
            c.v = typeof c.v === "number" ? c.v : rangeFor(subj.type).def;
          }
        } else if (key === "op") c.op = el.value as Condition["op"];
        else c.v = SUBJECT_BY_KEY[c.s].type === "bool" ? el.value === "true" : (el.value as BotKind);
        this.changed(true);
      };
    });
    scope.querySelectorAll<HTMLButtonElement>("[data-cdel]").forEach((el) => {
      el.onclick = () => {
        const list = this.condList(el.dataset.cdel!);
        if (!list) return;
        list.splice(Number(el.dataset.cidx), 1);
        this.changed(true);
      };
    });
    scope.querySelectorAll<HTMLButtonElement>("[data-cadd]").forEach((el) => {
      el.onclick = () => {
        const list = this.condList(el.dataset.cadd!);
        if (!list || list.length >= 8) return;
        list.push({ s: "target.dist", op: "<", v: 3 });
        this.changed(true);
      };
    });
  }

  /* ---------------------------------------------------------------- BASELINE tab ----------------- */

  private htmlBaseline(): string {
    const b = this.b;
    const t = b.logic.targeting;
    const installed = new Set(b.techniques);
    const rules = b.logic.rules
      .map((r, i) => {
        const isDefault = r.when.length === 0;
        const missing = !installed.has(r.maneuver);
        const manOpts = TECHNIQUES.filter((x) => techniqueAllowed(x.m, b.kind))
          .map((x) => `<option value="${x.m}" ${x.m === r.maneuver ? "selected" : ""}>${maneuverLabel(x.m)}${installed.has(x.m) ? "" : " (not installed)"}</option>`)
          .join("");
        const tgtOpts = TARGET_SELS.map((s) => `<option value="${s.key}" ${s.key === r.target ? "selected" : ""}>${s.label}</option>`).join("");
        return `<article class="dz-rule ${missing ? "missing" : ""}" data-rule="${esc(r.id)}" style="--c:${hex(b.color)}">
          <div class="dz-rule-head">
            <span class="dz-rule-n">${i + 1}</span>
            <input class="dz-rule-id" value="${esc(r.id)}" data-rid="${esc(r.id)}" maxlength="24" spellcheck="false" title="Rule name" />
            <span class="dz-rule-live"><i></i><em>FIRING</em></span>
            <span class="dz-rule-tools">
              <button data-rmove="${esc(r.id)}" data-dir="-1" title="Move up" ${i === 0 ? "disabled" : ""}>↑</button>
              <button data-rmove="${esc(r.id)}" data-dir="1" title="Move down" ${i === b.logic.rules.length - 1 ? "disabled" : ""}>↓</button>
              <button data-rdup="${esc(r.id)}" title="Duplicate">⧉</button>
              <button data-rdel="${esc(r.id)}" title="Delete rule" class="danger">✕</button>
            </span>
          </div>
          <div class="dz-rule-when">
            <span class="dz-kw">${isDefault ? "OTHERWISE" : "IF"}</span>
            <div class="dz-conds">${r.when.map((c, ci) => this.htmlCondition(c, `rule:${r.id}`, ci)).join("")}
              <button class="dz-add" data-cadd="rule:${esc(r.id)}">+ condition</button></div>
          </div>
          <div class="dz-rule-then">
            <span class="dz-kw">THEN</span>
            <select class="dz-sel man" data-rk="maneuver" data-rid="${esc(r.id)}">${manOpts}</select>
            <span class="dz-kw small">targeting</span>
            <select class="dz-sel" data-rk="target" data-rid="${esc(r.id)}">${tgtOpts}</select>
            ${missing ? `<span class="dz-warn-tag">technique not installed — skipped</span>` : ""}
          </div>
          <div class="dz-rule-meta">
            <label>danger <input type="range" min="0" max="1" step="0.05" value="${r.danger}" data-rk="danger" data-rid="${esc(r.id)}" /><output>${Math.round(r.danger * 100)}%</output></label>
            <label>if threatened <input type="range" min="0" max="1" step="0.05" value="${r.dangerIfThreat}" data-rk="dangerIfThreat" data-rid="${esc(r.id)}" /><output>${Math.round(r.dangerIfThreat * 100)}%</output></label>
            <label class="grow">note <input class="dz-text" value="${esc(r.note)}" data-rk="note" data-rid="${esc(r.id)}" maxlength="120" placeholder="ticker line; {target} {threat} {held} fill in" spellcheck="false" /></label>
          </div>
        </article>`;
      })
      .join("");

    return `
      <section class="dz-sec">
        <header><h2>Targeting policy</h2><p>Who the bot focuses on when a rule says "per targeting policy". Rules can override it.</p></header>
        <div class="dz-policy">
          <label>prefer
            <select class="dz-sel" data-tk="prefer"><option value="nearest" ${t.prefer === "nearest" ? "selected" : ""}>nearest opponent</option><option value="weakest" ${t.prefer === "weakest" ? "selected" : ""}>weakest opponent</option></select>
          </label>
          <label>finish off the weakest below <input type="range" min="0" max="1" step="0.05" value="${t.finishBelow}" data-tk="finishBelow" /><output>${Math.round(t.finishBelow * 100)}% hp</output></label>
          <label>if at most <input type="range" min="0" max="12" step="0.5" value="${t.finishWithin}" data-tk="finishWithin" /><output>${t.finishWithin} m</output> farther than the nearest</label>
        </div>
      </section>
      <section class="dz-sec">
        <header><h2>Decision tree</h2><p>Rules are tried top to bottom; the first whose conditions all hold fires. The baseline brain runs this every 0.45 s. With a match running, conditions light up green or red for this bot and the firing rule glows.</p></header>
        <div class="dz-rules">${rules}</div>
        <button class="dz-add big" data-radd>+ Add rule</button>
      </section>`;
  }

  private bindBaseline() {
    const el = this.editorEl;
    const L = this.b.logic;
    el.querySelectorAll<HTMLSelectElement | HTMLInputElement>("[data-tk]").forEach((inp) => {
      const k = inp.dataset.tk as keyof typeof L.targeting;
      const out = inp.parentElement?.querySelector("output");
      const apply = () => {
        if (k === "prefer") L.targeting.prefer = inp.value as "nearest" | "weakest";
        else L.targeting[k] = Number(inp.value);
        if (out) out.textContent = k === "finishBelow" ? `${Math.round(Number(inp.value) * 100)}% hp` : `${inp.value} m`;
      };
      inp.oninput = () => {
        apply();
        this.cb.onChange(this.builds);
        this.cb.applyLive(this.slot, this.b);
      };
      inp.onchange = () => {
        apply();
        this.changed(false);
      };
    });
    const rule = (id: string) => L.rules.find((r) => r.id === id);
    el.querySelectorAll<HTMLInputElement>(".dz-rule-id").forEach((inp) => {
      inp.onchange = () => {
        const r = rule(inp.dataset.rid!);
        if (!r) return;
        const next = inp.value.trim().slice(0, 24) || r.id;
        r.id = L.rules.some((x) => x !== r && x.id === next) ? `${next}-${uid()}` : next;
        this.changed(true);
      };
    });
    el.querySelectorAll<HTMLSelectElement | HTMLInputElement>("[data-rk]").forEach((inp) => {
      const r = rule(inp.dataset.rid!);
      if (!r) return;
      const k = inp.dataset.rk as "maneuver" | "target" | "danger" | "dangerIfThreat" | "note";
      const out = inp.parentElement?.querySelector("output");
      const apply = () => {
        if (k === "maneuver") r.maneuver = inp.value as Maneuver;
        else if (k === "target") r.target = inp.value as TargetSel;
        else if (k === "note") r.note = inp.value;
        else {
          r[k] = Number(inp.value);
          if (out) out.textContent = `${Math.round(Number(inp.value) * 100)}%`;
        }
      };
      if (inp instanceof HTMLInputElement && (inp.type === "range" || inp.type === "text")) {
        inp.oninput = () => {
          apply();
          this.cb.onChange(this.builds);
          this.cb.applyLive(this.slot, this.b);
        };
        inp.onchange = () => {
          apply();
          this.changed(false);
        };
      } else {
        inp.onchange = () => {
          apply();
          this.changed(true);
        };
      }
    });
    el.querySelectorAll<HTMLButtonElement>("[data-rmove]").forEach((btn) => {
      btn.onclick = () => {
        const i = L.rules.findIndex((r) => r.id === btn.dataset.rmove);
        const j = i + Number(btn.dataset.dir);
        if (i < 0 || j < 0 || j >= L.rules.length) return;
        [L.rules[i], L.rules[j]] = [L.rules[j], L.rules[i]];
        this.changed(true);
      };
    });
    el.querySelectorAll<HTMLButtonElement>("[data-rdup]").forEach((btn) => {
      btn.onclick = () => {
        const i = L.rules.findIndex((r) => r.id === btn.dataset.rdup);
        if (i < 0) return;
        const copy: Rule = JSON.parse(JSON.stringify(L.rules[i]));
        copy.id = `${copy.id}-${uid()}`.slice(0, 24);
        L.rules.splice(i + 1, 0, copy);
        this.changed(true);
      };
    });
    el.querySelectorAll<HTMLButtonElement>("[data-rdel]").forEach((btn) => {
      btn.onclick = () => {
        const i = L.rules.findIndex((r) => r.id === btn.dataset.rdel);
        if (i < 0 || L.rules.length <= 1) return;
        L.rules.splice(i, 1);
        this.changed(true);
      };
    });
    const add = el.querySelector<HTMLButtonElement>("[data-radd]");
    if (add)
      add.onclick = () => {
        if (L.rules.length >= 24) return;
        const r: Rule = {
          id: `rule-${uid()}`,
          when: [{ s: "target.dist", op: "<", v: 3 }],
          maneuver: this.b.techniques[0] ?? "engage",
          target: "policy",
          danger: 0.2,
          dangerIfThreat: 0.5,
          note: "",
        };
        // Insert above the unconditional default so it stays last.
        const last = L.rules[L.rules.length - 1];
        if (last && last.when.length === 0) L.rules.splice(L.rules.length - 1, 0, r);
        else L.rules.push(r);
        this.changed(true);
      };
  }

  /* ---------------------------------------------------------------- JEV tab ---------------------- */

  private htmlJev(): string {
    const b = this.b;
    const J = b.logic.jev;
    const techs = b.techniques
      .map((m) => {
        const tl = J.techniques[m] ?? { description: "", when: [] };
        return `<article class="dz-tech" data-gate="${m}" style="--c:${hex(b.color)}">
          <div class="dz-tech-head"><b>${maneuverLabel(m)}</b><span class="dz-gate-live"><i></i><em>OFFERED NOW</em></span></div>
          <label class="dz-ta-label">what Jev reads for this option</label>
          <textarea class="dz-ta" data-tdesc="${m}" rows="2" maxlength="700" spellcheck="false">${esc(tl.description)}</textarea>
          <div class="dz-rule-when"><span class="dz-kw">OFFER WHEN</span>
            <div class="dz-conds">${tl.when.map((c, ci) => this.htmlCondition(c, `gate:${m}`, ci)).join("")}${tl.when.length === 0 ? `<span class="dz-always">always</span>` : ""}
              <button class="dz-add" data-cadd="gate:${m}">+ condition</button></div>
          </div>
        </article>`;
      })
      .join("");
    const specs = J.speculative
      .map(
        (q, i) => `<article class="dz-tech" data-spec="${i}" style="--c:${hex(b.color)}">
          <div class="dz-tech-head"><input class="dz-rule-id" value="${esc(q.key)}" data-skey="${i}" maxlength="32" spellcheck="false" title="Answer key (letters, digits, _)" /><span class="dz-gate-live"><i></i><em>ASKED NOW</em></span><button data-sdel="${i}" class="danger dz-x" title="Remove question">✕</button></div>
          <textarea class="dz-ta" data-sprompt="${i}" rows="2" maxlength="700" spellcheck="false">${esc(q.prompt)}</textarea>
          <div class="dz-rule-when"><span class="dz-kw">ASK WHEN</span>
            <div class="dz-conds">${q.when.map((c, ci) => this.htmlCondition(c, `spec:${i}`, ci)).join("")}${q.when.length === 0 ? `<span class="dz-always">always</span>` : ""}
              <button class="dz-add" data-cadd="spec:${i}">+ condition</button></div>
          </div>
        </article>`,
      )
      .join("");
    return `
      <section class="dz-sec">
        <header><h2>Questions Jev is asked</h2><p>Every decision is one request with these questions fanned out. <code>{name}</code> and <code>{weapon}</code> fill in. Jev only sees words, never numbers.</p></header>
        <label class="dz-ta-label">maneuver · Choice over the techniques offered right now</label>
        <textarea class="dz-ta" data-prompt="maneuverPrompt" rows="4" maxlength="700" spellcheck="false">${esc(J.maneuverPrompt)}</textarea>
        <label class="dz-ta-label">target · Choice over the living opponents</label>
        <textarea class="dz-ta" data-prompt="targetPrompt" rows="2" maxlength="700" spellcheck="false">${esc(J.targetPrompt)}</textarea>
        <label class="dz-ta-label">in_danger · Noul, drives evasive driving</label>
        <textarea class="dz-ta" data-prompt="dangerPrompt" rows="2" maxlength="700" spellcheck="false">${esc(J.dangerPrompt)}</textarea>
      </section>
      <section class="dz-sec">
        <header><h2>Techniques as Jev sees them</h2><p>Each installed technique becomes an option with this description, offered only while its gate holds. Install more in BUILD.</p></header>
        <div class="dz-techs">${techs}</div>
      </section>
      <section class="dz-sec">
        <header><h2>Speculative questions</h2><p>Extra yes/no questions that ride along in the same request for free. Answers show in the ticker note.</p></header>
        <div class="dz-techs">${specs}</div>
        <button class="dz-add big" data-sadd>+ Add question</button>
      </section>
      <section class="dz-sec">
        <header><h2>Live: what Jev sees right now</h2><p>This bot's Perception and the question set built from the brain above, refreshed while the match runs.</p></header>
        <pre class="dz-json" id="dz-live-json">— no match running —</pre>
      </section>`;
  }

  private bindJev() {
    const el = this.editorEl;
    const J = this.b.logic.jev;
    el.querySelectorAll<HTMLTextAreaElement>("[data-prompt]").forEach((ta) => {
      ta.oninput = () => {
        J[ta.dataset.prompt as "maneuverPrompt" | "targetPrompt" | "dangerPrompt"] = ta.value;
        this.cb.onChange(this.builds);
        this.cb.applyLive(this.slot, this.b);
      };
    });
    el.querySelectorAll<HTMLTextAreaElement>("[data-tdesc]").forEach((ta) => {
      ta.oninput = () => {
        const m = ta.dataset.tdesc as Maneuver;
        (J.techniques[m] ??= { description: "", when: [] }).description = ta.value;
        this.cb.onChange(this.builds);
        this.cb.applyLive(this.slot, this.b);
      };
      ta.onchange = () => this.changed(false);
    });
    el.querySelectorAll<HTMLInputElement>("[data-skey]").forEach((inp) => {
      inp.onchange = () => {
        const q = J.speculative[Number(inp.dataset.skey)];
        if (!q) return;
        q.key = inp.value.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 32) || q.key;
        this.changed(true);
      };
    });
    el.querySelectorAll<HTMLTextAreaElement>("[data-sprompt]").forEach((ta) => {
      ta.oninput = () => {
        const q = J.speculative[Number(ta.dataset.sprompt)];
        if (q) q.prompt = ta.value;
        this.cb.onChange(this.builds);
        this.cb.applyLive(this.slot, this.b);
      };
    });
    el.querySelectorAll<HTMLButtonElement>("[data-sdel]").forEach((btn) => {
      btn.onclick = () => {
        J.speculative.splice(Number(btn.dataset.sdel), 1);
        this.changed(true);
      };
    });
    const add = el.querySelector<HTMLButtonElement>("[data-sadd]");
    if (add)
      add.onclick = () => {
        if (J.speculative.length >= 6) return;
        const q: Speculative = { key: `question_${J.speculative.length + 1}`, prompt: "Is `me` ...?", when: [] };
        J.speculative.push(q);
        this.changed(true);
      };
  }

  private bindEditor() {
    const el = this.editorEl;
    el.querySelectorAll<HTMLButtonElement>("[data-kind]").forEach((b) => (b.onclick = () => this.setKind(b.dataset.kind as BotKind)));
    el.querySelectorAll<HTMLButtonElement>("[data-part]").forEach((b) => {
      b.onclick = () => {
        const k = b.dataset.part as PartKey;
        const L = Number(b.dataset.level);
        this.setLevel(k, L === this.b.levels[k] ? L - 1 : L);
      };
    });
    el.querySelectorAll<HTMLButtonElement>("[data-tech]").forEach((b) => (b.onclick = () => this.toggleTechnique(b.dataset.tech as Maneuver)));
    this.bindConditions(el);
    if (this.tab === "baseline") this.bindBaseline();
    if (this.tab === "jev") this.bindJev();
  }

  /* ---------------------------------------------------------------- SPEC sheet ------------------- */

  private renderSpec() {
    const b = this.b;
    const d = derive(b);
    const stock = derive(STOCK_BUILDS[b.kind]);
    const cost = costOf(b);
    const problems = validateBuild(b);
    const used = Math.min(1, cost.total / BUDGET);
    const R = 44;
    const C = 2 * Math.PI * R;
    const live = this.cb.botForSlot(this.slot);
    const liveNeedsDeploy = live && (live.def.build.kind !== b.kind || PART_KEYS.some((k) => live.def.build.levels[k] !== b.levels[k]));

    const stat = (label: string, v: number, s: number, max: number, fmt: (x: number) => string, invert = false) => {
      const delta = v - s;
      const good = invert ? delta < 0 : delta > 0;
      const dcls = Math.abs(delta) < 1e-6 ? "" : good ? "up" : "down";
      const dtxt = Math.abs(delta) < 1e-6 ? "stock" : `${delta > 0 ? "+" : "−"}${fmt(Math.abs(delta))}`;
      return `<div class="dz-stat"><span class="dz-stat-l">${label}</span><span class="dz-stat-bar"><i style="width:${Math.min(100, (v / max) * 100)}%;background:${hex(b.color)}"></i></span><b>${fmt(v)}</b><small class="${dcls}">${dtxt}</small></div>`;
    };
    const weaponRows = (() => {
      const T = d.tuning;
      switch (b.kind) {
        case "saw":
          return [
            ["bite", `${T.saw.baseDamage}–${T.saw.baseDamage + T.saw.spinDamage} dmg`],
            ["spin-up", `${T.saw.spinUpSeconds.toFixed(1)} s`],
            ["spin lost per bite", `${Math.round(T.saw.biteCost * 100)}%`],
            ["critical", "rear bites, 1.75×"],
          ];
        case "hammer":
          return [
            ["strike", `${T.hammer.damage} dmg`],
            ["stun", `${T.hammer.stun.toFixed(2)} s`],
            ["recharge", `${T.hammer.cooldown.toFixed(1)} s`],
            ["critical", "stunned / airborne / held targets"],
          ];
        case "grabber":
          return [
            ["crush", `${T.grabber.crushDps} dmg/s`],
            ["grip", `${T.grabber.maxHold.toFixed(1)} s`],
            ["recharge", `${T.grabber.cooldown.toFixed(1)} s`],
            ["critical", "rear grabs crush 1.75×"],
          ];
        case "flipper":
          return [
            ["flip", `${T.flipper.damage} dmg + landing`],
            ["throw", `${T.flipper.launchVz.toFixed(1)} m/s up, ${T.flipper.launchForward.toFixed(1)} m/s out`],
            ["recharge", `${T.flipper.cooldown.toFixed(1)} s`],
            ["critical", "flips toward a wall"],
          ];
      }
    })().map(([k, v]) => `<div class="dz-kv"><span>${k}</span><b>${v}</b></div>`).join("");

    this.specEl.innerHTML = `
      <div class="dz-budget ${cost.over ? "over" : ""}">
        <svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="${R}" class="track"/><circle cx="50" cy="50" r="${R}" class="fill" style="stroke:${cost.over ? "#ff4d5e" : hex(b.color)};stroke-dasharray:${C};stroke-dashoffset:${C * (1 - used)}"/></svg>
        <div class="dz-budget-text"><b>${cost.total}</b><span>/ ${BUDGET} pts</span><small>${cost.over ? `${cost.over} over budget` : `${BUDGET - cost.total} to spend`}</small></div>
      </div>
      <div class="dz-class"><b>${d.weightClass}</b><span>${d.mass.toFixed(2)} t · parts ${cost.parts} · techniques ${cost.techniques}</span></div>
      <div class="dz-stats">
        ${stat("hit points", d.hp, stock.hp, 450, (x) => `${Math.round(x)}`)}
        ${stat("armor", d.armor, stock.armor, 0.45, (x) => `${Math.round(x * 100)}%`)}
        ${stat("top speed", d.maxSpeed, stock.maxSpeed, 9, (x) => `${x.toFixed(1)}`)}
        ${stat("acceleration", d.accel, stock.accel, 20, (x) => `${x.toFixed(1)}`)}
        ${stat("turn rate", d.turnRate, stock.turnRate, 6, (x) => `${x.toFixed(2)}`)}
        ${stat("flip resistance", d.flipResist, stock.flipResist, 0.6, (x) => `${Math.round(x * 100)}%`)}
      </div>
      <div class="dz-kvs">${weaponRows}</div>
      ${problems.length ? `<ul class="dz-problems">${problems.map((p) => `<li class="${p.level}">${esc(p.text)}</li>`).join("")}</ul>` : `<div class="dz-ok">Build is legal and ready to deploy.</div>`}
      ${
        live
          ? `<div class="dz-live-card ${liveNeedsDeploy ? "stale" : ""}">
              <b>${liveNeedsDeploy ? "BODY CHANGED" : "IN THE ARENA"}</b>
              <span>${liveNeedsDeploy ? "parts and weapon apply on DEPLOY; brain edits are live" : `${esc(live.id)} · ${live.alive ? `${Math.ceil(live.hp)} hp` : "out"} · brain edits apply live`}</span>
            </div>`
          : ""
      }
      <div class="dz-sim" id="dz-sim">${this.simHtml}</div>`;
  }

  /* ---------------------------------------------------------------- quick sim -------------------- */

  private async simulate() {
    if (this.simRunning) return;
    this.simRunning = true;
    const N = 12;
    const defs = this.builds.map((b) => defFromBuild(uniqueNamed(cloneBuild(b), this.builds)));
    const colors = Object.fromEntries(defs.map((d) => [d.name, hex(d.color)]));
    const paint = (done: number, wins: Record<string, number>, lengths: number[]) => {
      const rows = defs
        .map((d) => {
          const w = wins[d.name] ?? 0;
          return `<div class="dz-sim-row"><span style="color:${colors[d.name]}">${esc(d.name)}</span><i><b style="width:${done ? (w / done) * 100 : 0}%;background:${colors[d.name]}"></b></i><em>${w}</em></div>`;
        })
        .join("");
      this.simHtml = `<div class="dz-sim-head"><b>QUICK SIM</b><span>${done}/${N} matches · baseline brains${lengths.length ? ` · median ${median(lengths).toFixed(0)} s` : ""}</span></div>${rows}`;
      const el = this.root.querySelector("#dz-sim");
      if (el) el.innerHTML = this.simHtml;
    };
    paint(0, {}, []);
    try {
      await quickSim(defs, {
        matches: N,
        seed: Math.floor(Math.random() * 10000),
        onMatch: (i, r) => {
          paint(i + 1, r.wins, r.lengths);
          return new Promise((res) => setTimeout(res, 0));
        },
      });
    } finally {
      this.simRunning = false;
    }
  }

  /* ---------------------------------------------------------------- live trace ------------------- */

  /** Called every frame by main. Renders the turntable and, a few times a second, the live trace. */
  tick(dt: number) {
    if (!this.open) return;
    this.renderPreview(dt);
    this.liveAcc += dt;
    if (this.liveAcc < 0.12) return;
    this.liveAcc = 0;
    const world = this.cb.world();
    const bot = this.cb.botForSlot(this.slot);
    const liveSpec = this.specEl.querySelector(".dz-live-card span");
    if (liveSpec && bot && !liveSpec.closest(".stale")) liveSpec.textContent = `${bot.id} · ${bot.alive ? `${Math.ceil(bot.hp)} hp` : "out"} · brain edits apply live`;
    const running = world && bot && bot.alive && world.phase === "fighting";
    if (!running) {
      this.editorEl.querySelectorAll(".dz-cond").forEach((el) => el.classList.remove("ok", "no"));
      this.editorEl.querySelectorAll(".dz-rule, .dz-tech").forEach((el) => el.classList.remove("firing", "match", "offered"));
      const pre = this.editorEl.querySelector("#dz-live-json");
      if (pre) pre.textContent = "— no match running —";
      return;
    }
    const s = sense(bot, world.bots, world.fightTime, world.timeLeft);
    const ctx = makeContext(this.b.logic, s.facts);
    this.editorEl.querySelectorAll<HTMLElement>(".dz-cond[data-cond]").forEach((el) => {
      const [path, idx] = el.dataset.cond!.split(/:(?=\d+$)/);
      const list = this.condList(path);
      const c = list?.[Number(idx)];
      if (!c) return;
      const ok = evalCondition(c, ctx);
      el.classList.toggle("ok", ok);
      el.classList.toggle("no", !ok);
    });
    if (this.tab === "baseline") {
      const installed = new Set(this.b.techniques);
      let matched: string | null = null;
      for (const r of this.b.logic.rules) {
        if (!installed.has(r.maneuver)) continue;
        if (r.when.every((c) => evalCondition(c, ctx))) {
          matched = r.id;
          break;
        }
      }
      const brain = this.cb.brainForSlot(this.slot);
      const firing = brain?.mode === "baseline" || bot.intent.source !== "jev" ? bot.intent.ruleId ?? null : null;
      this.editorEl.querySelectorAll<HTMLElement>(".dz-rule[data-rule]").forEach((el) => {
        const id = el.dataset.rule!;
        el.classList.toggle("match", id === matched);
        el.classList.toggle("firing", id === firing);
      });
    }
    if (this.tab === "jev") {
      this.editorEl.querySelectorAll<HTMLElement>(".dz-tech[data-gate]").forEach((el) => {
        const gate = this.b.logic.jev.techniques[el.dataset.gate as Maneuver]?.when ?? [];
        el.classList.toggle("offered", gate.every((c) => evalCondition(c, ctx)));
      });
      this.editorEl.querySelectorAll<HTMLElement>(".dz-tech[data-spec]").forEach((el) => {
        const q = this.b.logic.jev.speculative[Number(el.dataset.spec)];
        el.classList.toggle("offered", !!q && q.when.every((c) => evalCondition(c, ctx)));
      });
      const pre = this.editorEl.querySelector("#dz-live-json");
      if (pre) {
        const qs = buildQuestions(this.b, s);
        const brief = Object.fromEntries(
          Object.entries(qs).map(([k, q]) => [k, q.type === "choice" ? { choice: Object.keys(q.criteria) } : { noul: q.instructions.slice(0, 60) + "…" }]),
        );
        pre.textContent = JSON.stringify({ state: s.perception, questions: brief }, null, 2);
      }
    }
  }

  /* ---------------------------------------------------------------- 3D preview ------------------- */

  private buildPreview() {
    this.pScene.background = null;
    this.pScene.add(new THREE.HemisphereLight(0x8899cc, 0x101014, 1.1));
    const key = new THREE.DirectionalLight(0xfff2e0, 2.4);
    key.position.set(4, 7, 5);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.left = key.shadow.camera.bottom = -3;
    key.shadow.camera.right = key.shadow.camera.top = 3;
    this.pScene.add(key);
    const rim = new THREE.DirectionalLight(0x6ee7ff, 0.45);
    rim.position.set(-5, 3, -4);
    this.pScene.add(rim);
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(2.4, 48),
      new THREE.MeshStandardMaterial({ color: 0x0c0e16, roughness: 0.9, metalness: 0.2, transparent: true, opacity: 0.9 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.pScene.add(floor);
    const ringGeo = new THREE.RingGeometry(2.3, 2.4, 64);
    const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0x2a3040, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.01;
    this.pScene.add(ring);
    this.pCamera.position.set(3.4, 2.6, 3.4);
    this.pCamera.lookAt(0, 0.55, 0);
  }

  private attachPreviewCanvas() {
    const canvas = this.previewEl.querySelector<HTMLCanvasElement>("#dz-canvas");
    if (!canvas) return;
    this.pRenderer?.dispose();
    this.pRenderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.pRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.pRenderer.shadowMap.enabled = true;
    this.pRenderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.pRenderer.toneMappingExposure = 1.15;
    // Metals need something to reflect; a room environment keeps steel looking like steel.
    const pmrem = new THREE.PMREMGenerator(this.pRenderer);
    this.pScene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.pScene.environmentIntensity = 0.55;
    pmrem.dispose();
    this.resizePreview();
  }
  private resizePreview() {
    const stage = this.previewEl.querySelector<HTMLElement>("#dz-stage");
    if (!stage || !this.pRenderer) return;
    const w = Math.max(100, stage.clientWidth);
    const h = Math.max(100, stage.clientHeight);
    this.pRenderer.setSize(w, h, false);
    this.pCamera.aspect = w / h;
    this.pCamera.updateProjectionMatrix();
  }
  private rebuildPreview() {
    if (this.pMesh) this.pScene.remove(this.pMesh.group);
    const def = defFromBuild(cloneBuild(this.b));
    this.pBot = new Bot(def, { x: 0, y: 0 }, 0);
    this.pMesh = new BotMesh(this.pBot);
    this.pMesh.group.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.castShadow = true;
    });
    this.pScene.add(this.pMesh.group);
  }
  private renderPreview(dt: number) {
    if (!this.pRenderer || !this.pMesh || !this.pBot) return;
    this.pTime += dt;
    const b = this.pBot;
    const w = b.weapon;
    b.heading += dt * 0.55;
    const T = b.def.tuning;
    switch (b.kind) {
      case "saw":
        w.spin = 1;
        break;
      case "hammer": {
        const cyc = this.pTime % 3.2;
        if (cyc < 0.6) {
          w.hammerPhase = "windup";
          w.timer = Math.max(0, 0.28 * (1 - cyc / 0.6));
        } else if (cyc < 0.72) {
          w.hammerPhase = "strike";
          w.timer = 0.1;
        } else if (cyc < 1.2) {
          w.hammerPhase = "recover";
          w.timer = Math.max(0, 0.4 * (1 - (cyc - 0.72) / 0.48));
        } else {
          w.hammerPhase = "idle";
          w.cooldown = Math.max(0, Math.min(T.hammer.cooldown, 3.2 - cyc) - 0.4);
        }
        break;
      }
      case "grabber": {
        const cyc = this.pTime % 4;
        b.holding = cyc > 1.6 && cyc < 3.2 ? b : null;
        w.cooldown = cyc >= 3.2 ? 1 : 0;
        break;
      }
      case "flipper": {
        const cyc = this.pTime % 2.6;
        w.flipAnim = cyc < 0.5 ? 1 - cyc / 0.5 : 0;
        break;
      }
    }
    this.pMesh.update(dt, this.pTime, () => undefined);
    this.pRenderer.render(this.pScene, this.pCamera);
  }
}

/* ---------------------------------------------------------------- helpers ---------------------- */

function rangeFor(t: SubjectType): { min: number; max: number; step: number; def: number } {
  switch (t) {
    case "frac":
      return { min: 0, max: 1, step: 0.05, def: 0.5 };
    case "meters":
      return { min: 0, max: 12, step: 0.25, def: 3 };
    case "facing":
      return { min: -1, max: 1, step: 0.05, def: 0.5 };
    case "seconds":
      return { min: 0, max: 180, step: 5, def: 30 };
    case "count":
      return { min: 1, max: 3, step: 1, def: 2 };
    default:
      return { min: 0, max: 1, step: 0.05, def: 0.5 };
  }
}
export function fmtValue(t: SubjectType, v: number): string {
  switch (t) {
    case "frac":
      return `${Math.round(v * 100)}%`;
    case "meters":
      return `${v} m`;
    case "facing":
      return v > 0.75 ? `${v} (square on)` : v > 0.25 ? `${v} (angled)` : v > -0.25 ? `${v} (sideways)` : `${v} (turned away)`;
    case "seconds":
      return `${v} s`;
    default:
      return String(v);
  }
}

/** Arena ids are bot names, so two slots with the same callsign get suffixes. */
export function uniqueNamed(b: BotBuild, all: BotBuild[]): BotBuild {
  const i = all.indexOf(all.find((x) => x.id === b.id) ?? b);
  const dupes = all.filter((x, j) => x.name === b.name && j < i).length;
  if (dupes > 0) b.name = `${b.name} ${["II", "III", "IV"][dupes - 1] ?? dupes + 1}`;
  return b;
}

/**
 * Event log: every bot decision ("thought"), every commentary line (actions, hazards, match beats), kept
 * for the session and browsable at the reader's pace. It lives as a small tab in the lower right; open it
 * (click, or L) for a scrolling list with search (/), category and per-bot filters, and a "this match
 * only" toggle. While you are scrolled up it stops following and counts what arrived below.
 */

export type LogCat = "thought" | "action" | "hazard" | "match";

export interface LogEntry {
  id: number;
  match: number;
  /** Fight time in seconds when it happened. */
  t: number;
  cat: LogCat;
  /** Ticker class (hit, big, hazard, jev, net, base, ...) for colouring. */
  cls: string;
  text: string;
  /** Secondary line: a brain's full note, probabilities, latency. */
  detail?: string;
  /** Bot callsigns this entry is about; the first is the actor. */
  bots: string[];
  /** For thoughts: which brain produced it. */
  source?: string;
}

export interface LogInput {
  cat?: LogCat;
  cls?: string;
  text: string;
  detail?: string;
  bots?: string[];
  source?: string;
}

export interface LogClock {
  match: number;
  t: number;
  /** Callsign -> CSS colour for the bots in the current match. */
  bots: Map<string, string>;
}

const CATS: { k: LogCat; label: string }[] = [
  { k: "thought", label: "Thoughts" },
  { k: "action", label: "Actions" },
  { k: "hazard", label: "Hazards" },
  { k: "match", label: "Match" },
];
const MAX_ENTRIES = 5000;
/** Rendering more rows than this at once gets slow; older matches stay searchable. */
const MAX_ROWS = 1500;
const SRC_LABEL: Record<string, string> = { jev: "JEV", trained: "NET", baseline: "BASE", fallback: "FALLBACK" };

/** Category for a plain ticker class, for callers that only pass a class. */
export function catOf(cls: string): LogCat {
  if (cls === "jev" || cls === "net" || cls === "base") return "thought";
  if (cls === "hazard") return "hazard";
  if (cls === "big" || cls === "season") return "match";
  return "action";
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Append `text` to `parent`, wrapping case-insensitive matches of `q` in <mark>. */
function appendHighlighted(parent: HTMLElement, text: string, q: string) {
  if (!q) {
    parent.append(text);
    return;
  }
  const lower = text.toLowerCase();
  let i = 0;
  for (;;) {
    const j = lower.indexOf(q, i);
    if (j < 0) break;
    if (j > i) parent.append(text.slice(i, j));
    parent.append(el("mark", "", text.slice(j, j + q.length)));
    i = j + q.length;
  }
  if (i < text.length) parent.append(text.slice(i));
}

const fmtTime = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export class EventLog {
  private entries: LogEntry[] = [];
  private nextId = 1;
  private openState = false;
  private query = "";
  private cats = new Set<LogCat>(CATS.map((c) => c.k));
  /** Empty = every bot. */
  private botFilter = new Set<string>();
  private thisMatchOnly = false;
  private follow = true;
  private unseenBelow = 0;
  private unseenWhileClosed = 0;
  private knownBots = new Map<string, string>();
  private botChipsKey = "";

  private root: HTMLElement;
  private tab: HTMLButtonElement;
  private tabBadge: HTMLElement;
  private panel: HTMLElement;
  private list: HTMLElement;
  private search: HTMLInputElement;
  private catChips = new Map<LogCat, HTMLButtonElement>();
  private botChips: HTMLElement;
  private matchChip: HTMLButtonElement;
  private jump: HTMLButtonElement;
  private countEl: HTMLElement;

  constructor(host: HTMLElement, private clock: () => LogClock, private onToggle?: (open: boolean) => void) {
    this.root = el("div", "evlog");
    this.tab = el("button", "evlog-tab");
    this.tab.title = "Event log (L)";
    this.tab.append(el("span", "evlog-tab-icon", "☰"), el("span", "", "Event log"));
    this.tabBadge = el("span", "evlog-badge");
    this.tab.append(this.tabBadge);
    this.tab.onclick = () => this.setOpen(true);

    this.panel = el("div", "evlog-panel");
    const head = el("div", "evlog-head");
    head.append(el("span", "evlog-title", "EVENT LOG"));
    this.countEl = el("span", "evlog-count");
    head.append(this.countEl);
    const copy = el("button", "evlog-btn", "Copy");
    copy.title = "Copy the filtered log as text";
    copy.onclick = () => void this.copy(copy);
    const clear = el("button", "evlog-btn", "Clear");
    clear.onclick = () => this.clear();
    const min = el("button", "evlog-btn evlog-min", "▾");
    min.title = "Minimize (L or Esc)";
    min.onclick = () => this.setOpen(false);
    head.append(copy, clear, min);

    const tools = el("div", "evlog-tools");
    this.search = el("input", "evlog-search");
    this.search.type = "search";
    this.search.placeholder = "Search bots, moves, events…  ( / )";
    this.search.oninput = () => {
      this.query = this.search.value.trim().toLowerCase();
      this.rebuild();
    };
    this.search.onkeydown = (ev) => {
      if (ev.key === "Escape") {
        if (this.search.value) {
          this.search.value = "";
          this.query = "";
          this.rebuild();
        } else this.search.blur();
        ev.stopPropagation();
      }
    };
    const catRow = el("div", "evlog-chips");
    for (const c of CATS) {
      const b = el("button", `evlog-chip cat-${c.k} on`, c.label);
      b.title = "Click to toggle · double-click to show only this";
      b.onclick = () => {
        if (this.cats.has(c.k)) this.cats.delete(c.k);
        else this.cats.add(c.k);
        this.syncChips();
        this.rebuild();
      };
      b.ondblclick = () => {
        this.cats = new Set([c.k]);
        this.syncChips();
        this.rebuild();
      };
      this.catChips.set(c.k, b);
      catRow.append(b);
    }
    this.matchChip = el("button", "evlog-chip evlog-matchonly", "This match");
    this.matchChip.title = "Only entries from the current match";
    this.matchChip.onclick = () => {
      this.thisMatchOnly = !this.thisMatchOnly;
      this.syncChips();
      this.rebuild();
    };
    catRow.append(this.matchChip);
    this.botChips = el("div", "evlog-chips evlog-bots");
    tools.append(this.search, catRow, this.botChips);

    this.list = el("div", "evlog-list");
    this.list.onscroll = () => {
      const atBottom = this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight < 24;
      if (atBottom !== this.follow) {
        this.follow = atBottom;
        if (atBottom) this.unseenBelow = 0;
        this.syncJump();
      }
    };
    this.jump = el("button", "evlog-jump");
    this.jump.onclick = () => this.scrollToEnd();
    const listWrap = el("div", "evlog-listwrap");
    listWrap.append(this.list, this.jump);

    this.panel.append(head, tools, listWrap);
    this.root.append(this.tab, this.panel);
    host.appendChild(this.root);
    this.syncOpen();
    this.syncJump();
  }

  get open() {
    return this.openState;
  }

  setOpen(open: boolean) {
    if (open === this.openState) return;
    this.openState = open;
    if (open) {
      this.unseenWhileClosed = 0;
      this.follow = true;
      this.unseenBelow = 0;
      this.rebuild();
    }
    this.syncOpen();
    this.onToggle?.(open);
  }

  toggle() {
    this.setOpen(!this.openState);
  }

  focusSearch() {
    this.setOpen(true);
    this.search.focus();
    this.search.select();
  }

  add(input: LogInput): LogEntry {
    const clock = this.clock();
    for (const [id, c] of clock.bots) this.knownBots.set(id, c);
    const cls = input.cls ?? "";
    const entry: LogEntry = {
      id: this.nextId++,
      match: clock.match,
      t: clock.t,
      cat: input.cat ?? catOf(cls),
      cls,
      text: input.text,
      detail: input.detail,
      bots: input.bots ?? this.botsIn(input.text, clock),
      source: input.source,
    };
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    if (!this.openState) {
      // Thoughts arrive several times a second; the badge counts the moments, not the chatter.
      if (entry.cat !== "thought") this.unseenWhileClosed++;
      this.syncTab();
      return entry;
    }
    this.syncBotChips();
    if (this.passes(entry)) {
      this.list.append(this.row(entry));
      while (this.list.childElementCount > MAX_ROWS) this.list.firstElementChild?.remove();
      if (this.follow) this.list.scrollTop = this.list.scrollHeight;
      else {
        this.unseenBelow++;
        this.syncJump();
      }
    }
    this.syncCount();
    return entry;
  }

  clear() {
    this.entries = [];
    this.unseenBelow = 0;
    this.unseenWhileClosed = 0;
    this.rebuild();
    this.syncTab();
  }

  /** Callsigns of current-match bots mentioned in free text (season lines, commentary). */
  private botsIn(text: string, clock: LogClock): string[] {
    const out: string[] = [];
    // Longest first so "RIPSAW II" wins over "RIPSAW".
    const ids = [...clock.bots.keys()].sort((a, b) => b.length - a.length);
    let rest = text;
    for (const id of ids) {
      const re = new RegExp(`(^|[^A-Za-z0-9])${escapeRe(id)}(?![A-Za-z0-9])`);
      if (re.test(rest)) {
        out.push(id);
        rest = rest.replace(new RegExp(escapeRe(id), "g"), " ");
      }
    }
    // Order by first mention so the actor (usually named first) leads.
    return out.sort((a, b) => text.indexOf(a) - text.indexOf(b));
  }

  private passes(e: LogEntry): boolean {
    if (!this.cats.has(e.cat)) return false;
    if (this.thisMatchOnly && e.match !== this.clock().match) return false;
    if (this.botFilter.size && !e.bots.some((b) => this.botFilter.has(b))) return false;
    if (this.query) {
      const hay = `${e.text} ${e.detail ?? ""} ${e.bots.join(" ")} ${e.source ? SRC_LABEL[e.source] ?? e.source : ""} m${e.match}`.toLowerCase();
      if (!hay.includes(this.query)) return false;
    }
    return true;
  }

  private row(e: LogEntry): HTMLElement {
    const r = el("div", `evlog-row cat-${e.cat} ${e.cls}`);
    const meta = el("span", "evlog-time", fmtTime(e.t));
    meta.title = `Match ${e.match}`;
    r.append(meta);
    const body = el("div", "evlog-body");
    const main = el("div", "evlog-main");
    if (e.cat === "thought" && e.bots[0]) {
      const who = el("span", "evlog-who");
      who.style.setProperty("--c", this.knownBots.get(e.bots[0]) ?? "#fff");
      appendHighlighted(who, e.bots[0], this.query);
      main.append(who);
      if (e.source) main.append(el("span", `evlog-src src-${e.source}`, SRC_LABEL[e.source] ?? e.source));
    }
    const msg = el("span", "evlog-msg");
    appendHighlighted(msg, e.text, this.query);
    main.append(msg);
    body.append(main);
    if (e.detail) {
      const d = el("div", "evlog-detail");
      appendHighlighted(d, e.detail, this.query);
      body.append(d);
    }
    r.append(body);
    return r;
  }

  private rebuild() {
    if (!this.openState) return;
    this.syncBotChips();
    const rows: HTMLElement[] = [];
    let lastMatch = -1;
    const matching = this.entries.filter((e) => this.passes(e)).slice(-MAX_ROWS);
    for (const e of matching) {
      if (e.match !== lastMatch) {
        rows.push(el("div", "evlog-sep", `Match ${e.match}`));
        lastMatch = e.match;
      }
      rows.push(this.row(e));
    }
    if (!matching.length) rows.push(el("div", "evlog-empty", this.entries.length ? "Nothing matches these filters." : "Nothing yet — the log fills as the bots fight."));
    this.list.replaceChildren(...rows);
    this.unseenBelow = 0;
    this.follow = true;
    this.list.scrollTop = this.list.scrollHeight;
    this.syncJump();
    this.syncCount();
  }

  private syncBotChips() {
    const bots = this.clock().bots;
    const key = [...bots.keys()].join("|");
    if (key === this.botChipsKey) return;
    this.botChipsKey = key;
    for (const b of [...this.botFilter]) if (!bots.has(b)) this.botFilter.delete(b);
    const chips: HTMLElement[] = [];
    for (const [id, color] of bots) {
      const b = el("button", `evlog-chip evlog-bot${this.botFilter.has(id) ? " on" : ""}`, id);
      b.style.setProperty("--c", color);
      b.title = "Show only this bot (click more to add)";
      b.onclick = () => {
        if (this.botFilter.has(id)) this.botFilter.delete(id);
        else this.botFilter.add(id);
        b.classList.toggle("on", this.botFilter.has(id));
        this.rebuild();
      };
      chips.push(b);
    }
    this.botChips.replaceChildren(...chips);
  }

  private syncChips() {
    for (const [k, b] of this.catChips) b.classList.toggle("on", this.cats.has(k));
    this.matchChip.classList.toggle("on", this.thisMatchOnly);
  }

  private syncOpen() {
    this.root.classList.toggle("open", this.openState);
    this.syncTab();
  }

  private syncTab() {
    this.tabBadge.textContent = this.unseenWhileClosed ? String(Math.min(999, this.unseenWhileClosed)) : "";
    this.tabBadge.style.display = this.unseenWhileClosed ? "" : "none";
  }

  private syncJump() {
    this.jump.style.display = this.follow ? "none" : "";
    this.jump.textContent = this.unseenBelow ? `↓ ${this.unseenBelow} new` : "↓ Latest";
  }

  private syncCount() {
    const shown = this.entries.filter((e) => this.passes(e)).length;
    this.countEl.textContent = shown === this.entries.length ? `${this.entries.length}` : `${shown} / ${this.entries.length}`;
  }

  private scrollToEnd() {
    this.follow = true;
    this.unseenBelow = 0;
    this.list.scrollTop = this.list.scrollHeight;
    this.syncJump();
  }

  private async copy(btn: HTMLButtonElement) {
    const lines = this.entries
      .filter((e) => this.passes(e))
      .map((e) => `M${e.match} ${fmtTime(e.t)} [${e.cat}${e.source ? "/" + e.source : ""}] ${e.cat === "thought" && e.bots[0] ? e.bots[0] + ": " : ""}${e.text}${e.detail ? " — " + e.detail : ""}`);
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      btn.textContent = `Copied ${lines.length}`;
    } catch {
      btn.textContent = "Copy failed";
    }
    setTimeout(() => (btn.textContent = "Copy"), 1500);
  }
}

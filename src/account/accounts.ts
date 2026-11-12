/**
 * Accounts: the people at this machine. A profile is one user who is both a bettor (a credit wallet with a
 * ledger) and a bot designer (the Garage roster and Library builds signed with the profile's id, and a career
 * record of how those bots have done).
 *
 * This is the only user store and the only wallet. Betting (src/betting/) stakes and pays through debit() and
 * credit(); designer prize money (./prizes.ts) lands in the same balance. No DOM here; storage is localStorage,
 * and outside a browser the accounts simply live in memory.
 */

export interface LedgerEntry {
  /** Wall-clock ms. */
  t: number;
  /** Signed whole credits: positive is money in. */
  amount: number;
  kind: "grant" | "stake" | "payout" | "refund" | "prize";
  note: string;
  /** What the entry belongs to: a bet id, a fixture id. Free-form. */
  ref?: string;
}

export interface DesignerStats {
  /** Bots entered into seasons. */
  entered: number;
  /** Season matches fought by this designer's bots. */
  matches: number;
  wins: number;
  titles: number;
  /** Prize money earned, all time. */
  prize: number;
}

export interface Profile {
  /** Stable for the life of the profile; renaming does not change it. */
  id: string;
  name: string;
  color: number;
  createdAt: number;
  /** Whole credits. Never negative. */
  balance: number;
  /** Newest last, capped at LEDGER_MAX entries. */
  ledger: LedgerEntry[];
  designer: DesignerStats;
}

export const STARTING_BALANCE = 1000;
export const NAME_MAX = 16;
export const MAX_PROFILES = 8;
const LEDGER_MAX = 200;
const KEY = "s1.accounts.v1";
const COLORS = [0x6ee7ff, 0xffb347, 0xb57bff, 0x7cff6e, 0xff5fa2, 0xe6a92b, 0x2dd4bf, 0xf4f4f4];

const uid = () => Math.random().toString(36).slice(2, 10);
const store = (): Storage | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};
const whole = (n: unknown) => (Number.isFinite(Number(n)) ? Math.max(0, Math.floor(Number(n))) : 0);
const emptyStats = (): DesignerStats => ({ entered: 0, matches: 0, wins: 0, titles: 0, prize: 0 });

function cleanName(raw: unknown, fallback: string): string {
  const s = String(raw ?? "").replace(/\s+/g, " ").trim().slice(0, NAME_MAX);
  return s || fallback;
}

export class Accounts {
  profiles: Profile[] = [];
  private activeId = "";
  private listeners = new Set<() => void>();

  constructor() {
    this.load();
    if (!this.profiles.length) this.profiles.push(this.make("Player 1"));
    if (!this.get(this.activeId)) this.activeId = this.profiles[0].id;
    this.persist();
  }

  /* ---------------------------------------------------------------- profiles -------------------- */

  /** The user at the controls. There is always one. */
  active(): Profile {
    return this.get(this.activeId) ?? this.profiles[0];
  }
  get(id: string | null | undefined): Profile | undefined {
    return id ? this.profiles.find((p) => p.id === id) : undefined;
  }
  /** Display name for a user id, or null when the profile no longer exists. */
  nameOf(id: string | null | undefined): string | null {
    return this.get(id)?.name ?? null;
  }

  /** A new profile with the starting grant. Returns null at the profile limit. The name is made unique. */
  create(name: string): Profile | null {
    if (this.profiles.length >= MAX_PROFILES) return null;
    const p = this.make(this.uniqueName(cleanName(name, `Player ${this.profiles.length + 1}`)));
    this.profiles.push(p);
    this.changed();
    return p;
  }

  switchTo(id: string) {
    if (!this.get(id) || id === this.activeId) return;
    this.activeId = id;
    this.changed();
  }

  rename(id: string, name: string) {
    const p = this.get(id);
    if (!p) return;
    p.name = this.uniqueName(cleanName(name, p.name), id);
    this.changed();
  }

  /** Delete a profile and its wallet. The last profile cannot be removed. */
  remove(id: string): boolean {
    if (this.profiles.length <= 1 || !this.get(id)) return false;
    this.profiles = this.profiles.filter((p) => p.id !== id);
    if (this.activeId === id) this.activeId = this.profiles[0].id;
    this.changed();
    return true;
  }

  /* ---------------------------------------------------------------- wallet ---------------------- */

  /** Pay whole credits into a wallet. Ignored for an unknown profile or a non-positive amount. */
  credit(id: string, amount: number, kind: LedgerEntry["kind"], note: string, ref?: string) {
    const p = this.get(id);
    const n = whole(amount);
    if (!p || n <= 0) return;
    p.balance += n;
    if (kind === "prize") p.designer.prize += n;
    this.post(p, { t: Date.now(), amount: n, kind, note, ref });
  }

  /** Take whole credits out of a wallet. Returns false, changing nothing, when the balance is short. */
  debit(id: string, amount: number, kind: LedgerEntry["kind"], note: string, ref?: string): boolean {
    const p = this.get(id);
    const n = whole(amount);
    if (!p || n <= 0 || p.balance < n) return false;
    p.balance -= n;
    this.post(p, { t: Date.now(), amount: -n, kind, note, ref });
    return true;
  }

  /** Add to a designer's career record (prize totals are kept by credit()). */
  bumpDesigner(id: string, delta: Partial<Omit<DesignerStats, "prize">>) {
    const p = this.get(id);
    if (!p) return;
    p.designer.entered += whole(delta.entered);
    p.designer.matches += whole(delta.matches);
    p.designer.wins += whole(delta.wins);
    p.designer.titles += whole(delta.titles);
    this.changed();
  }

  /** Called after any change to profiles, balances or who is active. Returns the unsubscribe. */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  /* ---------------------------------------------------------------- internals ------------------- */

  private make(name: string): Profile {
    const used = new Set(this.profiles.map((p) => p.color));
    const color = COLORS.find((c) => !used.has(c)) ?? COLORS[this.profiles.length % COLORS.length];
    const now = Date.now();
    return {
      id: `u-${uid()}`,
      name,
      color,
      createdAt: now,
      balance: STARTING_BALANCE,
      ledger: [{ t: now, amount: STARTING_BALANCE, kind: "grant", note: "Starting stake" }],
      designer: emptyStats(),
    };
  }

  private uniqueName(name: string, exceptId = ""): string {
    const taken = (n: string) => this.profiles.some((p) => p.id !== exceptId && p.name.toLowerCase() === n.toLowerCase());
    if (!taken(name)) return name;
    for (let k = 2; ; k++) {
      const n = `${name.slice(0, NAME_MAX - 2)} ${k}`;
      if (!taken(n)) return n;
    }
  }

  private post(p: Profile, e: LedgerEntry) {
    p.ledger.push(e);
    if (p.ledger.length > LEDGER_MAX) p.ledger.splice(0, p.ledger.length - LEDGER_MAX);
    this.changed();
  }

  private changed() {
    this.persist();
    for (const fn of [...this.listeners]) fn();
  }

  private load() {
    try {
      const raw = store()?.getItem(KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as { activeId?: unknown; profiles?: unknown[] };
      const seen = new Set<string>();
      for (const x of Array.isArray(parsed.profiles) ? parsed.profiles : []) {
        const p = x as Partial<Profile> | null;
        if (!p || typeof p !== "object" || typeof p.id !== "string" || !p.id || seen.has(p.id)) continue;
        seen.add(p.id);
        const d = (p.designer ?? {}) as Partial<DesignerStats>;
        this.profiles.push({
          id: p.id,
          name: cleanName(p.name, `Player ${this.profiles.length + 1}`),
          color: Number.isFinite(Number(p.color)) ? Number(p.color) & 0xffffff : COLORS[this.profiles.length % COLORS.length],
          createdAt: Number(p.createdAt) || Date.now(),
          balance: whole(p.balance),
          ledger: (Array.isArray(p.ledger) ? p.ledger : [])
            .filter((e) => e && typeof e === "object" && Number.isFinite(Number(e.amount)))
            .slice(-LEDGER_MAX)
            .map((e) => ({ t: Number(e.t) || 0, amount: Math.trunc(Number(e.amount)), kind: e.kind, note: String(e.note ?? ""), ...(typeof e.ref === "string" ? { ref: e.ref } : {}) })),
          designer: { entered: whole(d.entered), matches: whole(d.matches), wins: whole(d.wins), titles: whole(d.titles), prize: whole(d.prize) },
        });
        if (this.profiles.length >= MAX_PROFILES) break;
      }
      this.activeId = typeof parsed.activeId === "string" ? parsed.activeId : "";
    } catch {
      this.profiles = [];
    }
  }

  private persist() {
    try {
      store()?.setItem(KEY, JSON.stringify({ version: 1, activeId: this.activeId, profiles: this.profiles }));
    } catch {
      /* private mode: accounts live for this session only */
    }
  }
}

/** The one accounts store for the app. */
export const accounts = new Accounts();

/** Display name for a user id ("" when unknown). */
export const profileName = (userId: string | null | undefined): string => accounts.nameOf(userId) ?? "";

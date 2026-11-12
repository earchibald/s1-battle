import { sha256 } from "./sha256";

/**
 * The money: an append-only, hash-chained, double-entry ledger in whole credits.
 *
 * Every entry is a set of legs that sum to zero, so credits are never created or destroyed by a posting; the
 * only source of new credits is the `mint` account, which goes negative by exactly the amount in circulation.
 * No other account may go below zero (except `ext:` mirrors of an outside wallet, see Book), and a posting
 * that would break any rule changes nothing. Each entry carries the hash of the one before it, so an edit to
 * history is detectable from the head hash alone.
 */

export class LedgerError extends Error {}

export interface Leg {
  account: string;
  delta: number;
}

export interface Entry {
  seq: number;
  /** Timestamp supplied by the caller (ms). Not used for ordering: seq is. */
  t: number;
  kind: string;
  /** What this entry is about: a bet id, a market id, a user id. */
  ref: string;
  legs: Leg[];
  prev: string;
  hash: string;
}

export const GENESIS = "0".repeat(64);
export const MINT = "mint";

/** Accounts allowed to hold a negative balance: the mint, and mirrors of money held in an outside wallet. */
export const mayOverdraw = (account: string) => account === MINT || account.startsWith("ext:");

const entryHash = (e: Omit<Entry, "hash">) => sha256(`${e.prev}|${e.seq}|${e.t}|${e.kind}|${e.ref}|${e.legs.map((l) => `${l.account}:${l.delta}`).join(",")}`);

export class Ledger {
  readonly entries: Entry[] = [];
  private bal = new Map<string, number>();

  get head(): string {
    return this.entries.length ? this.entries[this.entries.length - 1].hash : GENESIS;
  }

  balance(account: string): number {
    return this.bal.get(account) ?? 0;
  }

  accounts(): [string, number][] {
    return [...this.bal.entries()];
  }

  /** Validate and append one entry. Throws LedgerError and leaves the ledger untouched when anything is off. */
  post(kind: string, ref: string, legs: Leg[], t: number): Entry {
    const net = new Map<string, number>();
    let sum = 0;
    for (const l of legs) {
      if (typeof l.account !== "string" || !l.account) throw new LedgerError("leg without an account");
      if (!Number.isSafeInteger(l.delta)) throw new LedgerError(`non-integer amount on ${l.account}`);
      net.set(l.account, (net.get(l.account) ?? 0) + l.delta);
      sum += l.delta;
    }
    if (sum !== 0) throw new LedgerError(`legs sum to ${sum}, not zero`);
    const clean: Leg[] = [];
    for (const [account, delta] of net) {
      if (delta === 0) continue;
      const after = this.balance(account) + delta;
      if (!Number.isSafeInteger(after)) throw new LedgerError(`balance overflow on ${account}`);
      if (after < 0 && !mayOverdraw(account)) throw new LedgerError(`${account} would go to ${after}`);
      clean.push({ account, delta });
    }
    if (!clean.length) throw new LedgerError("empty entry");
    const base = { seq: this.entries.length + 1, t, kind, ref, legs: clean, prev: this.head };
    const entry: Entry = { ...base, hash: entryHash(base) };
    for (const l of clean) this.bal.set(l.account, this.balance(l.account) + l.delta);
    this.entries.push(entry);
    return entry;
  }

  /** Recompute the chain and every balance from the entries alone. Returns what is wrong (empty = sound). */
  verify(): string[] {
    const bad: string[] = [];
    const bal = new Map<string, number>();
    let prev = GENESIS;
    this.entries.forEach((e, i) => {
      if (e.seq !== i + 1) bad.push(`entry ${i + 1}: seq is ${e.seq}`);
      if (e.prev !== prev) bad.push(`entry ${e.seq}: broken chain`);
      const { hash, ...rest } = e;
      if (entryHash(rest) !== hash) bad.push(`entry ${e.seq}: hash mismatch`);
      prev = hash;
      let sum = 0;
      for (const l of e.legs) {
        if (!Number.isSafeInteger(l.delta)) bad.push(`entry ${e.seq}: non-integer leg`);
        sum += l.delta;
        const after = (bal.get(l.account) ?? 0) + l.delta;
        bal.set(l.account, after);
        if (after < 0 && !mayOverdraw(l.account)) bad.push(`entry ${e.seq}: ${l.account} went to ${after}`);
      }
      if (sum !== 0) bad.push(`entry ${e.seq}: legs sum to ${sum}`);
    });
    let total = 0;
    for (const [account, v] of bal) {
      total += v;
      if (this.balance(account) !== v) bad.push(`${account}: cached balance ${this.balance(account)} but entries say ${v}`);
    }
    for (const [account, v] of this.bal) if ((bal.get(account) ?? 0) !== v) bad.push(`${account}: cached balance ${v} has no backing entries`);
    if (total !== 0) bad.push(`balances sum to ${total}, not zero`);
    return bad;
  }

  toJSON(): Entry[] {
    return this.entries;
  }

  /** Rebuild from stored entries. Balances are recomputed; call verify() to check the chain. */
  static fromJSON(entries: Entry[]): Ledger {
    const l = new Ledger();
    for (const e of entries) {
      l.entries.push({ ...e, legs: e.legs.map((x) => ({ ...x })) });
      for (const leg of e.legs) l.bal.set(leg.account, l.balance(leg.account) + leg.delta);
    }
    return l;
  }
}

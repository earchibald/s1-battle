import { sha256 } from "./sha256";

/**
 * Where a match's seed comes from, so that nobody can know a result while bets are being taken.
 *
 * A season match is a deterministic function of its lineup and its seed. If the seed were known while the
 * market was open, anyone could run the match and bet on a certainty, and a house that picked the seed could
 * pick the winner. So for a betting season the seed is fixed by two things, neither sufficient alone:
 *
 *   commit   When a fixture's markets open, the house draws a secret and publishes only its hash.
 *   anchor   When betting on the fixture closes, the head hash of the ledger is taken. It depends on every
 *            bet struck so far, so the house could not have known it when it committed.
 *   seed     The first 32 bits of sha256(secret, anchor). The secret is published at the same moment.
 *
 * Bettors cannot compute the seed early because they lack the secret; the house cannot steer it because it
 * committed before the bets that fix the anchor existed. Afterwards anyone can check the commit, recompute
 * the seed, and replay the match.
 */

export interface FairRecord {
  fixtureId: string;
  commit: string;
  /** Null until betting on the fixture closes. */
  anchor: string | null;
  secret: string | null;
  seed: number | null;
}

export const commitOf = (seasonId: string, fixtureId: string, secret: string) => sha256(`s1-commit|${seasonId}|${fixtureId}|${secret}`);
export const seedOf = (secret: string, anchor: string) => parseInt(sha256(`s1-seed|${secret}|${anchor}`).slice(0, 8), 16) >>> 0;

/** True when a revealed record is consistent: the secret matches the commit and the seed follows from both. */
export function verifyFair(seasonId: string, r: FairRecord): boolean {
  if (r.secret === null || r.anchor === null || r.seed === null) return false;
  return commitOf(seasonId, r.fixtureId, r.secret) === r.commit && seedOf(r.secret, r.anchor) === r.seed;
}

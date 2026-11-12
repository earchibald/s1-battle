import type { BotBuild } from "@shared/build";
import { normalizeBuild } from "@shared/build";
import { DEFAULT_ROSTER, stockBuild } from "@shared/bots/index";

/**
 * Each user has their own Garage: four roster slots stored under their profile id. The roster that existed
 * before accounts (the unsuffixed key) is adopted by the first profile, so nobody's work is lost.
 */
const LEGACY_KEY = "s1.garage.v1";
const key = (profileId: string) => `${LEGACY_KEY}:${profileId}`;

export const stockRoster = (): BotBuild[] => DEFAULT_ROSTER.map((k, i) => ({ ...stockBuild(k), id: `slot-${i}` }));

/**
 * Hand the pre-accounts roster to a profile, once ever. The old key is left in place (an older build of the
 * app still reads it); a marker records that it has been claimed so no later profile inherits it again.
 */
export function adoptLegacyRoster(profileId: string) {
  try {
    if (localStorage.getItem(`${LEGACY_KEY}:adopted`)) return;
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy && !localStorage.getItem(key(profileId))) localStorage.setItem(key(profileId), legacy);
    localStorage.setItem(`${LEGACY_KEY}:adopted`, profileId);
  } catch {
    /* private mode: nothing to adopt */
  }
}

/** A user's roster, always four legal-shaped builds. A user who has never opened the Garage gets the stock four. */
export function loadRosterFor(profileId: string): BotBuild[] {
  const stock = stockRoster();
  try {
    const raw = localStorage.getItem(key(profileId));
    if (!raw) return stock;
    const parsed = JSON.parse(raw) as { builds?: unknown[] };
    if (!Array.isArray(parsed.builds)) return stock;
    return stock.map((s, i) => (parsed.builds![i] ? normalizeBuild(parsed.builds![i], stockBuild, `slot-${i}`) : s));
  } catch {
    return stock;
  }
}

export function saveRosterFor(profileId: string, builds: BotBuild[]) {
  try {
    localStorage.setItem(key(profileId), JSON.stringify({ version: 1, builds }));
  } catch {
    /* private mode etc.: the roster just lives for this session */
  }
}

export function removeRosterFor(profileId: string) {
  try {
    localStorage.removeItem(key(profileId));
  } catch {
    /* nothing to clean up */
  }
}

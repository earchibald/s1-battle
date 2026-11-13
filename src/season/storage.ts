import { normalizeBuild } from "@shared/build";
import { stockBuild } from "@shared/bots/index";
import { LEAGUE_SIZE, SEASON_VERSION, type SeasonState } from "./season";

/** The season in progress lives in localStorage beside the Garage roster and the Library. */
const KEY = "s1.season.v1";

export function loadSeason(): SeasonState | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as SeasonState;
    if (!s || s.version !== SEASON_VERSION || !Array.isArray(s.entrants) || s.entrants.length !== LEAGUE_SIZE || !Array.isArray(s.fixtures) || !Array.isArray(s.records)) return null;
    // Builds go through the same normalizer as everything else the Garage loads, so an older or hand-edited
    // save cannot hand the arena a malformed bot. The callsign is the bot's id all season, so it must survive.
    for (const e of s.entrants) {
      const b = normalizeBuild(e.build, stockBuild, e.build?.id ?? "season");
      if (b.name !== e.id) return null;
      e.build = b;
      // The designer is optional (older saves have none); anything malformed is dropped rather than trusted.
      const o = e.owner as { id?: unknown; name?: unknown } | undefined;
      if (o && typeof o.id === "string" && o.id && typeof o.name === "string") e.owner = { id: o.id, name: o.name.slice(0, 16) };
      else delete e.owner;
    }
    const ids = new Set(s.entrants.map((e) => e.id));
    if (ids.size !== LEAGUE_SIZE || s.fixtures.some((f) => !Array.isArray(f.bots) || f.bots.length !== 4 || f.bots.some((id) => !ids.has(id)))) return null;
    return s;
  } catch {
    return null;
  }
}

export function saveSeason(s: SeasonState | null) {
  try {
    if (s) localStorage.setItem(KEY, JSON.stringify(s));
    else localStorage.removeItem(KEY);
  } catch {
    /* private mode: the season lives for this session only */
  }
}

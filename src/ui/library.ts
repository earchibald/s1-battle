import type { BotBuild } from "@shared/build";
import { cloneBuild, normalizeBuild } from "@shared/build";
import { stockBuild } from "@shared/bots/index";
import { accounts } from "../account/accounts";

/**
 * The Garage's saved work: named builds and whole rosters, persisted in localStorage next to the live
 * roster. Everything is normalized on the way in, so a hand-edited or older file cannot break the UI.
 *
 * Every saved build is signed with the user who designed it (a profile id from src/account/accounts.ts).
 * Builds saved before accounts existed are adopted by the first profile. One library holds everyone's
 * builds, so a season can field bots from several designers.
 */

export interface SavedBuild {
  id: string;
  savedAt: number;
  build: BotBuild;
  /** The designer's profile id. A build whose designer has been deleted keeps the stale id and belongs to nobody. */
  ownerId: string;
}
export interface SavedRoster {
  id: string;
  name: string;
  savedAt: number;
  builds: BotBuild[];
}

const KEY = "s1.library.v1";
const uid = () => Math.random().toString(36).slice(2, 9);

export class Library {
  builds: SavedBuild[] = [];
  rosters: SavedRoster[] = [];

  constructor() {
    this.load();
  }

  private load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as { builds?: unknown[]; rosters?: unknown[] };
      // Builds from before accounts are signed over to the first profile, and that is written back at once
      // (below) so the adoption happens exactly once, whoever is first in the list later.
      const unsigned = (Array.isArray(parsed.builds) ? parsed.builds : []).some((x) => x && typeof x === "object" && typeof (x as Partial<SavedBuild>).ownerId !== "string");
      this.builds = (Array.isArray(parsed.builds) ? parsed.builds : [])
        .map((x) => x as Partial<SavedBuild>)
        .filter((x) => x && typeof x === "object" && x.build)
        .map((x) => ({
          id: typeof x.id === "string" ? x.id : `lib-${uid()}`,
          savedAt: Number(x.savedAt) || Date.now(),
          build: normalizeBuild(x.build, stockBuild, "library"),
          ownerId: typeof x.ownerId === "string" && x.ownerId ? x.ownerId : accounts.profiles[0].id,
        }));
      this.rosters = (Array.isArray(parsed.rosters) ? parsed.rosters : [])
        .map((x) => x as Partial<SavedRoster>)
        .filter((x) => x && typeof x === "object" && Array.isArray(x.builds))
        .map((x) => ({
          id: typeof x.id === "string" ? x.id : `ros-${uid()}`,
          name: typeof x.name === "string" && x.name.trim() ? x.name.slice(0, 40) : "Roster",
          savedAt: Number(x.savedAt) || Date.now(),
          builds: (x.builds as unknown[]).slice(0, 4).map((b, i) => normalizeBuild(b, stockBuild, `slot-${i}`)),
        }));
      if (unsigned) this.persist();
    } catch {
      this.builds = [];
      this.rosters = [];
    }
  }

  private persist() {
    try {
      localStorage.setItem(KEY, JSON.stringify({ version: 1, builds: this.builds, rosters: this.rosters }));
    } catch {
      /* private mode: the library lives for this session only */
    }
  }

  /** The builds a user designed, newest first. */
  buildsOf(ownerId: string): SavedBuild[] {
    return this.builds.filter((s) => s.ownerId === ownerId);
  }

  /** Another designer already holding this callsign, if any (callsigns are unique within a season). */
  rivalHolding(name: string, ownerId: string): SavedBuild | undefined {
    return this.builds.find((s) => s.ownerId !== ownerId && s.build.name.toLowerCase() === name.toLowerCase());
  }

  /**
   * Save a build under its callsign, signed by its designer (default: the active user). The designer's own
   * saved build with the same name (case-insensitive) is replaced; other designers' builds are never touched.
   */
  saveBuild(build: BotBuild, ownerId: string = accounts.active().id): { saved: SavedBuild; replaced: boolean } {
    const copy = cloneBuild(build);
    const i = this.builds.findIndex((s) => s.ownerId === ownerId && s.build.name.toLowerCase() === copy.name.toLowerCase());
    const id = i >= 0 ? this.builds[i].id : `lib-${uid()}`;
    const saved: SavedBuild = { id, savedAt: Date.now(), build: { ...copy, id }, ownerId };
    if (i >= 0) this.builds[i] = saved;
    else this.builds.unshift(saved);
    this.persist();
    return { saved, replaced: i >= 0 };
  }

  /** Add builds from an export without replacing anything: name clashes get a numeric suffix. The importer becomes their designer. */
  addBuilds(list: unknown[], ownerId: string = accounts.active().id): number {
    let n = 0;
    for (const raw of list) {
      const b = normalizeBuild(raw, stockBuild, "library");
      let name = b.name;
      let k = 2;
      while (this.builds.some((s) => s.build.name.toLowerCase() === name.toLowerCase())) name = `${b.name.slice(0, 12)} ${k++}`;
      b.name = name;
      const id = `lib-${uid()}`;
      this.builds.unshift({ id, savedAt: Date.now(), build: { ...b, id }, ownerId });
      n++;
    }
    this.persist();
    return n;
  }

  removeBuild(id: string) {
    this.builds = this.builds.filter((s) => s.id !== id);
    this.persist();
  }

  saveRoster(name: string, builds: BotBuild[]): { saved: SavedRoster; replaced: boolean } {
    const clean = name.trim().slice(0, 40) || `Roster ${this.rosters.length + 1}`;
    const i = this.rosters.findIndex((r) => r.name.toLowerCase() === clean.toLowerCase());
    const saved: SavedRoster = { id: i >= 0 ? this.rosters[i].id : `ros-${uid()}`, name: clean, savedAt: Date.now(), builds: builds.map(cloneBuild) };
    if (i >= 0) this.rosters[i] = saved;
    else this.rosters.unshift(saved);
    this.persist();
    return { saved, replaced: i >= 0 };
  }

  removeRoster(id: string) {
    this.rosters = this.rosters.filter((r) => r.id !== id);
    this.persist();
  }

  exportJson(): string {
    return JSON.stringify({ version: 1, library: true, builds: this.builds, rosters: this.rosters }, null, 2);
  }
}

import { cloneBuild } from "@shared/build";
import { defFromBuild } from "@shared/logic";
import type { BotDef } from "@shared/bots/common";
import { Driver, baselinePolicy } from "../sim/driver";
import type { SimEvent } from "../sim/events";
import type { World } from "../sim/world";
import { applyResult, entrant, nextFixture, type Fixture, type Kill, type MatchOutcome, type SeasonState } from "./season";

/**
 * The bridge between the simulation and the pure season state: turns a finished World into a MatchOutcome,
 * and runs fixtures headlessly (baseline brains) for "simulate" in the UI and for scripts/season-sim.ts.
 * DOM-free.
 */

/** Collects who put whom out, in order, from the sim's event stream. */
export class KillLog {
  kills: Kill[] = [];
  reset() {
    this.kills = [];
  }
  onEvent(e: SimEvent, world: World) {
    if (e.type === "destroyed" || e.type === "pitted") this.kills.push({ killer: e.by, victim: e.bot, how: e.type, t: Math.round(world.fightTime * 100) / 100 });
  }
}

export function outcomeFromWorld(world: World, kills: Kill[]): MatchOutcome {
  const r = world.result;
  return {
    duration: Math.round(world.fightTime * 10) / 10,
    reason: r?.reason ?? "draw",
    winner: r?.winner ?? null,
    bots: world.bots.map((b) => ({ id: b.id, alive: b.alive, hp: b.hp, hpFrac: b.hpFrac, damage: b.stats.damageDealt })),
    kills: kills.slice(),
  };
}

/** The fixture's bots as arena definitions, in start-corner order. Each match gets fresh copies of the builds. */
export function fixtureDefs(s: SeasonState, fx: Fixture): BotDef[] {
  return fx.bots.map((id) => defFromBuild(cloneBuild(entrant(s, id)!.build)));
}

/** Run one fixture headlessly on baseline brains. Deterministic for the fixture's seed. */
export function simulateOutcome(s: SeasonState, fx: Fixture): MatchOutcome {
  const d = Driver.start(fixtureDefs(s, fx), fx.seed, () => baselinePolicy, { nudges: true });
  const log = new KillLog();
  while (!d.over) for (const e of d.step()) log.onEvent(e, d.world);
  return outcomeFromWorld(d.world, log.kills);
}

/** Simulate the next unplayed fixture and record it. Returns the same state when the season is over. */
export function simulateNext(s: SeasonState): SeasonState {
  const fx = nextFixture(s);
  return fx ? applyResult(s, fx.id, simulateOutcome(s, fx), true) : s;
}

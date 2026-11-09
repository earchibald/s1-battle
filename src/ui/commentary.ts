import type { SimEvent } from "../sim/events";
import type { World } from "../sim/world";

/** Turns sim events into ticker lines. Plain templates with a little variety; no model needed here. */

const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

export function commentate(e: SimEvent, world: World): { text: string; cls: string } | null {
  switch (e.type) {
    case "match_start":
      return { text: pick(["FIGHT! Four bots, one arena.", "The bell rings. Let's see who thinks fastest.", "Match on. Weapons live."]), cls: "big" };
    case "hit": {
      if (e.amount < 6) return null;
      const n = Math.round(e.amount);
      switch (e.weapon) {
        case "saw":
          return { text: pick([`${e.attacker} buries the blade in ${e.victim} for ${n}!`, `Sparks fly: ${e.attacker} carves ${e.victim} (${n}).`, `${e.victim} eats the saw. ${n} damage.`]), cls: "hit" };
        case "hammer":
          return { text: pick([`BANG! ${e.attacker} brings the hammer down on ${e.victim} for ${n}!`, `${e.attacker} piledrives ${e.victim}. ${n} damage and a daze.`]), cls: "hit" };
        case "flip":
          return { text: pick([`${e.attacker} gets under ${e.victim} and SENDS IT!`, `Airtime! ${e.attacker} launches ${e.victim}.`]), cls: "hit" };
        case "landing":
          return { text: pick([`${e.victim} comes down hard. ${n} damage on impact.`, `Gravity collects ${n} from ${e.victim}.`]), cls: "" };
        case "wall":
          return e.amount > 10 ? { text: `${e.victim} slams the wall for ${n}!`, cls: "" } : null;
        case "saws":
          return e.power > 0 ? { text: `The floor saws are chewing on ${e.victim}!`, cls: "hazard" } : null;
        case "crush":
          return null;
        case "spinner":
          return { text: pick([`${e.attacker}'s bar catches ${e.victim} and sends it flying! ${n}.`, `WHANG! ${e.victim} finds out what the bar is for. ${n} damage.`]), cls: "hit" };
        case "torch":
          if (e.power < 0.3) return null;
          return { text: pick([`${e.attacker} lights up ${e.victim}! ${n} and it's still burning.`, `${e.victim} is on fire courtesy of ${e.attacker}. ${n} damage.`]), cls: "hit" };
        case "ram":
          return { text: pick([`${e.attacker} slams into ${e.victim} for ${n}!`, `${e.victim} gets bulldozed by ${e.attacker}. ${n} damage.`]), cls: "hit" };
      }
      return null;
    }
    case "boost":
      return Math.random() < 0.35 ? { text: `${e.bot} hits the boost!`, cls: "" } : null;
    case "strike":
      return e.landed ? null : { text: pick([`${e.bot} swings and hits nothing but floor.`, `${e.bot} whiffs the hammer — it's exposed!`]), cls: "" };
    case "grab":
      return { text: pick([`${e.bot} has ${e.victim} in the jaws!`, `Got him! ${e.bot} clamps onto ${e.victim}.`]), cls: "hit" };
    case "release":
      if (e.reason === "timeout") return { text: `${e.bot}'s grip gives out — ${e.victim} is loose.`, cls: "" };
      if (e.reason === "chosen") return { text: `${e.bot} lets ${e.victim} go.`, cls: "" };
      return null;
    case "flip":
      return e.victim ? null : { text: `${e.bot} fires the flipper at thin air.`, cls: "" };
    case "destroyed": {
      const alive = world.alive.length;
      return { text: pick([`${e.bot} IS DESTROYED${e.by ? ` by ${e.by}` : ""}! ${alive} remain.`, `That's it for ${e.bot}${e.by ? ` — ${e.by} finishes the job` : ""}. ${alive} left.`]), cls: "big" };
    } 
    case "pitted":
      return { text: pick([`${e.bot} GOES INTO THE PIT${e.by ? `, courtesy of ${e.by}` : ""}!`, `Down the hole! ${e.bot} is gone${e.by ? ` — ${e.by} will take the credit` : ""}.`]), cls: "big" };
    case "pit_warning":
      return { text: "Warning lights on the pit...", cls: "hazard" };
    case "pit_open":
      return { text: "THE PIT IS OPEN.", cls: "hazard" };
    case "saws_rising":
      return { text: "Kill saws rising!", cls: "hazard" };
    case "match_end":
      if (!e.winner) return { text: "Nobody survives. It's a draw.", cls: "big" };
      return { text: e.reason === "judges" ? `Time! The judges give it to ${e.winner}.` : `${e.winner} WINS!`, cls: "big" };
    case "decision":
      // Thoughts go to the event log (main.ts -> hud.thought), never the ticker: there are several a second.
      return null;
    default:
      return null;
  }
}

import "dotenv/config";
import { TypeSafeClient, choice, noul } from "@typesafe-ai/sdk";

const client = new TypeSafeClient();
const state = {
  me: { bot: "RIPSAW (spinning saw blade)", health: "healthy", weapon: "saw at full speed", position: "center of arena" },
  opponents: [
    { name: "PILEDRIVER", weapon: "hammer", health: "damaged", distance: "close", bearing: "ahead", facing_me: true, weapon_state: "hammer raised, about to strike" },
    { name: "CLAMP", weapon: "grabbing arm", health: "healthy", distance: "far", bearing: "behind-left", facing_me: false, weapon_state: "jaws open" },
  ],
  hazards: { pit: "closed", nearest_kill_saw: "far, to the right" },
};
for (let i = 0; i < 3; i++) {
  const t0 = performance.now();
  const r = await client.systemOne({
    state,
    questions: {
      target: choice("Which opponent should `me` attack next?", { PILEDRIVER: "the hammer bot", CLAMP: "the grabber bot" }),
      maneuver: choice("What should `me` do right now?", {
        charge: "drive straight into the target with the saw",
        circle: "circle the target to attack from the side or rear",
        retreat: "back away to avoid an incoming attack",
        flank: "swing wide to approach the target from behind",
      }),
      in_danger: noul("Is `me` about to be hit by an opponent's weapon?"),
    },
  });
  console.log(`latency ${Math.round(performance.now() - t0)}ms model=${r.model}`, JSON.stringify(r.answers), r.usage);
}

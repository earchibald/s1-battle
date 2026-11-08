/** Stock Jev prompts shared by every weapon system. {name} and {weapon} are filled per build. */
export const STOCK_PROMPTS = {
  maneuverPrompt:
    "`me` is {name}, a combat robot armed with a {weapon}. Given `me`, `opponents` and `arena`, which single maneuver should `me` perform for the next second? The goal is to destroy the opponents or put them in the pit; a bot that stays passive loses on the judges' decision. Taking a hit is acceptable when it lets my own weapon land. Retreat only when an opponent's ready weapon is pointed at me from close range or a live hazard is right next to me.",
  targetPrompt:
    "Which opponent should `me` ({name}, armed with a {weapon}) focus on attacking next? Prefer opponents that are vulnerable right now and avoid ones about to hit me.",
  dangerPrompt:
    "Is `me` about to be hit by an opponent's weapon or an arena hazard within the next second or two? Consider opponents that are close, facing me, with a ready weapon, and hazards that are open or rising next to me.",
};

import { Bot } from "./bot";
import type { HitWeapon, SimEvent } from "./events";
import { dist, fromAngle, norm, scale, sub } from "./math";

/**
 * Weapon mechanics. Each kind has a distinct rhythm:
 *  - saw: continuous contact damage, costs spin per bite, throws both bots
 *  - hammer: windup -> strike -> recover -> long cooldown; huge single hit + stun
 *  - grabber: grab -> hold (crush, drag) -> release/timeout -> cooldown
 *  - flipper: instant launch, long pneumatic recharge; landing and walls do the damage
 */

export interface WeaponContext {
  bots: Bot[];
  time: number;
  emit(e: SimEvent): void;
  /** Uniform 0..1, from the world's seeded RNG so headless runs stay reproducible. */
  rng(): number;
}

/** Critical hits multiply damage and are earned by position and timing, with a small random chance. */
export const CRIT_MULT = 1.75;
const CRIT_CHANCE = { saw: 0.06, hammer: 0.1, flipper: 0.08, spinner: 0.06, ram: 0.08 };

/** True when `attacker` is behind `victim` (inside the rear 100° or so). */
export function isBehind(attacker: Bot, victim: Bot): boolean {
  const toAttacker = norm(sub(attacker.p, victim.p));
  return toAttacker.x * Math.cos(victim.heading) + toAttacker.y * Math.sin(victim.heading) < -0.45;
}

/** Weapon numbers come from each bot's build (see shared/build.ts `derive`); `bot.def.tuning` holds them. */
/** Arena half-size minus a bot; imported lazily to avoid a cycle with arena.ts. */
const WALL_LIMIT = 10 - 0.9;

/** Weapons that bypass part of the armor (flame gets into the gaps). */
const ARMOR_PIERCE: Partial<Record<HitWeapon, number>> = { torch: 0.5 };
/** Damage the wedge skirt soaks: landings, wall hits and slams. */
const IMPACT_WEAPONS: HitWeapon[] = ["landing", "wall", "ram", "flip"];

export function applyDamage(ctx: WeaponContext, victim: Bot, attacker: Bot | null, raw: number, weapon: HitWeapon, at = victim.p, power = 1, crit = false): number {
  if (!victim.alive) return 0;
  const armor = victim.def.stats.armor * (1 - (ARMOR_PIERCE[weapon] ?? 0));
  const impact = IMPACT_WEAPONS.includes(weapon) ? victim.def.stats.impactResist : 0;
  const amount = raw * (crit ? CRIT_MULT : 1) * (1 - armor) * (1 - impact);
  victim.hp -= amount;
  victim.stats.damageTaken += amount;
  victim.lastDamagedAt = ctx.time;
  if (attacker && attacker !== victim) {
    attacker.stats.damageDealt += amount;
    attacker.stats.hits++;
    victim.lastHitBy = attacker.id;
    victim.lastHitAt = ctx.time;
  }
  ctx.emit({ type: "hit", attacker: attacker?.id ?? "arena", victim: victim.id, amount, weapon, at: { ...at }, power, crit });
  if (victim.hp <= 0) destroy(ctx, victim, attacker?.id ?? victim.lastHitBy);
  return amount;
}

export function destroy(ctx: WeaponContext, bot: Bot, by: string | null) {
  if (!bot.alive) return;
  bot.alive = false;
  bot.hp = 0;
  bot.eliminated = "destroyed";
  bot.throttle = 0;
  bot.steer = 0;
  if (bot.holding) releaseHold(ctx, bot, "destroyed");
  if (bot.heldBy) releaseHold(ctx, bot.heldBy, "destroyed");
  ctx.emit({ type: "destroyed", bot: bot.id, by, at: { ...bot.p } });
}

export function releaseHold(ctx: WeaponContext, holder: Bot, reason: "timeout" | "chosen" | "stunned" | "destroyed") {
  const victim = holder.holding;
  if (!victim) return;
  holder.holding = null;
  victim.heldBy = null;
  holder.weapon.holdTime = 0;
  holder.weapon.cooldown = holder.def.tuning.grabber.cooldown;
  holder.weapon.cooldownMax = holder.def.tuning.grabber.cooldown;
  // A little shove so the two separate cleanly.
  const f = holder.forward;
  victim.shove(f.x * 2.5, f.y * 2.5);
  ctx.emit({ type: "release", bot: holder.id, victim: victim.id, reason });
}

function victimsInHitbox(bot: Bot, ctx: WeaponContext, allowAirborne = false): Bot[] {
  const { at, r } = bot.weaponHitbox();
  const out: Bot[] = [];
  for (const o of ctx.bots) {
    if (o === bot || !o.alive) continue;
    if (o.airborne && !allowAirborne) continue;
    if (dist(at, o.p) < r + o.radius * 0.85) out.push(o);
  }
  return out;
}

export function updateWeapon(bot: Bot, ctx: WeaponContext, dt: number) {
  const w = bot.weapon;
  for (const [k, t] of w.hitCooldowns) {
    if (t - dt <= 0) w.hitCooldowns.delete(k);
    else w.hitCooldowns.set(k, t - dt);
  }
  if (w.cooldown > 0) w.cooldown = Math.max(0, w.cooldown - dt);

  switch (bot.kind) {
    case "saw":
      return updateSaw(bot, ctx, dt);
    case "hammer":
      return updateHammer(bot, ctx, dt);
    case "grabber":
      return updateGrabber(bot, ctx, dt);
    case "flipper":
      return updateFlipper(bot, ctx, dt);
    case "spinner":
      return updateSpinner(bot, ctx, dt);
    case "torch":
      return updateTorch(bot, ctx, dt);
    case "ram":
      return updateRam(bot, ctx, dt);
  }
}

/** Fire ticks for a bot that is burning. Called by the world every step, for every bot. */
export function updateBurn(bot: Bot, ctx: WeaponContext, dt: number) {
  if (bot.burn <= 0 || !bot.alive) {
    bot.burn = 0;
    return;
  }
  bot.burn = Math.max(0, bot.burn - dt);
  bot.weapon.burnTick += dt;
  if (bot.weapon.burnTick >= 0.5) {
    bot.weapon.burnTick -= 0.5;
    const by = bot.burnBy ? ctx.bots.find((b) => b.id === bot.burnBy) ?? null : null;
    const dps = by && by.kind === "torch" ? by.def.tuning.torch.burnDps : 2;
    // power 0.2 marks a burn tick (vs a direct flame hit) for effects and sound.
    applyDamage(ctx, bot, by, dps * 0.5, "torch", bot.p, 0.2, false);
  }
}

function updateSaw(bot: Bot, ctx: WeaponContext, dt: number) {
  const w = bot.weapon;
  const T = bot.def.tuning.saw;
  if (bot.alive && !bot.heldBy) w.spin = Math.min(1, w.spin + dt / T.spinUpSeconds);
  else w.spin = Math.max(0, w.spin - dt * 0.5);
  if (!bot.alive || bot.airborne || w.spin < 0.2) return;

  for (const victim of victimsInHitbox(bot, ctx)) {
    if (w.hitCooldowns.has(victim.id)) continue;
    w.hitCooldowns.set(victim.id, T.hitCooldown);
    const dir = norm(sub(victim.p, bot.p));
    const power = w.spin;
    // Rear bites are critical: the blade reaches unarmored motors. That is what flanking is for.
    const crit = isBehind(bot, victim) || (power > 0.9 && ctx.rng() < CRIT_CHANCE.saw);
    applyDamage(ctx, victim, bot, T.baseDamage + T.spinDamage * power, "saw", bot.weaponHitbox().at, power, crit);
    // Blade bites: the victim gets thrown, the saw bot recoils, and the blade loses speed.
    const kick = ((3.5 + 6 * power) * (crit ? 1.4 : 1)) / victim.mass;
    victim.shove(dir.x * kick, dir.y * kick);
    bot.shove((-dir.x * (2 + 3 * power)) / bot.mass, (-dir.y * (2 + 3 * power)) / bot.mass);
    if (power > T.hopSpin && !victim.airborne && !victim.heldBy && victim.alive) {
      victim.airborne = true;
      victim.vz = 2.6;
      victim.launchedBy = bot.id;
    }
    w.spin = Math.max(0.15, w.spin - T.biteCost);
  }
}

function updateHammer(bot: Bot, ctx: WeaponContext, dt: number) {
  const w = bot.weapon;
  const T = bot.def.tuning.hammer;
  switch (w.hammerPhase) {
    case "idle":
      if (bot.trigger && w.cooldown <= 0 && bot.controllable) {
        w.hammerPhase = "windup";
        w.timer = T.windup;
      }
      break;
    case "windup":
      w.timer -= dt;
      if (w.timer <= 0) {
        w.hammerPhase = "strike";
        w.timer = T.strike;
        const victims = victimsInHitbox(bot, ctx, true);
        const at = bot.weaponHitbox().at;
        for (const victim of victims) {
          const dir = norm(sub(victim.p, bot.p));
          // A hammer on something that cannot move is a critical: stunned, airborne, or held in jaws.
          const crit = victim.stun > 0 || victim.airborne || victim.heldBy !== null || ctx.rng() < CRIT_CHANCE.hammer;
          applyDamage(ctx, victim, bot, T.damage, "hammer", at, 1, crit);
          victim.stunFor(T.stun * (crit ? 1.5 : 1));
          victim.shove((dir.x * 3) / victim.mass, (dir.y * 3) / victim.mass);
          // Slam anything airborne straight back down.
          if (victim.airborne) {
            victim.vz = -12;
          }
          if (victim.holding) releaseHold(ctx, victim, "stunned");
        }
        ctx.emit({ type: "strike", bot: bot.id, landed: victims.length > 0, at });
      }
      break;
    case "strike":
      w.timer -= dt;
      if (w.timer <= 0) {
        w.hammerPhase = "recover";
        w.timer = T.recover;
      }
      break;
    case "recover":
      w.timer -= dt;
      if (w.timer <= 0) {
        w.hammerPhase = "idle";
        w.cooldown = T.cooldown;
        w.cooldownMax = T.cooldown;
      }
      break;
  }
}

function updateGrabber(bot: Bot, ctx: WeaponContext, dt: number) {
  const w = bot.weapon;
  const T = bot.def.tuning.grabber;
  if (bot.holding) {
    const victim = bot.holding;
    w.holdTime += dt;
    w.crushTick += dt;
    if (!bot.alive || bot.airborne || bot.stun > 0) return releaseHold(ctx, bot, "stunned");
    if (!victim.alive) return releaseHold(ctx, bot, "destroyed");
    if (bot.wantRelease) return releaseHold(ctx, bot, "chosen");
    if (w.holdTime >= T.maxHold) return releaseHold(ctx, bot, "timeout");
    // Crush damage ticks in small bites so the HUD and sparks have a rhythm.
    if (w.crushTick >= 0.5) {
      w.crushTick -= 0.5;
      applyDamage(ctx, victim, bot, T.crushDps * 0.5, "crush", bot.weaponHitbox().at, 0.4, w.critHold);
    }
    return;
  }
  if (bot.trigger && w.cooldown <= 0 && bot.controllable) {
    const victims = victimsInHitbox(bot, ctx).filter((v) => !v.heldBy && !v.holding);
    if (victims.length) {
      const victim = victims.sort((a, b) => dist(a.p, bot.p) - dist(b.p, bot.p))[0];
      bot.holding = victim;
      victim.heldBy = bot;
      victim.vel = { x: 0, y: 0 };
      w.holdTime = 0;
      w.crushTick = 0;
      // Jaws around the back end find the soft parts: a rear grab crushes critically.
      w.critHold = isBehind(bot, victim);
      ctx.emit({ type: "grab", bot: bot.id, victim: victim.id });
    }
  }
}

function updateFlipper(bot: Bot, ctx: WeaponContext, dt: number) {
  const w = bot.weapon;
  const T = bot.def.tuning.flipper;
  if (w.flipAnim > 0) w.flipAnim = Math.max(0, w.flipAnim - dt / T.anim);
  if (bot.trigger && w.cooldown <= 0 && bot.controllable) {
    w.cooldown = T.cooldown;
    w.cooldownMax = T.cooldown;
    w.flipAnim = 1;
    const victims = victimsInHitbox(bot, ctx);
    const at = bot.weaponHitbox().at;
    const f = fromAngle(bot.heading);
    for (const victim of victims) {
      if (victim.heldBy) releaseHold(ctx, victim.heldBy, "stunned");
      if (victim.holding) releaseHold(ctx, victim, "stunned");
      const massFactor = Math.min(1, 1.15 / victim.mass) * (1 - victim.def.build.levels.wedge * 0.1);
      // Flipping a bot that is about to meet a wall is a critical: harder throw, uglier landing.
      const ahead = { x: victim.p.x + f.x * 1.8, y: victim.p.y + f.y * 1.8 };
      const nearWall = Math.abs(ahead.x) > WALL_LIMIT || Math.abs(ahead.y) > WALL_LIMIT;
      const crit = nearWall || ctx.rng() < CRIT_CHANCE.flipper;
      const throwMul = crit ? 1.15 : 1;
      victim.airborne = true;
      victim.vz = T.launchVz * massFactor * (crit ? 1.12 : 1);
      victim.launchedBy = bot.id;
      victim.vel = { x: 0, y: 0 };
      victim.shove(f.x * T.launchForward * massFactor * throwMul, f.y * T.launchForward * massFactor * throwMul);
      applyDamage(ctx, victim, bot, T.damage, "flip", at, 0.6, crit);
    }
    // Recoil
    bot.knock = scale(f, -1.2);
    ctx.emit({ type: "flip", bot: bot.id, victim: victims[0]?.id ?? null, at });
  }
}

/**
 * Horizontal bar spinner: a wide hitbox over the front half. Every hit launches the victim sideways,
 * kicks the spinner back and stops the bar. A bot that charges into the bar (closing fast) gets a critical.
 */
function updateSpinner(bot: Bot, ctx: WeaponContext, dt: number) {
  const w = bot.weapon;
  const T = bot.def.tuning.spinner;
  if (bot.alive && !bot.heldBy && bot.stun <= 0) w.spin = Math.min(1, w.spin + dt / T.spinUpSeconds);
  else w.spin = Math.max(0, w.spin - dt * 0.6);
  if (!bot.alive || bot.airborne || w.spin < 0.25) return;

  for (const victim of victimsInHitbox(bot, ctx)) {
    if (w.hitCooldowns.has(victim.id)) continue;
    w.hitCooldowns.set(victim.id, T.hitCooldown);
    const dir = norm(sub(victim.p, bot.p));
    const power = w.spin;
    // Closing speed of the victim toward the spinner: running into the bar is what makes it critical.
    const rel = sub({ x: victim.vel.x + victim.knock.x, y: victim.vel.y + victim.knock.y }, { x: bot.vel.x + bot.knock.x, y: bot.vel.y + bot.knock.y });
    const closing = -(rel.x * dir.x + rel.y * dir.y);
    const crit = closing > 2.4 || (power > 0.9 && ctx.rng() < CRIT_CHANCE.spinner);
    applyDamage(ctx, victim, bot, T.baseDamage + T.spinDamage * power, "spinner", bot.weaponHitbox().at, power, crit);
    // Tangential throw: the bar flings victims off to the side it is turning toward.
    const tangent = { x: -dir.y, y: dir.x };
    const kick = ((4.5 + 7 * power) * (crit ? 1.3 : 1)) / victim.mass;
    victim.shove((dir.x * 0.6 + tangent.x * 0.8) * kick, (dir.y * 0.6 + tangent.y * 0.8) * kick);
    bot.shove((-dir.x * (3 + 4 * power)) / bot.mass, (-dir.y * (3 + 4 * power)) / bot.mass);
    // A hop, not a throw: the bar flings bots across the floor, the flipper is what puts them in the air.
    if (power > T.launchSpin && !victim.airborne && !victim.heldBy && victim.alive) {
      victim.airborne = true;
      victim.vz = 2.2 + power * 1.3;
      victim.launchedBy = bot.id;
    }
    w.spin = Math.max(0.1, w.spin - T.biteCost);
  }
}

/**
 * Flamethrower: `spin` is fuel. While the trigger is held and fuel lasts, anything in the cone takes
 * flame damage (half-ignoring armor) and keeps burning for a while after. Rear burns are critical.
 */
function updateTorch(bot: Bot, ctx: WeaponContext, dt: number) {
  const w = bot.weapon;
  const T = bot.def.tuning.torch;
  const canFire = bot.alive && bot.controllable && bot.trigger && w.spin > 0.02;
  w.firing = canFire;
  if (!canFire) {
    if (bot.alive) w.spin = Math.min(1, w.spin + dt / T.refillSeconds);
    return;
  }
  w.spin = Math.max(0, w.spin - dt / T.burnSeconds);
  for (const victim of ctx.bots) {
    if (victim === bot || !victim.alive || !bot.torchCovers(victim)) continue;
    if (w.hitCooldowns.has(victim.id)) continue;
    w.hitCooldowns.set(victim.id, 0.25);
    const crit = isBehind(bot, victim);
    applyDamage(ctx, victim, bot, T.dps * 0.25, "torch", victim.p, 0.6, crit);
    victim.burn = Math.max(victim.burn, T.burnTime);
    victim.burnBy = bot.id;
  }
}

/**
 * Ram: `spin` is the boost reserve. The trigger burns it for a short, fast charge; the slam itself is
 * resolved in the world's collision pass (see `ramSlam`).
 */
function updateRam(bot: Bot, ctx: WeaponContext, dt: number) {
  const w = bot.weapon;
  const T = bot.def.tuning.ram;
  const wasBoosting = w.boosting;
  w.boosting = bot.alive && bot.controllable && bot.trigger && w.spin > 0.05;
  if (w.boosting) {
    w.spin = Math.max(0, w.spin - dt / T.burst);
    if (!wasBoosting) ctx.emit({ type: "boost", bot: bot.id });
  } else if (bot.alive) {
    w.spin = Math.min(1, w.spin + dt / T.refill);
  }
}

/**
 * Called from the collision pass when `ram` (a ram-plate bot) meets `victim`. `n` points from the ram to
 * the victim; `closing` is their approach speed along it. Front-on contact at speed does damage and
 * shoves; pinning the victim against a wall is a critical. Slow pushes still claim the kill credit.
 */
export function ramSlam(ctx: WeaponContext, ram: Bot, victim: Bot, n: { x: number; y: number }, closing: number): boolean {
  const f = ram.forward;
  if (f.x * n.x + f.y * n.y < 0.55) return false;
  const T = ram.def.tuning.ram;
  if (closing > 0.4) {
    victim.lastHitBy = ram.id;
    victim.lastHitAt = ctx.time;
  }
  const ahead = { x: victim.p.x + n.x * 1.7, y: victim.p.y + n.y * 1.7 };
  const pinned = Math.abs(ahead.x) > WALL_LIMIT || Math.abs(ahead.y) > WALL_LIMIT;
  // Leaning on a bot that has nowhere to go grinds it against the wall.
  const pinKey = `pin:${victim.id}`;
  if (pinned && ram.throttle > 0.3 && closing >= -0.5 && !ram.weapon.hitCooldowns.has(pinKey)) {
    ram.weapon.hitCooldowns.set(pinKey, 0.25);
    applyDamage(ctx, victim, ram, T.pinDps * 0.25, "ram", victim.p, 0.25, false);
    victim.shove((n.x * 1.2) / victim.mass, (n.y * 1.2) / victim.mass);
  }
  if (closing < 2.0 || ram.weapon.hitCooldowns.has(victim.id)) return true;
  ram.weapon.hitCooldowns.set(victim.id, 0.5);
  const crit = pinned || victim.stun > 0 || ctx.rng() < CRIT_CHANCE.ram;
  const boost = ram.weapon.boosting ? 1.35 : 1;
  // Heavier rams hit harder; a boosted slam leaves the victim reeling for a beat so the push can continue.
  const heft = 0.6 + ram.mass * 0.35;
  applyDamage(ctx, victim, ram, (closing - 2.0) * T.hitMul * boost * heft, "ram", victim.p, Math.min(1, closing / 8), crit);
  victim.shove((n.x * (2.5 + closing * 0.4) * boost) / victim.mass, (n.y * (2.5 + closing * 0.4) * boost) / victim.mass);
  if (ram.weapon.boosting) victim.stunFor(0.35);
  if (victim.holding) releaseHold(ctx, victim, "stunned");
  ctx.emit({ type: "slam", bot: ram.id, victim: victim.id, speed: closing, at: { ...victim.p } });
  return true;
}

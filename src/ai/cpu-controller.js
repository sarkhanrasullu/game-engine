// CPU opponent (story-004; design/game-brief.md MVP feature 4). Drives a fighter only by filling
// the same input snapshot a human produces (src/input/input-snapshot.js createSnapshot shape).
// It reads both fighters read-only through perception.js: its own state as it is now, the
// opponent's as it was `reactionFrames` ticks ago. Pure: no DOM, no three.js, allocation-free
// per tick. All numbers come from the injected difficulty level and behaviour table (difficulty.js
// validates them; the game owns the data).
//
// Decision order each tick (first match wins):
//   1. KO / stunned            -> neutral input
//   1b. first free tick after own blockstun, meter full -> Overwind reversal when the blocked attack
//                                 (already perceived, extrapolated from public frame data) leaves an
//                                 Overwind-sized window (superBlockPunishChance, or always at
//                                 superComebackHp or less of own HP; story-011 Normal Overwind rule)
//   2. incoming attack in range -> block (blockChance) or sidestep (sidestepChance), rolled once per attack
//   3. own blockstun           -> keep guard held
//   4. attack in recovery      -> punish with the best move that lands in time (whiffPunishChance, once per attack);
//                                 with a full meter, Overwind first (superPunishChance, or always at
//                                 superComebackHp or less of own HP), else the most damaging key
//   5. neutral plan            -> utility-weighted wait / approach / back off / poke / guard / sidestep,
//                                 throw a guarding opponent in range (throwChance); mistakeRate picks at random;
//                                 then, with specialShare, a special whose `aiRole` fits the delayed view
//                                 (story-009 §9.3). Overwind is never used raw in neutral.
//
// Range gate (design/quick-specs/fighter-identity-balance.md §2): every reach is measured against the
// real target's kit body radius (rules.hurtRadius only for an unequipped greybox fighter). The
// CPU's poke range is the longest of behaviour.pokeKeys, so it is derived from each kit's data and
// never branches on which character it drives. The opponent's kit is public (character select).
//
// Personalities (story-011, src/ai/personalities.js) only rescale these numbers before the pilot is
// built; the fairness rules (reaction delay, input snapshot only, public state) are unchanged.
import { STATE, PHASE, moveTotal, overwindReady } from '../sim/state-machine.js';
import { SeededRng } from '../core/rng.js';
import { DelayedView, createObservation, observe } from './perception.js';
import { applyPersonality } from './personalities.js';

/** No personalities: the default table of a pilot built without one. */
const NO_PERSONALITIES = Object.freeze({});

/** Neutral plans. */
export const PLAN = Object.freeze({
  WAIT: 'wait',
  APPROACH: 'approach',
  BACK_OFF: 'backOff',
  POKE: 'poke',
  GUARD: 'guard',
  SIDESTEP: 'sidestep',
  THROW: 'throw',
  SPECIAL: 'special',
});
/** Plans the utility roll and mistakeRate pick from (SPECIAL only comes from the aiRole roll). */
const PLANS = Object.freeze([
  PLAN.WAIT, PLAN.APPROACH, PLAN.BACK_OFF, PLAN.POKE, PLAN.GUARD, PLAN.SIDESTEP, PLAN.THROW,
]);

/** CPU roles a special move may declare (moves.js AI_ROLES; story-009 §4). */
export const AI_ROLE = Object.freeze({
  GAP_CLOSE: 'gapClose', LOW_POKE: 'lowPoke', ANTI_STEP: 'antiStep', RETREAT_POKE: 'retreatPoke',
});

/** Move-input keys the CPU may use as neutral specials (picked by the move's aiRole). */
const SPECIAL_KEYS = Object.freeze(['specialForward', 'specialBack']);

/** Why the CPU produced this tick's input (debug readout; non-neutral reasons). */
export const REASON = Object.freeze({
  KO: 'ko', STUNNED: 'stunned', BLOCK: 'block', EVADE: 'evade', BLOCKSTUN: 'blockstun', PUNISH: 'punish',
});

const DEFENCE_NONE = 0;
const DEFENCE_BLOCK = 1;
const DEFENCE_EVADE = 2;

/** States where a sidestep tap is accepted (locomotion). */
const CAN_SIDESTEP = Object.freeze({ idle: true, walk: true, crouch: true, sidestep: true });

/**
 * Horizontal centre distance at which move `m` can still connect: hitbox reach plus the target's
 * hurtbox radius (see moves.js hitbox schema and collision.js), plus forward travel (story-009 §4:
 * `forward + radius + bodyRadius + max(travel.distance, 0)`).
 * @param {import('../fighters/moves.js').MoveData} m
 * @param {number} hurtRadius
 */
export function moveReach(m, hurtRadius) {
  const t = m.travel;
  const travel = t !== undefined && t.distance > 0 ? t.distance : 0;
  return m.hitbox.forward + m.hitbox.radius + hurtRadius + travel;
}

function clearSnapshot(out) {
  out.stick.x = 0;
  out.stick.y = 0;
  out.light = false;
  out.heavy = false;
  out.guard = false;
  out.throw = false;
  out.sidestep = 0;
}

/**
 * Write the buttons for move-input key `key` (a key of the fighter's moveInputs) into `out`.
 * Crouching moves also hold the stick down (the fighter must already be crouching on this tick).
 */
function pressMove(out, key) {
  switch (key) {
    case 'light': out.light = true; break;
    case 'heavy': out.heavy = true; break;
    case 'crouchLight': out.light = true; out.stick.y = -1; break;
    case 'crouchHeavy': out.heavy = true; out.stick.y = -1; break;
    case 'throw': out.throw = true; break;
    case 'overwind': out.heavy = true; out.guard = true; break;
    case 'specialForward': out.heavy = true; out.stick.x = 1; break; // stick toward + Heavy (§2)
    case 'specialBack': out.heavy = true; out.stick.x = -1; break; // stick away + Heavy
    default: break;
  }
}

/** Punish candidates in preference order when damage ties (story-009 §9.2). */
const PUNISH_KEYS = Object.freeze(['overwind', 'heavy', 'specialForward', 'throw', 'light']);

/** Move-input keys performed from a crouch (the stick is held down a tick before the button). */
const CROUCH_KEYS = Object.freeze({ crouchLight: true, crouchHeavy: true });

/**
 * Body radius an attack on fighter `f` must reach: its kit hurtbox, or the greybox rules radius.
 * @param {Readonly<Record<string, any>>} f
 * @param {Readonly<Record<string, number>>} rules ruleset.rules
 */
export function bodyRadiusOf(f, rules) {
  const hb = f.spec?.hurtbox;
  return hb !== undefined && hb !== null ? hb.bodyRadius : rules.hurtRadius;
}

/**
 * Reach of `attacker`'s move-input `key` against a target of body radius `targetR`
 * (-Infinity when the kit lacks the move).
 */
function keyReach(attacker, key, targetR) {
  const m = attacker.moves[attacker.moveInputs[key]];
  return m === undefined ? -Infinity : moveReach(m, targetR);
}

/**
 * Best poke reach: the longest reach over `pokeKeys` of `attacker` against body radius `targetR`.
 * @param {Readonly<Record<string, any>>} attacker
 * @param {readonly string[]} pokeKeys
 * @param {number} targetR
 */
export function bestPokeReach(attacker, pokeKeys, targetR) {
  let best = -Infinity;
  for (let i = 0; i < pokeKeys.length; i++) {
    const r = keyReach(attacker, pokeKeys[i], targetR);
    if (r > best) best = r;
  }
  return best;
}

/**
 * One CPU pilot. Call `sample(out, self, opp)` once per sim tick before stepDuel, exactly where
 * a human's InputState.sample would be called.
 */
export class CpuPilot {
  /**
   * @example
   *   const ai = buildDifficultySet(aiJson);
   *   const cpu = new CpuPilot({ difficulty: ai.levels.normal, behaviour: ai.behaviour, rules: ruleset.rules, seed: 7 });
   *   cpu.sample(snapshot, sim.fighters[1], sim.fighters[0]); // then stepDuel(...)
   * @param {object} opts
   * @param {Readonly<Record<string, number>>} opts.difficulty a level (buildDifficulty / buildDifficultySet)
   * @param {Readonly<Record<string, number>>} opts.behaviour shared tuning (buildBehaviour)
   * @param {number} [opts.seed] RNG seed; same seed + same inputs = same decisions
   * @param {Readonly<Record<string, number>>} opts.rules sim rules, ruleset.rules (hurtbox radius, Overwind threshold)
   * @param {Readonly<Record<string, ReturnType<typeof import('./personalities.js').buildPersonality>>>} [opts.personalities]
   *   personalityId -> personality (buildPersonalities); default none
   * @param {string|null} [opts.personalityId] a key of `personalities` layered on `difficulty` and
   *   `behaviour` (story-011); null = none. Unknown ids throw.
   * @param {((frame:number, reason:string, pokeKey:string|null) => void) | null} [opts.onDecision] debug hook,
   *   called on every fresh neutral plan pick and whenever the reason (or its key) changes
   */
  constructor({
    difficulty, behaviour, seed = 1, rules, personalities = NO_PERSONALITIES, personalityId = null, onDecision = null,
  }) {
    if (personalityId !== null && !Object.hasOwn(personalities, personalityId)) {
      throw new Error(`CpuPilot: unknown personalityId ${personalityId}`);
    }
    /** Personality layered on the level (null = none); read by the arcade ladder and debug UI. */
    this.personalityId = personalityId;
    const tuned = applyPersonality(personalityId === null ? null : personalities[personalityId], difficulty, behaviour);
    this.difficulty = tuned.difficulty;
    this.behaviour = tuned.behaviour;
    this.rules = rules;
    this.rng = new SeededRng(seed);
    this.onDecision = onDecision;
    this.view = new DelayedView(difficulty.reactionFrames);
    this.me = createObservation();
    this.weights = new Float64Array(PLANS.length);
    /** Scratch: special keys that fit this decision (allocation-free). */
    this.fits = new Array(SPECIAL_KEYS.length).fill(null);
    /** Debug readout: why this tick's input was produced (a REASON or a PLAN). */
    this.reason = PLAN.WAIT;
    /** Debug readout: the poke key behind a POKE reason, else null. */
    this.reasonKey = null;
    this.reset();
  }

  /** Forget the opponent's history and the current plan (call on a round reset). */
  reset() {
    this.view.reset();
    this.frame = 0;
    this.serial = 0;
    this.prevState = STATE.IDLE;
    this.prevStateFrame = 0;
    this.defendSerial = -1;
    this.defence = DEFENCE_NONE;
    this.evadeSent = false;
    this.punishSerial = -1;
    this.punishGo = false;
    this.superGo = false;
    this.wasBlockstun = false;
    this.fresh = false;
    this.specialKey = 'specialForward';
    this.plan = PLAN.WAIT;
    this.planLeft = 0;
    this.planTick = 0;
    this.pokeKey = 'light';
    this.sideDir = 1;
  }

  /**
   * Fill `out` for one sim tick. Reads `self` and `opp` only (never writes them).
   * @param {ReturnType<typeof import('../input/input-snapshot.js').createSnapshot>} out
   * @param {Readonly<Record<string, any>>} self the fighter this CPU drives
   * @param {Readonly<Record<string, any>>} opp the other fighter
   */
  sample(out, self, opp) {
    const me = observe(this.me, self, this.frame);
    const them = this.view.push(opp);
    // Own state is known instantly: the first free tick after own blockstun.
    const leftBlockstun = this.wasBlockstun && me.state !== STATE.BLOCKSTUN;
    this.wasBlockstun = me.state === STATE.BLOCKSTUN;
    this.frame++;
    if (them.state === STATE.ATTACK
      && (this.prevState !== STATE.ATTACK || them.stateFrame < this.prevStateFrame)) this.serial++;
    this.prevState = them.state;
    this.prevStateFrame = them.stateFrame;
    clearSnapshot(out);

    if (me.state === STATE.KO || them.state === STATE.KO) return this.#say(REASON.KO, out);
    if (me.state === STATE.HITSTUN || me.state === STATE.THROWN) {
      this.planLeft = 0;
      return this.#say(REASON.STUNNED, out);
    }

    const myR = bodyRadiusOf(self, this.rules); // what the opponent's moves must reach
    const theirR = bodyRadiusOf(opp, this.rules); // what this CPU's moves must reach
    const dx = them.x - me.x;
    const dz = them.z - me.z;
    const dist = Math.hypot(dx, dz);

    // 1b. Overwind reversal after a blocked attack that leaves an Overwind-sized window.
    if (leftBlockstun && overwindReady(self) && this.#wantsReversal(self, them, dist, theirR)) {
      pressMove(out, 'overwind');
      this.planLeft = 0;
      return this.#say(REASON.PUNISH, out, 'overwind');
    }

    // 2. Reactive defence against an attack the CPU can already see.
    if (them.state === STATE.ATTACK && !them.attackHasHit && them.move.level !== 'throw'
      && (them.phase === PHASE.STARTUP || them.phase === PHASE.ACTIVE)
      && dist <= moveReach(them.move, myR) + this.behaviour.threatMargin) {
      if (this.defendSerial !== this.serial) {
        this.defendSerial = this.serial;
        this.evadeSent = false;
        if (this.rng.chance(this.difficulty.blockChance)) this.defence = DEFENCE_BLOCK;
        else if (this.rng.chance(this.difficulty.sidestepChance)) this.defence = DEFENCE_EVADE;
        else this.defence = DEFENCE_NONE;
      }
      if (this.defence === DEFENCE_BLOCK) {
        out.guard = true;
        out.stick.y = them.move.level === 'low' ? -1 : 0;
        this.planLeft = 0;
        return this.#say(REASON.BLOCK, out);
      }
      if (this.defence === DEFENCE_EVADE) {
        if (!this.evadeSent && CAN_SIDESTEP[me.state] === true) {
          out.sidestep = this.rng.chance(0.5) ? 1 : -1;
          this.evadeSent = true;
        }
        this.planLeft = 0;
        return this.#say(REASON.EVADE, out);
      }
    }

    // 3. Still in blockstun: keep guarding.
    if (me.state === STATE.BLOCKSTUN) {
      out.guard = true;
      this.planLeft = 0;
      return this.#say(REASON.BLOCKSTUN, out);
    }

    // 4. Punish an attack in recovery (it whiffed, or it was blocked and blockstun is over).
    if (them.state === STATE.ATTACK && them.phase === PHASE.RECOVERY) {
      if (this.punishSerial !== this.serial) {
        this.punishSerial = this.serial;
        this.punishGo = this.rng.chance(this.difficulty.whiffPunishChance);
        // Overwind is a punish only (never raw in neutral); rolled once per attack, and only with a
        // full meter so the RNG stream is unchanged while the meter fills.
        this.superGo = this.punishGo && overwindReady(self) && this.#wantsSuper(self);
      }
      // Ticks until the opponent can act, extrapolated from what the CPU saw reactionFrames ago.
      const left = moveTotal(them.move) - them.stateFrame - this.difficulty.reactionFrames;
      if (this.punishGo && left > 0) {
        const key = this.#pickPunish(self, dist, left, theirR);
        if (key !== null) {
          pressMove(out, key);
          this.punishGo = false;
          this.planLeft = 0;
          return this.#say(REASON.PUNISH, out, key);
        }
        const closeR = this.#punishCloseReach(self, left, theirR);
        if (closeR > 0 && dist > closeR) {
          out.stick.x = 1; // close the gap, then punish next tick
          this.planLeft = 0;
          return this.#say(REASON.PUNISH, out);
        }
      }
    }

    // 5. Neutral.
    if (this.planLeft <= 0) this.#choosePlan(me, them, self, opp, dist, myR, theirR);
    this.#runPlan(out, me, them, self, dist, theirR);
    this.planLeft--;
    this.planTick++;
    const key = this.plan === PLAN.POKE ? this.pokeKey : this.plan === PLAN.SPECIAL ? this.specialKey : null;
    return this.#say(this.plan, out, key);
  }

  /**
   * Whether a full-meter punish spends Overwind: always at or below superComebackHp of own HP
   * (comeback), else with superPunishChance.
   */
  #wantsSuper(self) {
    const d = this.difficulty;
    if (self.maxHp > 0 && self.hp / self.maxHp <= d.superComebackHp) return true;
    return this.rng.chance(d.superPunishChance);
  }

  /**
   * Blocked-attack reversal (story-011): the delayed view must already show the attack (so it was
   * perceived, never guessed), extrapolated to now it must have reached its active frames (it is the
   * one just blocked), and from public frame data it must leave `overwind.startup + 1 < left` ticks
   * with the target in Overwind reach. Then: always at superComebackHp or less, else one roll of
   * superBlockPunishChance. No roll is made when both are off, so such levels keep their RNG stream.
   */
  #wantsReversal(self, them, dist, targetR) {
    const d = this.difficulty;
    const comeback = self.maxHp > 0 && self.hp / self.maxHp <= d.superComebackHp;
    if (!comeback && d.superBlockPunishChance <= 0) return false;
    if (them.state !== STATE.ATTACK || them.move.level === 'throw') return false;
    if (them.stateFrame + d.reactionFrames < them.move.startup) return false;
    const m = self.moves[self.moveInputs.overwind];
    if (m === undefined) return false;
    const left = moveTotal(them.move) - them.stateFrame - d.reactionFrames;
    if (m.startup + 1 >= left || dist > moveReach(m, targetR) - this.behaviour.reachMargin) return false;
    return comeback || this.rng.chance(d.superBlockPunishChance);
  }

  /** True when punish key `key` may be used now (Overwind only with a full meter and a won roll). */
  #punishAllowed(self, key) {
    return key !== 'overwind' || (this.superGo && overwindReady(self));
  }

  #say(reason, out, key = null) {
    if (this.fresh || reason !== this.reason || key !== this.reasonKey) {
      this.fresh = false;
      this.reason = reason;
      this.reasonKey = key;
      if (this.onDecision !== null) this.onDecision(this.frame, reason, key);
    }
    return out;
  }

  /**
   * Distance to close before punishing: the longest reach (minus reachMargin) over the punish
   * moves that still start up in time (`startup + 1 < left`). <= 0 when none does.
   */
  #punishCloseReach(self, left, targetR) {
    let best = -Infinity;
    for (const key of PUNISH_KEYS) {
      if (!this.#punishAllowed(self, key)) continue;
      const m = self.moves[self.moveInputs[key]];
      if (m === undefined || m.startup + 1 >= left) continue;
      const r = moveReach(m, targetR) - this.behaviour.reachMargin;
      if (r > best) best = r;
    }
    return best;
  }

  /**
   * Punish key (story-009 §9.2): over PUNISH_KEYS filtered by `startup + 1 < left` and reach
   * (including travel), Overwind when it qualifies and was chosen for this attack, else the most
   * damaging (ties keep PUNISH_KEYS order). null when nothing fits.
   */
  #pickPunish(self, dist, left, targetR) {
    const margin = this.behaviour.reachMargin;
    let best = null;
    let bestDmg = -1;
    for (const key of PUNISH_KEYS) {
      if (!this.#punishAllowed(self, key)) continue;
      const m = self.moves[self.moveInputs[key]];
      if (m === undefined || m.startup + 1 >= left || dist > moveReach(m, targetR) - margin) continue;
      if (key === 'overwind') return key;
      if (m.damage > bestDmg) {
        best = key;
        bestDmg = m.damage;
      }
    }
    return best;
  }

  #choosePlan(me, them, self, opp, dist, myR, theirR) {
    const d = this.difficulty;
    const b = this.behaviour;
    const rng = this.rng;
    const pokeR = bestPokeReach(self, b.pokeKeys, theirR) - b.reachMargin;
    const throwR = keyReach(self, 'throw', theirR) - b.reachMargin;
    // The opponent's kit is public knowledge (the character select shows it): its best poke.
    const oppR = bestPokeReach(opp, b.pokeKeys, myR) + b.threatMargin;
    const guarding = them.state === STATE.GUARD || them.state === STATE.BLOCKSTUN;
    const agg = d.aggression;

    let plan;
    if (rng.chance(d.mistakeRate)) {
      plan = PLANS[rng.int(PLANS.length)];
    } else if (guarding && dist <= throwR && rng.chance(d.throwChance)) {
      plan = PLAN.THROW;
    } else {
      const w = this.weights;
      const inOppRange = dist <= oppR;
      w[0] = b.waitWeight * (1 - agg); // WAIT
      w[1] = dist > (guarding ? throwR : pokeR) ? agg : 0; // APPROACH
      w[2] = inOppRange ? b.backOffWeight * (1 - agg) : 0; // BACK_OFF
      w[3] = dist <= pokeR ? (guarding ? agg * 0.2 : agg) : 0; // POKE (pokes into guard are weak)
      w[4] = inOppRange ? b.guardWeight * d.blockChance : 0; // GUARD (pre-emptive; scales with the level's block skill)
      w[5] = b.sidestepWeight * d.sidestepChance; // SIDESTEP
      w[6] = 0; // THROW only via the throwChance roll above
      let total = 0;
      for (let i = 0; i < w.length; i++) total += w[i];
      let r = rng.next() * total;
      plan = PLAN.WAIT;
      for (let i = 0; i < w.length; i++) {
        if (w[i] > 0 && r < w[i]) {
          plan = PLANS[i];
          break;
        }
        r -= w[i];
      }
      // Neutral specials (§9.3), rolled after the poke roll and only on an offensive pick (APPROACH
      // or POKE), so specials scale with aggression; from the delayed view only, and only specials
      // in reach can be picked.
      const n = plan === PLAN.APPROACH || plan === PLAN.POKE ? this.#fitSpecials(them, self, dist, pokeR, oppR, theirR) : 0;
      if (n > 0 && rng.chance(d.specialShare)) {
        plan = PLAN.SPECIAL;
        this.specialKey = this.fits[n === 1 ? 0 : rng.int(n)];
      }
    }

    if (plan === PLAN.POKE) {
      this.pokeKey = this.#pickPoke(self, dist, theirR, them.crouching, rng.next());
    } else if (plan === PLAN.SIDESTEP) {
      this.sideDir = rng.chance(0.5) ? 1 : -1;
    }
    this.plan = plan;
    this.fresh = true; // a new pick is logged even when it repeats the last plan
    this.planTick = 0;
    this.planLeft = d.decisionFrames + rng.int(b.planJitterFrames);
  }

  /**
   * Fill `this.fits` with the special keys whose move's aiRole fits the (delayed) view this tick
   * and which reach `dist` (minus reachMargin); returns how many. Never branches on character.
   *   gapClose     pokeR < dist <= its reach
   *   lowPoke      in reach and the opponent stands guarding or is in the startup of an armoured move
   *   antiStep     in reach and the opponent is sidestepping
   *   retreatPoke  in reach and dist <= oppR (inside the opponent's threat range)
   */
  #fitSpecials(them, self, dist, pokeR, oppR, targetR) {
    let n = 0;
    for (const key of SPECIAL_KEYS) {
      const id = self.moveInputs[key];
      const m = id === undefined ? undefined : self.moves[id];
      if (m === undefined || m.aiRole === undefined) continue;
      if (dist > moveReach(m, targetR) - this.behaviour.reachMargin) continue;
      let fits = false;
      switch (m.aiRole) {
        case AI_ROLE.GAP_CLOSE: fits = dist > pokeR; break;
        case AI_ROLE.LOW_POKE:
          fits = (them.state === STATE.GUARD && !them.crouching)
            || (them.state === STATE.ATTACK && them.phase === PHASE.STARTUP && them.move.armor !== undefined);
          break;
        case AI_ROLE.ANTI_STEP: fits = them.state === STATE.SIDESTEP; break;
        case AI_ROLE.RETREAT_POKE: fits = dist <= oppR; break;
        default: break;
      }
      if (fits) this.fits[n++] = key;
    }
    return n;
  }

  /**
   * Poke key for a POKE plan from the poke keys that reach `dist` (spec §2.3), one roll `r`:
   * heavy by heavyPokeShare, else crouchLight by lowPokeShare or against a crouching opponent,
   * else light; when the preferred move does not reach, the reaching key with the longest reach.
   * With nothing in reach (a mistakeRate pick) it is the longest-reaching poke key.
   */
  #pickPoke(self, dist, targetR, oppCrouching, r) {
    const b = this.behaviour;
    const keys = b.pokeKeys;
    if (r < b.heavyPokeShare && this.#pokeReaches(self, 'heavy', dist, targetR)) return 'heavy';
    if ((r < b.heavyPokeShare + b.lowPokeShare || oppCrouching)
      && this.#pokeReaches(self, 'crouchLight', dist, targetR)) return 'crouchLight';
    if (this.#pokeReaches(self, 'light', dist, targetR)) return 'light';
    let best = keys[0];
    let bestR = -Infinity;
    let bestIn = false;
    for (const key of keys) {
      const R = keyReach(self, key, targetR) - b.reachMargin;
      const isIn = dist <= R;
      if ((isIn && !bestIn) || (isIn === bestIn && R > bestR)) {
        best = key;
        bestR = R;
        bestIn = isIn;
      }
    }
    return best;
  }

  /** True when `key` is a data poke key and reaches `dist` (minus reachMargin). */
  #pokeReaches(self, key, dist, targetR) {
    const b = this.behaviour;
    return b.pokeKeys.includes(key) && dist <= keyReach(self, key, targetR) - b.reachMargin;
  }

  #runPlan(out, me, them, self, dist, theirR) {
    switch (this.plan) {
      case PLAN.APPROACH: {
        out.stick.x = 1;
        const guarding = them.state === STATE.GUARD || them.state === STATE.BLOCKSTUN;
        const b = this.behaviour;
        const goal = (guarding ? keyReach(self, 'throw', theirR) : bestPokeReach(self, b.pokeKeys, theirR)) - b.reachMargin;
        if (dist <= goal) this.planLeft = 1; // in range: re-decide next tick
        break;
      }
      case PLAN.BACK_OFF: {
        const edge = self.movement.ringRadius - this.behaviour.ringEdgeMargin;
        if (Math.hypot(me.x, me.z) > edge) {
          this.plan = PLAN.SIDESTEP; // cornered: circle out instead of backing into the edge
          this.planTick = 0;
          this.sideDir = this.rng.chance(0.5) ? 1 : -1;
          this.#runPlan(out, me, them, self, dist, theirR);
        } else {
          out.stick.x = -1;
        }
        break;
      }
      case PLAN.POKE: {
        const crouching = CROUCH_KEYS[this.pokeKey] === true;
        if (crouching) out.stick.y = -1; // crouch first; the crouching move comes out next tick
        if (this.planTick === (crouching ? 1 : 0)) pressMove(out, this.pokeKey);
        break;
      }
      case PLAN.GUARD:
        out.guard = true;
        break;
      case PLAN.SIDESTEP:
        if (this.planTick === 0) {
          if (CAN_SIDESTEP[me.state] === true) out.sidestep = this.sideDir;
          else this.planTick = -1; // not free yet: try again next tick
        }
        break;
      case PLAN.THROW:
        if (this.planTick === 0) out.throw = true;
        break;
      case PLAN.SPECIAL:
        if (this.planTick === 0) pressMove(out, this.specialKey);
        break;
      default:
        break;
    }
  }
}

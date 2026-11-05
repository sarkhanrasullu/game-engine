// CPU opponent (story-004; design/game-brief.md MVP feature 4). Drives a fighter only by filling
// the same input snapshot a human produces (src/input/input-snapshot.js createSnapshot shape).
// It reads both fighters read-only through perception.js: its own state as it is now, the
// opponent's as it was `reactionFrames` ticks ago. Pure: no DOM, no three.js, allocation-free
// per tick (the one allocation is the re-tune when the kits in the ring change, once per match).
// All numbers come from the injected difficulty level, behaviour table, personality and matchup
// data (difficulty.js / personalities.js validate them; the game owns the data). Every move the
// pilot reasons about is found through the fighter's own kit (moveInputs, frame data, `aiRole`,
// `cancel`, `armor`, `travel`), never through a character or move name.
//
// Decision order each tick (first match wins):
//   1. KO / stunned            -> neutral input; when thrown, reactionFrames after the grab, one roll to tech it
//                                 (throwTechChance; the grabber's public move data says if it can be broken)
//   1a. standing in a stage hazard zone it can see -> walk out (hazardEvadeChance; story-013)
//   1b. first free tick after own blockstun, meter full -> Overwind reversal when the blocked attack
//                                 leaves an Overwind-sized window (superBlockPunishChance / superComebackHp)
//   1b2. own blockstun, pressure it cannot punish, meter for it -> Vent (ventChance, once per attack; within one cost
//                                 of a full meter it saves the meter when it wants the Overwind)
//   1c. own Light string        -> the next hit of a `cancel` string once the opener connected, inside
//                                 the cancel window (stringConfirmChance, rolled once per own attack)
//   1c2. own counter / punish hit -> link the most damaging strike whose startup fits the defender's remaining
//                                 stun, on the first tick the sim can start it (linkChance, once per hit)
//   1d. first free tick after an own attack that connected -> frame-data read: blocked at minus frames
//                                 -> hold guard for the disadvantage plus the reaction delay
//                                 (disadvantageRespect; never mash into a punish); landed or plus on
//                                 block -> press: throw a blocker, jab, or close in (pressureChance)
//   2. incoming attack in range -> one roll per attack: an armoured move that absorbs it (counterChance),
//                                 block (blockChance), sidestep (sidestepChance), walk back out of a tip
//                                 poke (retreatChance); a slow throw -> jump over it (jumpChance)
//   2b. opponent airborne       -> the kit's `antiAir` move when it reaches (antiAirChance, once per jump)
//   3. own blockstun           -> keep guard held
//   4. attack in recovery      -> punish with the best move that lands in time (whiffPunishChance, once per
//                                 attack); with a full meter, Overwind first (superPunishChance, or always
//                                 at superComebackHp or less of own HP), else the most damaging key. From
//                                 inside a sidestep past its cut: attack out of the step instead
//                                 (stepPunishChance, once per attack)
//   4b. own sidestep           -> runs out: no neutral decision acts out of a step
//   5. neutral plan            -> utility-weighted wait / approach / back off / poke / guard / sidestep /
//                                 jump around a preferred range (rangeBias: between close range and the
//                                 longest poke), throw a guarding opponent in range (throwChance; once a
//                                 throw of its was teched this round, an untechable throw special instead),
//                                 mistakeRate picks at random; then, with specialShare, a special whose
//                                 `aiRole` fits the delayed view (story-009 §9.3). Overwind is never raw.
//
// Pokes carry intent (#pickPoke): a low against a standing guard, a mid against a crouching
// opponent, a Light (string opener) in close range, the Heavy from its tip with heavyPokeShare, and
// outside Light range the heavy tip poke competes with walking in.
//
// Range gate (design/quick-specs/fighter-identity-balance.md §2): every reach is measured against the
// real target's kit body radius (rules.hurtRadius only for an unequipped greybox fighter). The
// CPU's poke range is the longest of behaviour.pokeKeys, so it is derived from each kit's data and
// never branches on which character it drives. The opponent's kit is public (character select).
//
// Personalities (story-011) and matchups (AI-DEPTH, personalities.js buildMatchups) only rescale these
// numbers; the fairness rules (reaction delay, input snapshot only, public state) are unchanged.
import { STATE, PHASE, moveTotal, overwindReady, canAfford, sidestepCancellable } from '../sim/state-machine.js';
import { SeededRng } from '../core/rng.js';
import { DelayedView, createObservation, observe, createHazardObservation, observeHazards } from './perception.js';
import { applyPersonality } from './personalities.js';
import { buildBehaviour } from './difficulty.js';

/** No personalities / matchups: the default tables of a pilot built without them. */
const NO_TABLE = Object.freeze({});

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
  JUMP: 'jump',
});
/** Plans the utility roll and mistakeRate pick from (SPECIAL only comes from the aiRole roll). */
const PLANS = Object.freeze([
  PLAN.WAIT, PLAN.APPROACH, PLAN.BACK_OFF, PLAN.POKE, PLAN.GUARD, PLAN.SIDESTEP, PLAN.THROW, PLAN.JUMP,
]);

/** CPU roles a move may declare (moves.js AI_ROLES; story-009 §4, AI-DEPTH antiAir). */
export const AI_ROLE = Object.freeze({
  GAP_CLOSE: 'gapClose', LOW_POKE: 'lowPoke', ANTI_STEP: 'antiStep', RETREAT_POKE: 'retreatPoke', ANTI_AIR: 'antiAir',
});

/** Move-input keys the CPU may use as neutral specials (picked by the move's aiRole). */
const SPECIAL_KEYS = Object.freeze(['specialForward', 'specialBack']);

/** Why the CPU produced this tick's input (debug readout; non-neutral reasons). */
export const REASON = Object.freeze({
  KO: 'ko', STUNNED: 'stunned', BLOCK: 'block', EVADE: 'evade', RETREAT: 'retreat', BLOCKSTUN: 'blockstun',
  PUNISH: 'punish', HAZARD: 'hazard', STRING: 'string', RESPECT: 'respect', COUNTER: 'counter', ANTI_AIR: 'antiAir',
  LINK: 'link', TECH: 'tech', VENT: 'vent',
});

/** Hazard slots a pilot preallocates (sim.hazards beyond this are invisible to it). */
const MAX_HAZARDS = 8;

const DEFENCE_NONE = 0;
const DEFENCE_BLOCK = 1;
const DEFENCE_EVADE = 2;
const DEFENCE_RETREAT = 3;
const DEFENCE_COUNTER = 4;
const DEFENCE_JUMP = 5;

/** States where a sidestep tap, a jump or a fresh press is accepted (locomotion). */
const CAN_SIDESTEP = Object.freeze({ idle: true, walk: true, crouch: true, sidestep: true });

/**
 * Horizontal centre distance at which move `m` can still connect: hitbox reach plus the target's
 * hurtbox radius (see moves.js hitbox schema and collision.js), plus forward travel (story-009 §4:
 * `forward + radius + bodyRadius + max(travel.distance, 0)`).
 * @param {import('../sim/moves.js').MoveData} m
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
const PUNISH_KEYS = Object.freeze(['overwind', 'heavy', 'specialForward', 'specialBack', 'crouchHeavy', 'throw', 'light']);

/** Keys whose move may carry armour the CPU can answer a strike with (found by the move's `armor`). */
const COUNTER_KEYS = Object.freeze(['specialBack', 'specialForward', 'heavy', 'crouchHeavy']);

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

/** Move of `attacker`'s move-input `key`, or undefined when the kit lacks it. */
function keyMove(attacker, key) {
  const id = attacker.moveInputs[key];
  return id === undefined ? undefined : attacker.moves[id];
}

/**
 * Meter discipline: `f` may spend on move `m` now. A move without a meterCost always; a costed move
 * only when affordable (state-machine.js canAfford) and not within one cost of a full meter, which is
 * saved for Overwind (the one exception is a full meter itself, which Overwind spends elsewhere).
 * @example spendable(f, f.moves.specialBack) // false at meter 85 with meterCost 20 and meterMax 100
 */
export function spendable(f, m) {
  if (m.meterCost === undefined || m.meterCost === 0) return true;
  return canAfford(f, m) && f.meter + m.meterCost < f.meterMax;
}

/**
 * Reach of `attacker`'s move-input `key` against a target of body radius `targetR`
 * (-Infinity when the kit lacks the move).
 */
function keyReach(attacker, key, targetR) {
  const m = keyMove(attacker, key);
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
 * Frame advantage of move `m` after contact, from public frame data: the defender's stun minus the
 * attacker's remaining active and recovery ticks (first-active-frame contact).
 * @example frameAdvantage(kit.moves.light, true) // e.g. -3: the blocker acts 3 ticks before the attacker
 * @param {import('../sim/moves.js').MoveData} m
 * @param {boolean} blocked blockstun (true) or hitstun (false)
 */
export function frameAdvantage(m, blocked) {
  return (blocked ? m.blockstun : m.hitstun) - (m.active - 1) - m.recovery;
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
   *   cpu.sample(snapshot, sim.fighters[1], sim.fighters[0], sim.hazards); // then stepDuel(...)
   * @param {object} opts
   * @param {Readonly<Record<string, number>>} opts.difficulty a level (buildDifficulty / buildDifficultySet)
   * @param {Readonly<Record<string, number>>} opts.behaviour shared tuning (buildBehaviour)
   * @param {number} [opts.seed] RNG seed; same seed + same inputs = same decisions
   * @param {Readonly<Record<string, number>>} opts.rules sim rules, ruleset.rules (hurtbox radius, Overwind threshold)
   * @param {Readonly<Record<string, ReturnType<typeof import('./personalities.js').buildPersonality>>>} [opts.personalities]
   *   personalityId -> personality (buildPersonalities); default none
   * @param {string|null} [opts.personalityId] a key of `personalities` layered on `difficulty` and
   *   `behaviour` (story-011); null = none. Unknown ids throw.
   * @param {ReturnType<typeof import('./personalities.js').buildMatchups>} [opts.matchups] selfKitId ->
   *   oppKitId -> plan (buildMatchups), layered on top once the pilot sees which kits (`spec.id`) are in
   *   the ring; default none
   * @param {((frame:number, reason:string, key:string|null) => void) | null} [opts.onDecision] debug hook,
   *   called on every fresh neutral plan pick and whenever the reason (or its key) changes
   */
  constructor({
    difficulty, behaviour, seed = 1, rules, personalities = NO_TABLE, personalityId = null, matchups = NO_TABLE,
    onDecision = null,
  }) {
    if (personalityId !== null && !Object.hasOwn(personalities, personalityId)) {
      throw new Error(`CpuPilot: unknown personalityId ${personalityId}`);
    }
    /** Personality layered on the level (null = none); read by the arcade ladder and debug UI. */
    this.personalityId = personalityId;
    this.personality = personalityId === null ? null : personalities[personalityId];
    this.level = difficulty;
    this.shared = behaviour;
    const tuned = applyPersonality(this.personality, difficulty, behaviour);
    /** Level and behaviour in force: level -> kit range preference -> personality -> matchup (re-tuned per kit pair). */
    this.difficulty = tuned.difficulty;
    this.behaviour = tuned.behaviour;
    this.matchups = matchups;
    /** Debug readout: id of the matchup plan in force (`<self>_vs_<opp>`), else null. */
    this.matchupId = null;
    this.selfSpec = NO_TABLE; // sentinel: re-tune on the first sample
    this.oppSpec = NO_TABLE;
    /** Move-input key of the kit's `antiAir` move, or null (found at re-tune). */
    this.antiAirKey = null;
    this.rules = rules;
    this.rng = new SeededRng(seed);
    this.onDecision = onDecision;
    this.view = new DelayedView(difficulty.reactionFrames);
    this.me = createObservation();
    /** Perceived stage hazards (perception.js observeHazards), slot i = sim.hazards[i]. */
    this.hazards = [];
    for (let i = 0; i < MAX_HAZARDS; i++) this.hazards.push(createHazardObservation());
    this.hazardCount = 0;
    /** Per hazard: the telegraph cycle last rolled and whether that roll said "evade". */
    this.hazardCycle = new Int32Array(MAX_HAZARDS);
    this.hazardGo = new Uint8Array(MAX_HAZARDS);
    this.weights = new Float64Array(PLANS.length);
    /** Scratch: special keys that fit this decision (allocation-free). */
    this.fits = new Array(SPECIAL_KEYS.length).fill(null);
    /** Debug readout: why this tick's input was produced (a REASON or a PLAN). */
    this.reason = PLAN.WAIT;
    /** Debug readout: the poke key behind a POKE reason, else null. */
    this.reasonKey = null;
    /** Key of the link being pressed (for the debug readout). */
    this.reasonKeyLink = null;
    this.reset();
  }

  /** Forget the opponent's history and the current plan (call on a round reset). */
  reset() {
    this.view.reset();
    this.hazardCount = 0;
    this.hazardCycle.fill(0);
    this.hazardGo.fill(0);
    this.frame = 0;
    this.serial = 0;
    this.prevState = STATE.IDLE;
    this.prevStateFrame = 0;
    this.prevGrounded = true;
    this.jumpSerial = 0;
    this.airSerial = -1;
    this.airGo = false;
    this.defendSerial = -1;
    this.defence = DEFENCE_NONE;
    this.evadeSent = false;
    this.counterKey = null;
    this.punishSerial = -1;
    this.punishGo = false;
    this.superGo = false;
    this.stepSerial = -1;
    this.stepGo = false;
    this.grabAge = 0;
    this.techsSeen = 0;
    this.ventSerial = -1;
    this.wasBlockstun = false;
    this.wasAttack = false;
    this.myPrevFrame = 0;
    this.ownHit = false;
    this.ownMove = null;
    this.ownContact = 0;
    this.ownStun = 0;
    this.linkGo = false;
    this.linkLeft = 0;
    this.stringGo = false;
    this.guardLeft = 0;
    this.respectBack = false;
    this.fresh = false;
    this.specialKey = 'specialForward';
    this.plan = PLAN.WAIT;
    this.planLeft = 0;
    this.planTick = 0;
    this.planDone = false;
    this.pokeKey = 'light';
    this.sideDir = 1;
    this.lastDist = Infinity;
  }

  /**
   * Fill `out` for one sim tick. Reads `self`, `opp` and `hazards` only (never writes them).
   * @param {ReturnType<typeof import('../input/input-snapshot.js').createSnapshot>} out
   * @param {Readonly<Record<string, any>>} self the fighter this CPU drives
   * @param {Readonly<Record<string, any>>} opp the other fighter
   * @param {ReadonlyArray<Readonly<Record<string, any>>>|null} [hazards] sim.hazards (stage hazards the
   *   CPU may see, reactionFrames late); null = none
   */
  sample(out, self, opp, hazards = null) {
    if ((self.spec ?? null) !== this.selfSpec || (opp.spec ?? null) !== this.oppSpec) this.#retune(self, opp);
    const d = this.difficulty;
    const me = observe(this.me, self, this.frame);
    const them = this.view.push(opp);
    this.hazardCount = hazards === null ? 0 : observeHazards(this.hazards, hazards, d.reactionFrames);
    // Own state is known instantly: the first free tick after own blockstun / own attack.
    const leftBlockstun = this.wasBlockstun && me.state !== STATE.BLOCKSTUN;
    this.wasBlockstun = me.state === STATE.BLOCKSTUN;
    const attacking = me.state === STATE.ATTACK;
    const leftAttack = this.wasAttack && !attacking;
    if (leftAttack && me.state === STATE.TECH) this.techsSeen++; // own throw broken: the opponent techs
    if (attacking && (!this.wasAttack || me.stateFrame < this.myPrevFrame)) {
      // A new own attack (or the next hit of a string): one string roll, only for a move that chains.
      this.ownHit = false;
      this.linkGo = false;
      this.stringGo = me.move.cancel !== undefined && this.rng.chance(d.stringConfirmChance);
    }
    if (attacking && me.attackHasHit) {
      if (!this.ownHit) {
        // First tick after contact: the hit's frame, tier and stun are public (own move data + the call).
        this.ownContact = me.stateFrame;
        this.ownStun = me.move.hitstun + this.#stunBonus(me.hitCounter);
        this.linkGo = me.hitCounter !== 0 && this.rng.chance(d.linkChance);
      }
      this.ownHit = true;
      this.ownMove = me.move;
    }
    this.wasAttack = attacking;
    this.myPrevFrame = me.stateFrame;
    this.frame++;
    if (them.state === STATE.ATTACK
      && (this.prevState !== STATE.ATTACK || them.stateFrame < this.prevStateFrame)) this.serial++;
    this.prevState = them.state;
    this.prevStateFrame = them.stateFrame;
    if (!them.grounded && this.prevGrounded) this.jumpSerial++;
    this.prevGrounded = them.grounded;
    clearSnapshot(out);

    if (me.state === STATE.KO || them.state === STATE.KO) return this.#say(REASON.KO, out);
    if (me.state === STATE.THROWN) {
      this.planLeft = 0;
      this.guardLeft = 0;
      this.grabAge++;
      if (this.grabAge === d.reactionFrames + 1 && this.#wantsTech(them)) {
        out.throw = true;
        return this.#say(REASON.TECH, out);
      }
      return this.#say(REASON.STUNNED, out);
    }
    this.grabAge = 0;
    if (me.state === STATE.HITSTUN || me.state === STATE.TECH) {
      this.planLeft = 0;
      this.guardLeft = 0;
      return this.#say(REASON.STUNNED, out);
    }

    const myR = bodyRadiusOf(self, this.rules); // what the opponent's moves must reach
    const theirR = bodyRadiusOf(opp, this.rules); // what this CPU's moves must reach
    const dx = them.x - me.x;
    const dz = them.z - me.z;
    const dist = Math.hypot(dx, dz);
    // The gap is closing (someone stepped in since last tick): what a tip poke is for.
    const closing = dist < this.lastDist - 1e-4;
    this.lastDist = dist;

    // 1a. Step out of a stage hazard zone the CPU can see (story-013).
    if (this.hazardCount > 0 && this.#hazardEscape(out, me, them, self, myR)) return this.#say(REASON.HAZARD, out);

    // 1b. Overwind reversal after a blocked attack that leaves an Overwind-sized window.
    if (leftBlockstun && overwindReady(self) && this.#wantsReversal(self, them, dist, theirR)) {
      pressMove(out, 'overwind');
      this.planLeft = 0;
      return this.#say(REASON.PUNISH, out, 'overwind');
    }

    // 1b2. Vent: pressure this CPU cannot punish, answered with space.
    if (me.state === STATE.BLOCKSTUN && this.#wantsVent(self, me, them, dist, theirR)) {
      out.throw = true;
      out.guard = true;
      out.stick.y = me.crouching ? -1 : 0; // keep the stance the block was made in
      this.planLeft = 0;
      return this.#say(REASON.VENT, out);
    }

    // 1c. Light string on a hit confirm: the next hit of a `cancel` string inside its window.
    if (attacking) {
      const c = me.move.cancel;
      if (c !== undefined && this.stringGo && (me.attackHasHit || !c.requiresContact)) {
        const n = me.stateFrame + 1; // the frame the chained move would start on (state-machine.js chainMoveId)
        if (n >= c.from && n <= c.to) {
          out.light = true;
          this.planLeft = 0;
          return this.#say(REASON.STRING, out, c.into);
        }
      }
    }

    // 1c2. Link out of an own counter or punish hit.
    if (this.linkGo && this.#linkStep(out, me, them, self, attacking, dist, theirR)) return this.#say(REASON.LINK, out, this.reasonKeyLink);

    // 1d. First free tick after an own attack that connected: read the frame data.
    if (leftAttack && this.ownHit) this.#afterContact(me, them, self, opp, dist, myR, theirR);
    if (this.guardLeft > 0) {
      this.guardLeft--;
      // Minus frames: guard, or (respectBack, rolled with the window) step back out of the opponent's throw
      // range, since a guard inside it is a throw for them. The guess between the two is the real one.
      if (this.respectBack && CAN_SIDESTEP[me.state] === true) out.stick.x = -1;
      else {
        out.guard = true;
        out.stick.y = them.state === STATE.ATTACK && them.move.level === 'low' ? -1 : 0;
      }
      return this.#say(REASON.RESPECT, out, this.respectBack ? 'back' : null);
    }

    // 2. Reactive defence against an attack the CPU can already see.
    if (them.state === STATE.ATTACK && !them.attackHasHit
      && (them.phase === PHASE.STARTUP || them.phase === PHASE.ACTIVE)
      && dist <= moveReach(them.move, myR) + this.behaviour.threatMargin) {
      const r = this.#defend(out, me, them, self, dist, myR, theirR);
      if (r !== null) return r;
    }

    // 2b. Anti-air: the kit's `antiAir` move against an airborne opponent in reach.
    if (!them.grounded && this.antiAirKey !== null) {
      if (this.airSerial !== this.jumpSerial) {
        this.airSerial = this.jumpSerial;
        this.airGo = this.rng.chance(d.antiAirChance);
      }
      if (this.airGo && CAN_SIDESTEP[me.state] === true && me.state !== STATE.SIDESTEP
        && dist <= keyReach(self, this.antiAirKey, theirR) - this.behaviour.reachMargin) {
        this.#press(out, this.antiAirKey, me);
        this.planLeft = 0;
        return this.#say(REASON.ANTI_AIR, out, this.antiAirKey);
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
        this.punishGo = this.rng.chance(d.whiffPunishChance);
        // Overwind is a punish only (never raw in neutral); rolled once per attack, and only with a
        // full meter so the RNG stream is unchanged while the meter fills. A full meter also makes the
        // CPU look for the punish it would spend it on (the super roll stands in for the whiff roll).
        this.superGo = overwindReady(self) && this.#wantsSuper(self);
        if (this.superGo) this.punishGo = true;
      }
      // Ticks until the opponent can act, extrapolated from what the CPU saw reactionFrames ago.
      const left = moveTotal(them.move) - them.stateFrame - d.reactionFrames;
      if (me.state === STATE.SIDESTEP) {
        // A step that made the attack miss: attack out of it once the cut opens, or let it run out.
        if (this.stepSerial !== this.serial && sidestepCancellable(self)) {
          this.stepSerial = this.serial;
          this.stepGo = !them.attackHasHit && this.rng.chance(d.stepPunishChance);
        }
        if (this.stepGo && left > 0) {
          const key = this.#pickPunish(self, dist, left, theirR, me.crouching);
          if (key !== null && CROUCH_KEYS[key] !== true) {
            pressMove(out, key);
            this.stepGo = false;
            this.punishGo = false;
            this.planLeft = 0;
            return this.#say(REASON.PUNISH, out, key);
          }
        }
      } else if (this.punishGo && left > 0) {
        const key = this.#pickPunish(self, dist, left, theirR, me.crouching);
        if (key !== null) {
          if (this.#press(out, key, me)) this.punishGo = false;
          this.planLeft = 0;
          return this.#say(REASON.PUNISH, out, key);
        }
        const closeR = this.#punishCloseReach(self, left, theirR, me.crouching);
        if (closeR > 0 && dist > closeR) {
          out.stick.x = 1; // close the gap, then punish next tick
          this.planLeft = 0;
          return this.#say(REASON.PUNISH, out);
        }
      }
    }

    // 4b. Inside a sidestep nothing neutral acts: the step is what was chosen. Past the cut a press would
    // cancel it, and only the step punish above means to. The next free tick re-plans.
    if (me.state === STATE.SIDESTEP) {
      this.planLeft = 0;
      return out;
    }

    // 5. Neutral.
    if (this.planLeft <= 0) this.#choosePlan(me, them, self, opp, dist, myR, theirR, closing);
    this.#runPlan(out, me, them, self, dist, theirR);
    this.planLeft--;
    this.planTick++;
    const key = this.plan === PLAN.POKE ? this.pokeKey : this.plan === PLAN.SPECIAL ? this.specialKey : null;
    return this.#say(this.plan, out, key);
  }

  /**
   * The kits in the ring changed (first sample, or a kit swap): rebuild the tables in force. Order:
   * the level and shared behaviour; the own kit's range preference (`spec.ai.rangeBias`, the kit's
   * identity: a reach kit lives at its tip, a bruiser up close; validated by the game's kit loader);
   * the personality (rescales it); the matchup plan for `self.spec.id` vs `opp.spec.id` (if the table
   * has one), weighted by the level's matchupSkill. Also finds the kit's `antiAir` move. The one
   * allocation of a match.
   */
  #retune(self, opp) {
    this.selfSpec = self.spec ?? null;
    this.oppSpec = opp.spec ?? null;
    const bias = this.selfSpec?.ai?.rangeBias;
    const shared = bias === undefined ? this.shared : buildBehaviour({ ...this.shared, rangeBias: bias }, 'kit ai');
    const base = applyPersonality(this.personality, this.level, shared);
    const row = this.selfSpec !== null && Object.hasOwn(this.matchups, this.selfSpec.id) ? this.matchups[this.selfSpec.id] : null;
    const m = row !== null && this.oppSpec !== null && Object.hasOwn(row, this.oppSpec.id) ? row[this.oppSpec.id] : null;
    const t = applyPersonality(m, base.difficulty, base.behaviour, base.difficulty.matchupSkill);
    this.difficulty = t.difficulty;
    this.behaviour = t.behaviour;
    this.matchupId = m === null ? null : m.id;
    this.antiAirKey = null;
    for (const key in self.moveInputs) {
      const mv = keyMove(self, key);
      if (mv !== undefined && mv.aiRole === AI_ROLE.ANTI_AIR) this.antiAirKey = key;
    }
  }

  /**
   * Press move-input `key`: a crouching move first holds the stick down (the fighter must already be
   * crouching on the press tick), everything else presses now. Returns true when the button went out.
   */
  #press(out, key, me) {
    if (CROUCH_KEYS[key] === true && !me.crouching) {
      out.stick.y = -1;
      return false;
    }
    pressMove(out, key);
    return true;
  }

  /**
   * One tech roll for the grab holding this CPU, made once the reaction delay has passed. It reads the
   * grabber's move from the delayed view (public frame data: `techable: false` is a command grab, and no roll
   * is spent on it) and never the grabber's input buffer.
   */
  #wantsTech(them) {
    const m = them.move;
    if (m === null || m.level !== 'throw' || m.techable === false) return false;
    return this.rng.chance(this.difficulty.throwTechChance);
  }

  /**
   * Plan for a throw on a guarding opponent: the plain throw, unless a throw of this CPU was teched this round
   * and the kit has a throw special no tech breaks, spendable and in reach (a command grab beats a teching
   * opponent). Found by the move's data, never its name.
   */
  #throwPlan(self, dist, targetR) {
    if (this.techsSeen === 0) return PLAN.THROW;
    for (const key of SPECIAL_KEYS) {
      const m = keyMove(self, key);
      if (m === undefined || m.level !== 'throw' || m.techable !== false || !spendable(self, m)) continue;
      if (dist > moveReach(m, targetR) - this.behaviour.reachMargin) continue;
      this.specialKey = key;
      return PLAN.SPECIAL;
    }
    return PLAN.THROW;
  }

  /**
   * One Vent decision per attack that has this CPU in blockstun, once the delayed view shows the attack and with
   * the meter for it (self.ventCost is public, like meterMax). Never against a move it could punish instead: from
   * public frame data the attacker's recovery past the blockstun leaves `-advantage` ticks, and a key that lands
   * inside them is the answer, not a Vent. Meter discipline: within one cost of a full meter the meter is saved
   * when the CPU wants the Overwind. Reads no buffer and no hidden counter.
   */
  #wantsVent(self, me, them, dist, targetR) {
    if (self.meter < self.ventCost || them.state !== STATE.ATTACK || them.move.level === 'throw') return false;
    if (this.ventSerial === this.serial) return false;
    this.ventSerial = this.serial;
    const left = -frameAdvantage(them.move, true);
    if (this.#pickPunish(self, dist, left, targetR, me.crouching) !== null) return false;
    if (self.meter + self.ventCost >= self.meterMax && this.#wantsSuper(self)) return false;
    return this.rng.chance(this.difficulty.ventChance);
  }

  /** Hitstun a contact of counter tier `tier` adds, from the public rules. */
  #stunBonus(tier) {
    const r = this.rules;
    return tier === 1 ? r.counterHitstunBonus : tier === 2 ? r.punishHitstunBonus : 0;
  }

  /**
   * Link step. Waits for the first tick the sim can start the next move (the last tick of the own attack:
   * decideFighter frees the fighter and reads the buffer in that same tick), then presses the best move
   * that lands inside the defender's remaining stun. That stun is public frame data: the own move's
   * hitstun, the tier's bonus, minus the ticks since the contact (never the defender's hidden counter).
   * The delayed view must already show the hitstun, so nothing is known before a player could see it.
   * Writes `out` and returns true while it acts; a link that does not fit ends the roll.
   */
  #linkStep(out, me, them, self, attacking, dist, theirR) {
    if (attacking) {
      if (me.stateFrame < moveTotal(me.move)) return false;
      this.linkLeft = this.ownStun - (me.stateFrame - this.ownContact);
    } else this.linkLeft--;
    const key = them.state === STATE.HITSTUN && this.linkLeft > 0
      ? this.#pickLink(self, dist + them.pushLeft, this.linkLeft, theirR, me.crouching) : null;
    if (key === null) {
      this.linkGo = false;
      return false;
    }
    if (this.#press(out, key, me)) this.linkGo = false;
    this.planLeft = 0;
    this.reasonKeyLink = key;
    return true;
  }

  /**
   * Most damaging strike that links: its lead fits the remaining stun `left` (`startup + 1 <= left`, one
   * more for a crouch it still has to make) and it reaches `dist`. Throws whiff on hitstun and Overwind is
   * a punish decision of its own, so neither links; meter discipline applies as to any punish. null when
   * nothing fits.
   */
  #pickLink(self, dist, left, targetR, crouching) {
    const margin = this.behaviour.reachMargin;
    let best = null;
    let bestDmg = -1;
    for (const key of PUNISH_KEYS) {
      if (key === 'overwind') continue;
      const m = keyMove(self, key);
      if (m === undefined || m.level === 'throw' || !this.#punishAllowed(self, key)) continue;
      if (this.#lead(key, m, crouching) > left || dist > moveReach(m, targetR) - margin) continue;
      if (m.damage > bestDmg) {
        best = key;
        bestDmg = m.damage;
      }
    }
    return best;
  }

  /**
   * Frame-data read on the first free tick after an own attack connected. What the delayed view shows
   * decides (a Light's short recovery ends before the view shows the result: nothing is assumed):
   *   BLOCKSTUN seen, minus frames  -> hold guard for the disadvantage plus the reaction delay
   *                                    (disadvantageRespect); the opponent is free before this CPU is
   *   HITSTUN / THROWN seen, or plus on block -> press (pressureChance): throw a blocker in throw range,
   *                                    jab in Light range, else close in
   */
  #afterContact(me, them, self, opp, dist, myR, theirR) {
    const d = this.difficulty;
    const b = this.behaviour;
    const m = this.ownMove;
    const blocked = them.state === STATE.BLOCKSTUN;
    if (!blocked && them.state !== STATE.HITSTUN && them.state !== STATE.THROWN) return;
    // The contact's real advantage: its actual frame and, on a hit, the tier's stun bonus.
    const adv = (blocked ? m.blockstun : this.ownStun) - (moveTotal(m) - this.ownContact);
    if (blocked && adv < 0) {
      if (this.rng.chance(d.disadvantageRespect)) {
        this.guardLeft = d.reactionFrames - adv;
        // Inside the opponent's (public) throw reach a guard is a throw for them: step back instead, retreatChance.
        this.respectBack = dist <= keyReach(opp, 'throw', myR) + b.threatMargin && this.rng.chance(d.retreatChance);
      }
      return;
    }
    if (!this.rng.chance(d.pressureChance)) return;
    let plan = PLAN.APPROACH;
    if (blocked && dist <= keyReach(self, 'throw', theirR) - b.reachMargin) plan = PLAN.THROW;
    else if (dist <= keyReach(self, 'light', theirR) - b.reachMargin) {
      plan = PLAN.POKE;
      this.pokeKey = this.#pickPoke(self, dist, theirR, them, this.rng.next() * (1 - b.heavyPokeShare) + b.heavyPokeShare);
    }
    this.#setPlan(plan, d.decisionFrames);
  }

  /**
   * Defence against a visible incoming attack, one roll per attack (serial). A strike: an armoured
   * own move that absorbs it (counterChance), block (blockChance), sidestep (sidestepChance), or, near
   * its tip, walk back out of it (retreatChance). A throw: jump over it (jumpChance; the sim never
   * throws an airborne fighter). Returns the filled snapshot, or null when the roll said "nothing".
   */
  #defend(out, me, them, self, dist, myR, theirR) {
    const d = this.difficulty;
    const rng = this.rng;
    const isThrow = them.move.level === 'throw';
    if (this.defendSerial !== this.serial) {
      this.defendSerial = this.serial;
      this.evadeSent = false;
      this.counterKey = isThrow ? null : this.#pickCounter(self, them, dist, theirR);
      if (isThrow) this.defence = rng.chance(d.jumpChance) ? DEFENCE_JUMP : DEFENCE_NONE;
      else if (this.counterKey !== null && rng.chance(d.counterChance)) this.defence = DEFENCE_COUNTER;
      else if (rng.chance(d.blockChance)) this.defence = DEFENCE_BLOCK;
      else if (rng.chance(d.sidestepChance)) this.defence = DEFENCE_EVADE;
      else if (dist >= moveReach(them.move, myR) - this.behaviour.threatMargin && rng.chance(d.retreatChance)) this.defence = DEFENCE_RETREAT;
      else this.defence = DEFENCE_NONE;
    }
    const free = CAN_SIDESTEP[me.state] === true;
    switch (this.defence) {
      case DEFENCE_BLOCK:
        // A step the CPU chose runs out (only the step punish leaves it early); guard is held from the next free tick.
        out.guard = me.state !== STATE.SIDESTEP;
        out.stick.y = them.move.level === 'low' ? -1 : 0;
        this.planLeft = 0;
        return this.#say(REASON.BLOCK, out);
      case DEFENCE_EVADE:
        if (!this.evadeSent && free) {
          out.sidestep = rng.chance(0.5) ? 1 : -1;
          this.evadeSent = true;
        }
        this.planLeft = 0;
        return this.#say(REASON.EVADE, out, 'sidestep');
      case DEFENCE_JUMP:
        if (!this.evadeSent && free && me.grounded) {
          out.stick.y = 1;
          this.evadeSent = true;
        }
        this.planLeft = 0;
        return this.#say(REASON.EVADE, out, 'jump');
      case DEFENCE_RETREAT:
        if (free) out.stick.x = -1;
        this.planLeft = 0;
        return this.#say(REASON.RETREAT, out);
      case DEFENCE_COUNTER:
        // Only the step punish (step 4) attacks out of a sidestep: the armour window was timed from a free stance.
        if (free && me.state !== STATE.SIDESTEP && this.#press(out, this.counterKey, me)) this.defence = DEFENCE_NONE;
        this.planLeft = 0;
        return this.#say(REASON.COUNTER, out, this.counterKey);
      default:
        return null;
    }
  }

  /**
   * Own move (COUNTER_KEYS) whose armour answers the incoming strike: affordable, in reach, its armour
   * covers the strike's level and the tick the strike arrives (extrapolated from the delayed view and
   * public frame data), and it recovers to hit before the opponent can act. Most damaging wins; null
   * when none fits. The move's `armor` data is the only thing that makes it a counter.
   */
  #pickCounter(self, them, dist, targetR) {
    const d = this.difficulty;
    const arrive = them.move.startup + 1 - (them.stateFrame + d.reactionFrames);
    const oppFree = moveTotal(them.move) - them.stateFrame - d.reactionFrames;
    let best = null;
    let bestDmg = -1;
    for (const key of COUNTER_KEYS) {
      const m = keyMove(self, key);
      if (m === undefined || m.armor === undefined || !spendable(self, m) || m.damage <= bestDmg) continue;
      const a = m.armor;
      const lead = CROUCH_KEYS[key] === true ? 1 : 0;
      if (arrive - lead < a.from || arrive - lead > a.to || !a.levels.includes(them.move.level)) continue;
      if (m.startup + 1 + lead >= oppFree || dist > moveReach(m, targetR) - this.behaviour.reachMargin) continue;
      best = key;
      bestDmg = m.damage;
    }
    return best;
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
    const m = keyMove(self, 'overwind');
    if (m === undefined) return false;
    const left = moveTotal(them.move) - them.stateFrame - d.reactionFrames;
    if (m.startup + 1 >= left || dist > moveReach(m, targetR) - this.behaviour.reachMargin) return false;
    return comeback || this.rng.chance(d.superBlockPunishChance);
  }

  /**
   * True when punish key `key` may be used now: Overwind only with a full meter and a won roll, any
   * move only when its meterCost (moves.js) is spendable (meter discipline), and never a move that
   * travels backward.
   */
  #punishAllowed(self, key) {
    if (key === 'overwind') return this.superGo && overwindReady(self);
    const m = keyMove(self, key);
    return m === undefined || (spendable(self, m) && !(m.travel !== undefined && m.travel.distance < 0));
  }

  /**
   * Whether the CPU acts on hazard slot `i` this telegraph cycle: one hazardEvadeChance roll per
   * cycle (so levels that ignore some vents keep ignoring the same one). No roll without a hazard.
   */
  #hazardWanted(i, o) {
    if (this.hazardCycle[i] !== o.cycle) {
      this.hazardCycle[i] = o.cycle;
      this.hazardGo[i] = this.rng.chance(this.difficulty.hazardEvadeChance) ? 1 : 0;
    }
    return this.hazardGo[i] === 1;
  }

  /**
   * Standing in a visible hazard zone the roll says to leave, and free to move: walk out by the
   * nearer lane exit (body radius + reachMargin clear of the zone), the other one if that exit
   * would leave the ring. Writes the stick toward/away from the opponent as the lane direction
   * requires; false when there is nothing to escape (or the CPU is attacking / stunned).
   */
  #hazardEscape(out, me, them, self, myR) {
    if (CAN_SIDESTEP[me.state] !== true && me.state !== STATE.GUARD) return false;
    const margin = myR + this.behaviour.reachMargin;
    const edge = self.movement.ringRadius - this.behaviour.ringEdgeMargin;
    for (let i = 0; i < this.hazardCount; i++) {
      const o = this.hazards[i];
      if (!o.visible || me.x + margin < o.x0 || me.x - margin > o.x1) continue;
      if (!this.#hazardWanted(i, o)) continue;
      const toLeft = me.x + margin - o.x0; // walk -x this far
      const toRight = o.x1 - (me.x - margin); // walk +x this far
      let dir = toLeft <= toRight ? -1 : 1;
      if (Math.abs(me.x + dir * (dir < 0 ? toLeft : toRight)) > edge) dir = -dir;
      out.stick.x = them.x >= me.x ? dir : -dir; // stick +x = toward the opponent
      out.stick.y = 0;
      out.guard = false;
      this.planLeft = 0;
      return true;
    }
    return false;
  }

  /**
   * True when walking in world direction `worldDir` (+-1 along the lane) would enter a visible
   * hazard zone the roll says to respect, within a body radius plus threatMargin of look-ahead.
   */
  #hazardAhead(me, worldDir, myR) {
    const near = me.x + worldDir * myR;
    const far = near + worldDir * (myR + this.behaviour.threatMargin);
    const lo = near < far ? near : far;
    const hi = near < far ? far : near;
    for (let i = 0; i < this.hazardCount; i++) {
      const o = this.hazards[i];
      if (o.visible && hi >= o.x0 && lo <= o.x1 && this.#hazardWanted(i, o)) return true;
    }
    return false;
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
   * Ticks a punish key needs before its first active tick: startup + 1, plus the crouch tick of a
   * crouching move while the CPU is not crouching yet (so a pick at the edge of the window still fits
   * on its second tick).
   */
  #lead(key, m, crouching) {
    return m.startup + (CROUCH_KEYS[key] === true && !crouching ? 2 : 1);
  }

  /**
   * Distance to close before punishing: the longest reach (minus reachMargin) over the punish
   * moves that still start up in time (`startup + 1 < left`). <= 0 when none does.
   */
  #punishCloseReach(self, left, targetR, crouching) {
    let best = -Infinity;
    for (const key of PUNISH_KEYS) {
      if (!this.#punishAllowed(self, key)) continue;
      const m = keyMove(self, key);
      if (m === undefined || this.#lead(key, m, crouching) >= left) continue;
      const r = moveReach(m, targetR) - this.behaviour.reachMargin;
      if (r > best) best = r;
    }
    return best;
  }

  /**
   * Punish key (story-009 §9.2): over PUNISH_KEYS filtered by `startup + 1 < left` (one more tick for a
   * crouching move the CPU still has to crouch for) and reach (including travel), Overwind when it qualifies and was chosen for this
   * attack, else the most damaging (ties keep PUNISH_KEYS order). null when nothing fits.
   */
  #pickPunish(self, dist, left, targetR, crouching) {
    const margin = this.behaviour.reachMargin;
    let best = null;
    let bestDmg = -1;
    for (const key of PUNISH_KEYS) {
      if (!this.#punishAllowed(self, key)) continue;
      const m = keyMove(self, key);
      if (m === undefined || this.#lead(key, m, crouching) >= left || dist > moveReach(m, targetR) - margin) continue;
      if (key === 'overwind') return key;
      if (m.damage > bestDmg) {
        best = key;
        bestDmg = m.damage;
      }
    }
    return best;
  }

  /** Start neutral plan `plan` for `frames` ticks (a new pick is logged even when it repeats the last plan). */
  #setPlan(plan, frames) {
    this.plan = plan;
    this.fresh = true;
    this.planTick = 0;
    this.planDone = false;
    this.planLeft = frames;
  }

  #choosePlan(me, them, self, opp, dist, myR, theirR, closing) {
    const d = this.difficulty;
    const b = this.behaviour;
    const rng = this.rng;
    const pokeR = bestPokeReach(self, b.pokeKeys, theirR) - b.reachMargin;
    const throwR = keyReach(self, 'throw', theirR) - b.reachMargin;
    const lightR = keyReach(self, 'light', theirR) - b.reachMargin;
    // Close range: Lights and throws reach. Preferred range sits rangeBias of the way to the longest poke.
    const closeR = lightR > throwR ? lightR : throwR;
    const pref = closeR + (pokeR > closeR ? (pokeR - closeR) * b.rangeBias : 0);
    // The opponent's kit is public knowledge (the character select shows it): its best poke.
    const oppR = bestPokeReach(opp, b.pokeKeys, myR) + b.threatMargin;
    const guarding = them.state === STATE.GUARD || them.state === STATE.BLOCKSTUN;
    const agg = d.aggression;

    let plan;
    if (rng.chance(d.mistakeRate)) {
      plan = PLANS[rng.int(PLANS.length)];
    } else if (guarding && dist <= throwR && rng.chance(d.throwChance)) {
      plan = this.#throwPlan(self, dist, theirR);
    } else {
      const w = this.weights;
      const inOppRange = dist <= oppR;
      w[0] = b.waitWeight * (1 - agg); // WAIT
      w[1] = dist > (guarding ? throwR : pref + b.rangeBand) ? agg : 0; // APPROACH (to throw range vs a guard)
      w[2] = inOppRange || dist < pref - b.rangeBand ? b.backOffWeight * (1 - agg) : 0; // BACK_OFF
      // POKE: into a guard only to open it (low / mid); beyond Light range the tip poke competes with walking
      // in, the more so the closer the kit's preferred range is (rangeBias 1 = a tip fighter pokes from the
      // tip), and a tip fighter pokes when someone steps in, waiting otherwise (tipPatience).
      const tip = (b.heavyPokeShare + (1 - b.heavyPokeShare) * b.rangeBias) * (closing ? 1 : b.tipPatience);
      w[3] = dist <= pokeR ? agg * (guarding ? 0.4 : 1) * (dist <= closeR ? 1 : tip) : 0;
      w[4] = inOppRange ? b.guardWeight * d.blockChance : 0; // GUARD (pre-emptive; scales with the level's block skill)
      w[5] = b.sidestepWeight * d.sidestepChance; // SIDESTEP
      w[6] = 0; // THROW only via the throwChance roll above
      w[7] = b.jumpWeight; // JUMP
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
      const n = plan === PLAN.APPROACH || plan === PLAN.POKE ? this.#fitSpecials(me, them, self, dist, pokeR, oppR, theirR) : 0;
      if (n > 0 && rng.chance(d.specialShare)) {
        plan = PLAN.SPECIAL;
        this.specialKey = this.fits[n === 1 ? 0 : rng.int(n)];
      }
    }

    if (plan === PLAN.POKE) {
      this.pokeKey = this.#pickPoke(self, dist, theirR, them, rng.next());
    } else if (plan === PLAN.SIDESTEP) {
      this.sideDir = rng.chance(0.5) ? 1 : -1;
    }
    this.#setPlan(plan, d.decisionFrames + rng.int(b.planJitterFrames));
  }

  /**
   * Fill `this.fits` with the special keys whose move's aiRole fits the (delayed) view this tick,
   * whose meterCost (if any) the CPU can pay and is willing to (spendable: not within one cost of a
   * full meter, saved for Overwind), and which reach `dist` (minus reachMargin); returns how many.
   * Never branches on character.
   *   gapClose     pokeR < dist <= its reach, and the opponent is open: whiffing / recovering, or neither
   *                attacking nor standing in guard (a charge into a guard is a punish for the guard)
   *   lowPoke      in reach and the opponent stands guarding, is in the startup of an armoured move, or is
   *                beyond this CPU's Light reach (a low tip poke; it breaks armour and standing guard)
   *   antiStep     in reach and the opponent is sidestepping
   *   retreatPoke  in reach and dist <= oppR (inside the opponent's threat range), or this CPU is cornered
   *   antiAir      never in neutral (reactive, step 2b)
   */
  #fitSpecials(me, them, self, dist, pokeR, oppR, targetR) {
    let n = 0;
    const attacking = them.state === STATE.ATTACK;
    for (const key of SPECIAL_KEYS) {
      const m = keyMove(self, key);
      if (m === undefined || m.aiRole === undefined || !spendable(self, m)) continue;
      if (dist > moveReach(m, targetR) - this.behaviour.reachMargin) continue;
      let fits = false;
      switch (m.aiRole) {
        case AI_ROLE.GAP_CLOSE:
          // Far, and the opponent is open: whiffing / recovering, or not attacking and not standing in guard.
          fits = dist > pokeR && them.state !== STATE.GUARD && (!attacking || them.phase === PHASE.RECOVERY);
          break;
        case AI_ROLE.LOW_POKE:
          fits = (them.state === STATE.GUARD && !them.crouching)
            || (attacking && them.phase === PHASE.STARTUP && them.move.armor !== undefined)
            || dist > keyReach(self, 'light', targetR) - this.behaviour.reachMargin;
          break;
        case AI_ROLE.ANTI_STEP: fits = them.state === STATE.SIDESTEP; break;
        case AI_ROLE.RETREAT_POKE:
          fits = dist <= oppR || Math.hypot(me.x, me.z) > self.movement.ringRadius - this.behaviour.ringEdgeMargin;
          break;
        default: break;
      }
      if (fits) this.fits[n++] = key;
    }
    return n;
  }

  /**
   * Poke key for a POKE plan from the poke keys that reach `dist` (spec §2.3), one roll `r`, with
   * intent: a mid (heavy) against a crouching opponent (highs miss, lows are crouch-blocked), a low
   * (crouchLight) against a standing guard, else heavy by heavyPokeShare, crouchLight by lowPokeShare,
   * else light (the string opener); when the preferred move does not reach, the reaching key with the
   * longest reach. With nothing in reach (a mistakeRate pick) it is the longest-reaching poke key.
   */
  #pickPoke(self, dist, targetR, them, r) {
    const b = this.behaviour;
    const guarding = them.state === STATE.GUARD || them.state === STATE.BLOCKSTUN;
    if (them.crouching && this.#pokeReaches(self, 'heavy', dist, targetR)) return 'heavy';
    const low = (guarding && !them.crouching) || (r >= b.heavyPokeShare && r < b.heavyPokeShare + b.lowPokeShare);
    if (low && this.#pokeReaches(self, 'crouchLight', dist, targetR)) return 'crouchLight';
    if (r < b.heavyPokeShare && this.#pokeReaches(self, 'heavy', dist, targetR)) return 'heavy';
    if (this.#pokeReaches(self, 'light', dist, targetR)) return 'light';
    const keys = b.pokeKeys;
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
    const b = this.behaviour;
    switch (this.plan) {
      case PLAN.APPROACH: {
        out.stick.x = 1;
        const guarding = them.state === STATE.GUARD || them.state === STATE.BLOCKSTUN;
        const lightR = keyReach(self, 'light', theirR) - b.reachMargin;
        const throwR = keyReach(self, 'throw', theirR) - b.reachMargin;
        const closeR = lightR > throwR ? lightR : throwR;
        let goal;
        if (guarding) goal = throwR;
        else {
          const pokeR = bestPokeReach(self, b.pokeKeys, theirR) - b.reachMargin;
          goal = closeR + (pokeR > closeR ? (pokeR - closeR) * b.rangeBias : 0);
        }
        if (dist <= goal) this.planLeft = 1; // in range: re-decide next tick
        // A visible hazard zone on the way: hold here (the plan re-rolls when it runs out).
        if (this.hazardCount > 0 && this.#hazardAhead(me, them.x >= me.x ? 1 : -1, bodyRadiusOf(self, this.rules))) out.stick.x = 0;
        break;
      }
      case PLAN.BACK_OFF: {
        const edge = self.movement.ringRadius - b.ringEdgeMargin;
        if (this.hazardCount > 0 && this.#hazardAhead(me, them.x >= me.x ? -1 : 1, bodyRadiusOf(self, this.rules))) {
          break; // backing into a visible hazard zone: hold instead
        }
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
      case PLAN.POKE:
        if (!this.planDone) this.planDone = this.#press(out, this.pokeKey, me);
        break;
      case PLAN.GUARD:
        out.guard = true;
        break;
      case PLAN.SIDESTEP:
        if (this.planTick === 0) {
          if (CAN_SIDESTEP[me.state] === true) out.sidestep = this.sideDir;
          else this.planTick = -1; // not free yet: try again next tick
        }
        break;
      case PLAN.JUMP:
        if (!this.planDone && CAN_SIDESTEP[me.state] === true && me.grounded) {
          out.stick.y = 1;
          this.planDone = true;
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

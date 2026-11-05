// Two-fighter deterministic sim: hitstop, state machines, movement, hit resolution and
// presentation events (story-002 AC 2-6, 8; design/game-brief.md MVP feature 2).
// Pure and allocation-free per tick: no DOM, no three.js. Presentation reads `sim.events`
// (the first `sim.eventCount` entries) after each stepDuel call.
import { stepFighter } from './movement.js';
import { GUARD_TABLE, validateMoveTable } from './moves.js';
import { createCombatant, resetCombatant, updateHitbox } from './fighter.js';
import { updateHurtboxes } from './hurtbox.js';
import { cylindersOverlap } from '../core/collision.js';
import { Hitstop } from '../core/hitstop.js';
import { SeededRng } from '../core/rng.js';
import {
  STATE, PHASE, attackPhase, bufferInput, decideFighter, advanceFighter, setState, startPushback,
  applyTravel, inOwnOverwind,
} from './state-machine.js';
import { HAZARD_EVENT_NUM_FIELDS, KO_BY, createHazardRuntime, resetHazards, stepHazards } from './hazards.js';

/** Outcome of one attack against one defender on one tick. */
export const CONNECT = Object.freeze({ NONE: 0, HIT: 1, BLOCK: 2, THROW: 3 });

/** Presentation event types. */
export const EVENT = Object.freeze({ HIT: 'hit', BLOCK: 'block', THROW: 'throw', KO: 'ko' });

/**
 * Meter cues (story-009 §7), in their own pool `sim.cues` / `sim.cueCount` so contact-event
 * consumers (hit-fx, audio, frame data) never mistake them for hits. meterFull: `side` just filled
 * its Wind meter. overwindStart: `side` started Overwind on this tick (frame 1); the sim then
 * freezes `freezeFrames` ticks.
 */
export const CUE = Object.freeze({ METER_FULL: 'meterFull', OVERWIND_START: 'overwindStart' });

const MAX_EVENTS = 12;
const MAX_CUES = 4;
/**
 * Numeric event fields, zeroed when the event pool is created. armor: 1 when the hit was absorbed
 * by the defender's move armour (damage taken, no hitstun), else 0. super: 1 when the attacker's
 * move is its Overwind (story-009 §7), else 0. Hazard events (hazards.js) add in_frames, target,
 * knockback and blocked, plus the string `id` and the frozen `zone` reference; attacker is -1 on them.
 */
const EVENT_NUM_FIELDS = ['attacker', 'defender', 'damage', 'defenderHp', 'x', 'y', 'z', 'shake', 'flash', 'armor', 'super', ...HAZARD_EVENT_NUM_FIELDS];

/** Move-table validation lives with the move schema; re-exported here for existing callers. */
export { validateMoveTable };

function createEvent() {
  const e = { type: '', moveId: '', fx: '', level: '', id: '', zone: null };
  for (const k of EVENT_NUM_FIELDS) e[k] = 0;
  return e;
}

/** No hazards: the section of a ruleset built without one. */
const NO_HAZARDS = Object.freeze([]);

/**
 * Create a duel: two fighters facing each other at ±startOffset, both meters empty.
 * @example const sim = createDuel(ruleset); stepDuel(sim, in0, in1, 1 / 60);
 * @example const quiet = createDuel(ruleset, { hazards: false }); // the stage's hazards never fire (training)
 * @param {{rules: Readonly<Record<string, number>>, movement: Readonly<Record<string, number>>,
 *   meter: Readonly<Record<string, number>>, moves: Readonly<Record<string, import('./moves.js').MoveData>>,
 *   hazards?: ReadonlyArray<import('./hazards.js').HazardData>}} ruleset
 *   a ruleset from createRuleset (the round section is not read here)
 * @param {{hazards?: boolean, seed?: number}} [opts] hazards: run the ruleset's hazards (default true;
 *   setHazardsEnabled flips it later). seed: the sim rng (random hazard schedules); same seed + same
 *   inputs = same duel.
 */
export function createDuel(ruleset, { hazards = true, seed = 1 } = {}) {
  const { rules, movement, meter } = ruleset;
  const hazardData = ruleset.hazards ?? NO_HAZARDS;
  const f0 = createCombatant(0, -movement.startOffset, 0, ruleset);
  const f1 = createCombatant(1, movement.startOffset, 0, ruleset);
  f0.movement = movement;
  f1.movement = movement;
  validateMoveTable(f0.moves);
  if (f1.moves !== f0.moves) validateMoveTable(f1.moves);
  const events = [];
  for (let i = 0; i < MAX_EVENTS; i++) events.push(createEvent());
  const cues = [];
  for (let i = 0; i < MAX_CUES; i++) cues.push({ type: '', side: 0, freezeFrames: 0 });
  const sim = {
    fighters: [f0, f1],
    hitstop: new Hitstop(),
    events,
    eventCount: 0,
    /** Meter cues of this tick (first `cueCount` entries of `cues`), see CUE. */
    cues,
    cueCount: 0,
    /** Super-freeze ticks left (story-009 §3): state, stun, buffer age and travel all pause. */
    freezeLeft: 0,
    /** Ticks simulated (frozen ticks included). */
    frame: 0,
    /** Tick of the first KO, -1 while both stand. */
    koFrame: -1,
    /** What scored the first KO (hazards.js KO_BY): '' while both stand, 'attack' or 'hazard'. */
    koBy: KO_BY.NONE,
    /** Seeded sim rng (random hazard schedules); never used by fighters or hits. */
    rng: new SeededRng(seed),
    /** Hazard runtimes (hazards.js createHazardRuntime), one per ruleset hazard, in data order. */
    hazards: hazardData.map(createHazardRuntime),
    /** Hazards run this duel (toggle: setHazardsEnabled). Always false without hazard data. */
    hazardsEnabled: hazards === true && hazardData.length > 0,
    /** Unfrozen ticks since the last reset; the hazard schedules count on it. */
    hazardClock: 0,
    rules,
    movement,
    meter,
  };
  resetHazards(sim);
  return sim;
}

/**
 * Turn the ruleset's hazards on or off for this duel (story-013: off in training and on ranked
 * ladder rungs by default). Rewinds every hazard clock; a duel without hazard data stays off.
 * @example setHazardsEnabled(sim, settings.hazards === true); // at MATCH_START
 * @param {ReturnType<typeof createDuel>} sim
 * @param {boolean} on
 */
export function setHazardsEnabled(sim, on) {
  sim.hazardsEnabled = on === true && sim.hazards.length > 0;
  resetHazards(sim);
}

/**
 * Swap the duel's hazard list for another stage's (a built `hazards` section, buildHazards) and set
 * the toggle. Allocates the new runtimes once per call (a stage change, never per tick); clocks rewind.
 * @example setDuelHazards(sim, stageRuleset.hazards, settings.hazards === true); // at MATCH_START
 * @param {ReturnType<typeof createDuel>} sim
 * @param {ReadonlyArray<import('./hazards.js').HazardData>|undefined} hazards built hazard data (undefined = none)
 * @param {boolean} [enabled] run them (default: keep the current toggle)
 */
export function setDuelHazards(sim, hazards, enabled = sim.hazardsEnabled) {
  sim.hazards = (hazards ?? NO_HAZARDS).map(createHazardRuntime);
  setHazardsEnabled(sim, enabled);
}

/**
 * Empty both Wind meters (story-009 §3: match start, rematch, training entry). Rounds keep them.
 * @example flow.on(MATCH_EVENT.MATCH_START, () => resetMeters(sim));
 */
export function resetMeters(sim) {
  sim.fighters[0].meter = 0;
  sim.fighters[1].meter = 0;
}

function cue(sim, type, side, freezeFrames) {
  if (sim.cueCount >= MAX_CUES) return;
  const c = sim.cues[sim.cueCount++];
  c.type = type;
  c.side = side;
  c.freezeFrames = freezeFrames;
}

/**
 * Add Wind for one contact: max(minGain, round(rate * d)), clamped at max (excess lost).
 * Emits CUE.METER_FULL when this gain fills the meter.
 */
function gainMeter(sim, f, rate, d) {
  const cfg = sim.meter;
  if (f.meter >= cfg.max) return;
  const g = Math.round(rate * d);
  f.meter = Math.min(cfg.max, f.meter + (g > cfg.minGain ? g : cfg.minGain));
  if (f.meter >= cfg.max) cue(sim, CUE.METER_FULL, f.id, 0);
}

/** Put both fighters back at their start positions with full HP (greybox round reset). */
export function resetDuel(sim) {
  const off = sim.movement.startOffset;
  resetCombatant(sim.fighters[0], -off, 0, sim.rules);
  resetCombatant(sim.fighters[1], off, 0, sim.rules);
  sim.hitstop.reset();
  sim.eventCount = 0;
  sim.cueCount = 0;
  sim.freezeLeft = 0;
  sim.koFrame = -1;
  sim.koBy = KO_BY.NONE;
  resetHazards(sim);
}

/**
 * What attacker `a`'s current attack does to defender `b` this tick (pure apart from refreshing
 * the two scratch cylinders).
 */
export function connectResult(a, b, rules) {
  if (a.attackHasHit || attackPhase(a) !== PHASE.ACTIVE) return CONNECT.NONE;
  if (b.state === STATE.KO || b.state === STATE.THROWN) return CONNECT.NONE;
  const m = a.move;
  const isThrow = m.level === 'throw';
  if (isThrow && (!b.grounded || b.state === STATE.HITSTUN)) return CONNECT.NONE;
  // Joint-following hurtboxes (story-003 AC 5): body, plus the striking limb while b attacks.
  const hit = updateHitbox(a);
  const body = cylindersOverlap(hit, updateHurtboxes(b, rules));
  if (!body && !(b.limbHurtActive && cylindersOverlap(hit, b.limbHurtbox))) return CONNECT.NONE;
  if (isThrow) return CONNECT.THROW;
  const guarding = b.state === STATE.GUARD || b.state === STATE.BLOCKSTUN;
  if (guarding && GUARD_TABLE[m.level][b.crouching ? 'crouch' : 'stand']) return CONNECT.BLOCK;
  return CONNECT.HIT;
}

function emit(sim, type, a, b, m, shake, flash, damage = type === EVENT.BLOCK ? 0 : m.damage, armor = 0) {
  if (sim.eventCount >= MAX_EVENTS) return;
  const e = sim.events[sim.eventCount++];
  e.type = type;
  e.attacker = a.id;
  e.defender = b.id;
  e.moveId = a.moveId === null ? '' : a.moveId;
  e.fx = m.fx;
  e.level = m.level;
  e.damage = damage;
  e.armor = armor;
  e.super = a.moveId !== null && a.moveId === a.moveInputs.overwind ? 1 : 0;
  e.defenderHp = b.hp;
  // Contact point: defender's hurtbox surface facing the attacker, at the hitbox's height.
  const hurt = b.hurtbox;
  const hit = a.hitbox;
  let dx = a.x - b.x;
  let dz = a.z - b.z;
  const d = Math.hypot(dx, dz);
  if (d > 1e-6) {
    dx /= d;
    dz /= d;
  }
  e.x = b.x + dx * hurt.r;
  e.z = b.z + dz * hurt.r;
  const y = (hit.y0 + hit.y1) * 0.5;
  e.y = y < hurt.y0 ? hurt.y0 : y > hurt.y1 ? hurt.y1 : y;
  e.shake = shake;
  e.flash = flash;
}

/**
 * True when defender `d`'s current attack armours strike `m` from attacker `a` this tick: inside the
 * move's armour window (startup ticks), armour hits left, a level the armour covers, and not
 * Overwind (which always breaks armour). Throws never reach here (they are not CONNECT.HIT).
 * Design: design/quick-specs/fighter-identity-balance.md fallback step 3.
 */
export function armorAbsorbs(d, a, m) {
  if (d.state !== STATE.ATTACK || d.armorLeft <= 0) return false;
  const arm = d.move.armor;
  if (arm === undefined || d.stateFrame < arm.from || d.stateFrame > arm.to) return false;
  if (a.moveId === a.moveInputs.overwind) return false;
  return arm.levels.includes(m.level);
}

/**
 * Apply one connect. Captured move `m` is the attacker's move before any state change. aGain/bGain:
 * whether each side may gain Wind (false while in its own Overwind, captured before the contact).
 */
function applyConnect(sim, a, b, m, result, aGain, bGain) {
  const rules = sim.rules;
  const mc = sim.meter;
  a.attackHasHit = true;
  if (result === CONNECT.HIT && armorAbsorbs(b, a, m)) {
    // Armoured: damage and hitstop only; b keeps its move, frame counter and position.
    b.armorLeft--;
    const dmg = Math.round(m.damage * b.move.armor.damageScale);
    b.hp = Math.max(0, b.hp - dmg);
    if (aGain) gainMeter(sim, a, mc.hitDealt, dmg);
    if (bGain) gainMeter(sim, b, mc.hitTaken, dmg);
    if (b.hp > 0) {
      emit(sim, EVENT.HIT, a, b, m, m.shake, m.flash, dmg, 1);
      return m.hitstop;
    }
    setState(b, STATE.KO);
    b.stunLeft = 0;
    if (sim.koFrame < 0) {
      sim.koFrame = sim.frame;
      sim.koBy = KO_BY.ATTACK;
    }
    emit(sim, EVENT.HIT, a, b, m, m.shake, m.flash, dmg, 1);
    emit(sim, EVENT.KO, a, b, m, rules.koShake, rules.koFlash);
    return m.hitstop > rules.koHitstop ? m.hitstop : rules.koHitstop;
  }
  if (result === CONNECT.BLOCK) {
    if (aGain) gainMeter(sim, a, mc.blockDealt, m.damage);
    if (bGain) gainMeter(sim, b, mc.blockTaken, m.damage);
    setState(b, STATE.BLOCKSTUN);
    b.stunLeft = m.blockstun;
    startPushback(b, a, m.blockPushback, rules);
    emit(sim, EVENT.BLOCK, a, b, m, m.shake * rules.blockShakeScale, 0);
    return m.blockHitstop;
  }
  b.hp = Math.max(0, b.hp - m.damage);
  startPushback(b, a, m.pushback, rules);
  const isThrow = result === CONNECT.THROW;
  if (aGain) gainMeter(sim, a, isThrow ? mc.throwDealt : mc.hitDealt, m.damage);
  if (bGain) gainMeter(sim, b, isThrow ? mc.throwTaken : mc.hitTaken, m.damage);
  if (b.hp === 0) {
    setState(b, STATE.KO);
    b.stunLeft = 0;
    if (sim.koFrame < 0) {
      sim.koFrame = sim.frame;
      sim.koBy = KO_BY.ATTACK;
    }
    emit(sim, isThrow ? EVENT.THROW : EVENT.HIT, a, b, m, m.shake, m.flash);
    emit(sim, EVENT.KO, a, b, m, rules.koShake, rules.koFlash);
    return m.hitstop > rules.koHitstop ? m.hitstop : rules.koHitstop;
  }
  setState(b, isThrow ? STATE.THROWN : STATE.HITSTUN);
  b.stunLeft = isThrow ? m.thrownFrames : m.hitstun;
  emit(sim, isThrow ? EVENT.THROW : EVENT.HIT, a, b, m, m.shake, m.flash);
  return m.hitstop;
}

/**
 * Resolve both fighters' attacks against each other, order-independently: both results are
 * computed from the pre-hit state, then applied. Strike+strike trades; strike beats throw;
 * throw+throw clashes and both whiff.
 */
export function resolveHits(sim) {
  const f0 = sim.fighters[0];
  const f1 = sim.fighters[1];
  let r0 = connectResult(f0, f1, sim.rules);
  let r1 = connectResult(f1, f0, sim.rules);
  if (r0 === CONNECT.THROW && r1 === CONNECT.THROW) {
    f0.attackHasHit = true;
    f1.attackHasHit = true;
    r0 = r1 = CONNECT.NONE;
  } else if (r0 === CONNECT.THROW && r1 === CONNECT.HIT) {
    r0 = CONNECT.NONE;
  } else if (r1 === CONNECT.THROW && r0 === CONNECT.HIT) {
    r1 = CONNECT.NONE;
  }
  const m0 = f0.move;
  const m1 = f1.move;
  const g0 = !inOwnOverwind(f0);
  const g1 = !inOwnOverwind(f1);
  let stop = 0;
  if (r0 !== CONNECT.NONE) stop = applyConnect(sim, f0, f1, m0, r0, g0, g1);
  if (r1 !== CONNECT.NONE) {
    const s1 = applyConnect(sim, f1, f0, m1, r1, g1, g0);
    if (s1 > stop) stop = s1;
  }
  if (stop > 0) sim.hitstop.trigger(stop);
}

/**
 * Advance the duel one fixed tick.
 * @param {ReturnType<typeof createDuel>} sim
 * @param {ReturnType<typeof import('../input/input-snapshot.js').createSnapshot>} in0 player 0 input
 * @param {ReturnType<typeof import('../input/input-snapshot.js').createSnapshot>} in1 player 1 input
 * @param {number} dt seconds (1/60 from FixedStepLoop)
 */
export function stepDuel(sim, in0, in1, dt) {
  const f0 = sim.fighters[0];
  const f1 = sim.fighters[1];
  const rules = sim.rules;
  sim.frame++;
  sim.eventCount = 0;
  sim.cueCount = 0;
  bufferInput(f0, in0, rules);
  bufferInput(f1, in1, rules);

  // Super freeze (story-009 §3) first, then hitstop: both hold pose, presses stay buffered unaged.
  let frozen = false;
  if (sim.freezeLeft > 0) {
    sim.freezeLeft--;
    frozen = true;
  } else frozen = sim.hitstop.tick();
  if (frozen) {
    // Frozen: hold pose (no render interpolation drift), keep presses buffered.
    f0.prevX = f0.x; f0.prevY = f0.y; f0.prevZ = f0.z;
    f1.prevX = f1.x; f1.prevY = f1.y; f1.prevZ = f1.z;
    return;
  }

  const meter = sim.meter;
  decideFighter(f0, f1, in0, rules, meter);
  decideFighter(f1, f0, in1, rules, meter);
  // Overwind frame 1 (meter already spent in beginMove): one shared freeze even if both start.
  for (let i = 0; i < 2; i++) {
    const f = sim.fighters[i];
    if (f.state === STATE.ATTACK && f.stateFrame === 0 && f.moveId === f.moveInputs.overwind) {
      sim.freezeLeft = meter.superFreezeFrames;
      cue(sim, CUE.OVERWIND_START, f.id, meter.superFreezeFrames);
    }
  }
  // Per-fighter movement (story-003 AC 1): f.movement is the kit's config (shared arena keys).
  stepFighter(f0, f1, f0.intent, dt, f0.movement);
  stepFighter(f1, f0, f1.intent, dt, f1.movement);
  advanceFighter(f0, rules, f0.movement);
  advanceFighter(f1, rules, f1.movement);
  applyTravel(f0, f1, f0.movement);
  applyTravel(f1, f0, f1.movement);
  resolveHits(sim);
  // Stage hazards (hazards.js) after the fighters' own hits; their clocks pause with the world above.
  if (sim.hazardsEnabled) stepHazards(sim, EVENT.KO);
}

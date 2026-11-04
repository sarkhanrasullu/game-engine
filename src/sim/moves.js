// Move frame data schema, guard table and validation. The game supplies the move tables (a
// fallback greybox kit in the ruleset, and per-fighter kits); tune them in data, never in logic.
//
// Frame convention (60 Hz sim ticks, see state-machine.js):
//   startup  = ticks before the first active tick
//   active   = ticks the hitbox exists
//   recovery = ticks after the last active tick before the fighter can act
//   hitstun / blockstun / thrownFrames = ticks the defender is locked after hitstop ends
//   hitstop / blockHitstop = freeze ticks applied to BOTH fighters on contact
// Distances are world units. hitbox: cylinder `forward` units ahead of the attacker along its
// locked facing, `radius` wide, spanning yMin..yMax above the attacker's feet.
// level: 'high' | 'mid' | 'low' | 'throw' (see GUARD_TABLE). fx: presentation class for hit-fx.
// shake: 0..1 camera-shake intensity on hit. flash: 0..1 screen-flash intensity on hit.
// cancel (optional, story-003 AC 3 Light strings): { into, from, to, requiresContact }. A Light
// press (buffered) chains into move `into` when the chain move would start on frame n of this move
// with from <= n <= to (frame convention above; n <= total). requiresContact: only after this move
// hit or was blocked. A press that misses the window is not chained (the string drops).
// armor (optional, design/quick-specs/fighter-identity-balance.md fallback step 3):
// { from, to, hits, damageScale, levels }. While the attacker's stateFrame n satisfies
// from <= n <= to (startup ticks only: to <= startup), the first `hits` strikes whose level is in
// `levels` deal damage * damageScale (rounded) and hitstop, but no hitstun, no pushback and do not
// cancel the move. Throws and Overwind always break through.
// travel (optional, story-009 §4): { from, to, distance }. On attack frames from..to (inclusive,
// 1 <= from <= to <= startup + active) the attacker moves distance / (to - from + 1) per tick along
// its locked attack direction (negative = backward); it stops at minSeparation and the ring edge
// and the rest of the distance is dropped.
// aiRole (optional, CPU-only): one of AI_ROLES.

import { deepFreeze } from '../core/data.js';

/** @typedef {{name:string,level:'high'|'mid'|'low'|'throw',startup:number,active:number,recovery:number,damage:number,hitstun:number,blockstun:number,thrownFrames:number,pushback:number,blockPushback:number,hitstop:number,blockHitstop:number,crouching:boolean,hitbox:{forward:number,radius:number,yMin:number,yMax:number},fx:'light'|'heavy'|'throw'|'super',shake:number,flash:number,cancel?:MoveCancel,armor?:MoveArmor,travel?:MoveTravel,aiRole?:string}} MoveData */
/** @typedef {{from:number,to:number,distance:number}} MoveTravel */
/** @typedef {{from:number,to:number,hits:number,damageScale:number,levels:string[]}} MoveArmor */
/** @typedef {{into:string,from:number,to:number,requiresContact:boolean}} MoveCancel */

/** Which guard stance blocks which attack level. Throws are never blockable. */
export const GUARD_TABLE = Object.freeze({
  high: Object.freeze({ stand: true, crouch: true }),
  mid: Object.freeze({ stand: true, crouch: false }),
  low: Object.freeze({ stand: false, crouch: true }),
  throw: Object.freeze({ stand: false, crouch: false }),
});

/**
 * Button -> move id. Heavy resolves (story-009 §2): Guard + full meter -> overwind, crouching ->
 * crouchHeavy, stick toward / away at the press -> specialForward / specialBack, else heavy.
 * A move table without the special ids (greybox) falls back to heavy.
 */
export const MOVE_INPUTS = Object.freeze({
  light: 'light',
  heavy: 'heavy',
  crouchLight: 'crouchLight',
  crouchHeavy: 'crouchHeavy',
  throw: 'throw',
  overwind: 'overwind',
  specialForward: 'specialForward',
  specialBack: 'specialBack',
});

/** CPU roles a move may declare (story-009 §4). */
export const AI_ROLES = Object.freeze(['gapClose', 'antiStep', 'lowPoke', 'retreatPoke']);

/** Integer frame-data fields of a move (validated at load). */
const MOVE_FIELDS = ['startup', 'active', 'recovery', 'damage', 'hitstun', 'blockstun', 'thrownFrames', 'hitstop', 'blockHitstop'];

/**
 * Validate a move table at the data boundary. Throws with the offending move and field.
 * @param {Record<string, MoveData>} moves
 */
export function validateMoveTable(moves) {
  for (const id of Object.keys(moves)) {
    const m = moves[id];
    for (const k of MOVE_FIELDS) {
      if (!Number.isInteger(m[k]) || m[k] < 0) throw new Error(`move ${id}: ${k} must be an integer >= 0`);
    }
    if (m.startup < 1 || m.active < 1) throw new Error(`move ${id}: startup and active must be >= 1`);
    if (GUARD_TABLE[m.level] === undefined) throw new Error(`move ${id}: unknown level ${m.level}`);
    if (m.level === 'throw' && m.thrownFrames < 1) throw new Error(`move ${id}: throw needs thrownFrames >= 1`);
    if (m.level !== 'throw' && m.hitstun < 1) throw new Error(`move ${id}: strike needs hitstun >= 1`);
    const h = m.hitbox;
    if (!(h && h.radius > 0 && h.yMax > h.yMin)) throw new Error(`move ${id}: bad hitbox`);
    if (m.cancel !== undefined) validateCancel(moves, id);
    if (m.armor !== undefined) validateArmor(m, id);
    if (m.travel !== undefined) validateTravel(m, id);
    if (m.aiRole !== undefined && !AI_ROLES.includes(m.aiRole)) throw new Error(`move ${id}: aiRole must be one of ${AI_ROLES.join('/')}`);
  }
  for (const id of Object.keys(moves)) chainLength(moves, id);
}

/** Strike levels armour may absorb (throws always break armour). */
const ARMOR_LEVELS = ['high', 'mid', 'low'];

function validateArmor(m, id) {
  const a = m.armor;
  if (!a || typeof a !== 'object') throw new Error(`move ${id}: armor must be an object`);
  if (!Number.isInteger(a.from) || !Number.isInteger(a.to) || a.from < 1 || a.to < a.from || a.to > m.startup) {
    throw new Error(`move ${id}: armor window must satisfy 1 <= from <= to <= startup (${m.startup})`);
  }
  if (!Number.isInteger(a.hits) || a.hits < 1) throw new Error(`move ${id}: armor.hits must be an integer >= 1`);
  if (typeof a.damageScale !== 'number' || !(a.damageScale >= 0 && a.damageScale <= 1)) {
    throw new Error(`move ${id}: armor.damageScale must be in 0..1`);
  }
  if (!Array.isArray(a.levels) || a.levels.length === 0 || a.levels.some((l) => !ARMOR_LEVELS.includes(l))) {
    throw new Error(`move ${id}: armor.levels must be a non-empty list of ${ARMOR_LEVELS.join('/')}`);
  }
}

function validateTravel(m, id) {
  const t = m.travel;
  if (!t || typeof t !== 'object') throw new Error(`move ${id}: travel must be an object`);
  const last = m.startup + m.active;
  if (!Number.isInteger(t.from) || !Number.isInteger(t.to) || t.from < 1 || t.to < t.from || t.to > last) {
    throw new Error(`move ${id}: travel window must satisfy 1 <= from <= to <= startup + active (${last})`);
  }
  if (typeof t.distance !== 'number' || !Number.isFinite(t.distance)) throw new Error(`move ${id}: travel.distance must be a finite number`);
}

function validateCancel(moves, id) {
  const c = moves[id].cancel;
  const total = moves[id].startup + moves[id].active + moves[id].recovery;
  if (!c || moves[c.into] === undefined) throw new Error(`move ${id}: cancel into unknown move`);
  if (!Number.isInteger(c.from) || !Number.isInteger(c.to) || c.from < 1 || c.to < c.from || c.to > total) {
    throw new Error(`move ${id}: cancel window must satisfy 1 <= from <= to <= ${total}`);
  }
  if (typeof c.requiresContact !== 'boolean') throw new Error(`move ${id}: cancel.requiresContact must be boolean`);
}

/**
 * Number of hits in the string that starts with move `id` (1 = no cancel). Throws on a cancel loop.
 * @param {Record<string, MoveData>} moves
 * @param {string} id
 */
export function chainLength(moves, id) {
  let n = 1;
  let m = moves[id];
  while (m.cancel !== undefined) {
    n++;
    if (n > Object.keys(moves).length) throw new Error(`move ${id}: cancel chain loops`);
    m = moves[m.cancel.into];
  }
  return n;
}

/**
 * Copy, deep-freeze and validate a move table (e.g. the fallback greybox kit of a ruleset).
 * @example const moves = buildMoves(tuning.greyboxMoves); moves.light.startup // e.g. 5
 * @param {Record<string, MoveData>} json
 * @returns {Readonly<Record<string, MoveData>>}
 */
export function buildMoves(json) {
  const moves = deepFreeze(structuredClone(json));
  validateMoveTable(moves);
  return moves;
}

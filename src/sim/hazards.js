// Stage hazards: data-driven, telegraphed lane zones that hurt whoever stands in them. The game
// supplies the list (a ruleset `hazards` section, usually merged from its stage config); the sim
// owns the clocks. Pure and allocation-free per tick: no DOM, no three.js, no stage or fighter names.
//
// Lifecycle of one hazard (60 Hz ticks, every duration given in ms and rounded to frames):
//   idle --(gap)--> telegraph --(telegraph_ms >= 500)--> active --(active_ms)--> idle ...
// Events (written into `sim.events` like hits; see duel-sim.js):
//   hazard_telegraph { id, zone, in_frames }        once per cycle, when the telegraph starts
//   hazard_active    { id, zone }                   when the zone starts hurting
//   hazard_hit       { id, target, damage, knockback, blocked, armor } per fighter struck, once per activation
//   hazard_end       { id }                         when the zone stops hurting
// A fighter whose hurtbox overlaps the zone (x band, optional y band so a jump can clear a floor
// hazard) while it is active takes `effect`: guarding fighters take damage * guard_scale and
// blockstun instead (unless ignores_guard), a move's armour window absorbs it at the move's
// damageScale (unless armor_breaks), KO'd and thrown fighters are never struck (i-frames). A KO by
// hazard is a real KO (EVENT.KO is emitted) and `sim.koBy` reads KO_BY.HAZARD so the host can pass
// ROUND_REASON.HAZARD to MatchFlow#update. Hazards never feed the Wind meter.
//
// Schema (JSON, snake_case; defaults in brackets):
//   id            non-empty string, unique
//   zone          { x0 < x1 } sim units along the lane; optional { y0 < y1 } height band (both or neither)
//   cycle         { telegraph_ms >= 500, active_ms >= 1 tick, period_ms > telegraph + active (periodic /
//                 random), phase_ms [0] delay before the first telegraph, jitter_ms [0] (random only,
//                 < period - telegraph - active) }
//   effect        { damage int >= 0, knockback >= 0, hitstun_frames int >= 1, launch [0] upward speed,
//                 ignores_guard [false], armor_breaks [false], guard_scale [0.25] 0..1, hitstop [0] ticks,
//                 shake [0.5], flash [0.2], fx ['heavy'] hit-fx class }
//   schedule      'periodic' [default]: repeats every period_ms from phase_ms; 'random': every gap gets
//                 +-jitter_ms from the sim's seeded rng (same seed -> same cycles); 'scripted': fires once
//                 at each entry of times_ms (ms since the round reset, ascending, telegraph + active apart)
import { deepFreeze } from '../core/data.js';
import { STATE, setState } from './state-machine.js';
import { updateHurtboxes } from './hurtbox.js';

/** Sim tick rate every ms value is rounded to. */
export const SIM_HZ = 60;
/** Shortest telegraph the schema accepts (story-013 AC: the hazard is visible >= 500 ms before it hits). */
export const MIN_TELEGRAPH_MS = 500;

/** Presentation event types a hazard writes into `sim.events`. */
export const HAZARD_EVENT = Object.freeze({
  TELEGRAPH: 'hazard_telegraph', ACTIVE: 'hazard_active', HIT: 'hazard_hit', END: 'hazard_end',
});

/** Accepted `schedule` values. */
export const HAZARD_SCHEDULES = Object.freeze(['periodic', 'random', 'scripted']);

/** Runtime phases of one hazard (`sim.hazards[i].phase`). */
export const HAZARD_PHASE = Object.freeze({ IDLE: 'idle', TELEGRAPH: 'telegraph', ACTIVE: 'active', DORMANT: 'dormant' });

/** Who scored the first KO of the round (`sim.koBy`). */
export const KO_BY = Object.freeze({ NONE: '', ATTACK: 'attack', HAZARD: 'hazard' });

/** Numeric event fields hazards add to the duel-sim event pool (zeroed at pool creation). */
export const HAZARD_EVENT_NUM_FIELDS = Object.freeze(['in_frames', 'target', 'knockback', 'blocked']);

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isInt = (v, min) => Number.isInteger(v) && v >= min;
const ge0 = (v) => isNum(v) && v >= 0;
const unit = (v) => isNum(v) && v >= 0 && v <= 1;
const isBool = (v) => typeof v === 'boolean';
const camel = (k) => k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

/** [key, default (undefined = required), check, rule text] of the `effect` section. */
const EFFECT_RULES = [
  ['damage', undefined, (v) => isInt(v, 0), 'an integer >= 0'],
  ['knockback', undefined, ge0, 'a number >= 0'],
  ['hitstun_frames', undefined, (v) => isInt(v, 1), 'an integer >= 1'],
  ['launch', 0, ge0, 'a number >= 0'],
  ['ignores_guard', false, isBool, 'a boolean'],
  ['armor_breaks', false, isBool, 'a boolean'],
  ['guard_scale', 0.25, unit, 'in 0..1'],
  ['hitstop', 0, (v) => isInt(v, 0), 'an integer >= 0'],
  ['shake', 0.5, unit, 'in 0..1'],
  ['flash', 0.2, unit, 'in 0..1'],
  ['fx', 'heavy', (v) => ['light', 'heavy', 'throw', 'super'].includes(v), 'a hit-fx class'],
];
const TOP_KEYS = ['id', 'zone', 'cycle', 'effect', 'schedule', 'times_ms'];
const ZONE_KEYS = ['x0', 'x1', 'y0', 'y1'];
const CYCLE_KEYS = ['period_ms', 'telegraph_ms', 'active_ms', 'phase_ms', 'jitter_ms'];

/**
 * @typedef {{ id: string, zone: Readonly<{x0: number, x1: number, y0: number, y1: number}>,
 *   schedule: 'periodic'|'random'|'scripted', telegraphFrames: number, activeFrames: number,
 *   periodFrames: number, phaseFrames: number, jitterFrames: number, times: readonly number[],
 *   effect: Readonly<{damage: number, knockback: number, hitstunFrames: number, launch: number,
 *     ignoresGuard: boolean, armorBreaks: boolean, guardScale: number, hitstop: number,
 *     shake: number, flash: number, fx: string}> }} HazardData
 */

/**
 * True for the four hazard event types (so a host can route them away from its hit consumers).
 * @example if (isHazardEvent(e.type)) stage.onHazard(e); else fx.onEvent(e);
 * @param {string} type
 */
export function isHazardEvent(type) {
  return type === HAZARD_EVENT.TELEGRAPH || type === HAZARD_EVENT.ACTIVE
    || type === HAZARD_EVENT.HIT || type === HAZARD_EVENT.END;
}

/**
 * Milliseconds to whole 60 Hz ticks (nearest).
 * @example msToFrames(500) // 30
 * @param {number} ms
 */
export function msToFrames(ms) {
  return Math.round((ms * SIM_HZ) / 1000);
}

function need(ok, label, what) {
  if (!ok) throw new Error(`${label}: ${what}`);
}

/** The section must be an object with only `keys`. */
function section(src, keys, label) {
  need(src && typeof src === 'object' && !Array.isArray(src), label, 'must be an object');
  for (const k of Object.keys(src)) need(keys.includes(k), label, `unknown key ${k}`);
  return src;
}

function buildOne(src, i, seen) {
  const label = `hazard ${typeof src?.id === 'string' ? src.id : `#${i}`}`;
  section(src, TOP_KEYS, label);
  need(typeof src.id === 'string' && src.id.length > 0, label, 'id must be a non-empty string');
  need(!seen.has(src.id), label, 'duplicate id');
  seen.add(src.id);
  const schedule = src.schedule ?? 'periodic';
  need(HAZARD_SCHEDULES.includes(schedule), label, `schedule must be one of ${HAZARD_SCHEDULES.join('/')}`);

  const z = section(src.zone, ZONE_KEYS, `${label} zone`);
  need(isNum(z.x0) && isNum(z.x1) && z.x0 < z.x1, label, 'zone needs x0 < x1');
  const hasY = z.y0 !== undefined || z.y1 !== undefined;
  need(!hasY || (isNum(z.y0) && isNum(z.y1) && z.y0 < z.y1), label, 'zone y band needs y0 < y1 (both or neither)');
  const zone = { x0: z.x0, x1: z.x1, y0: hasY ? z.y0 : -Infinity, y1: hasY ? z.y1 : Infinity };

  const c = section(src.cycle, CYCLE_KEYS, `${label} cycle`);
  need(isNum(c.telegraph_ms) && c.telegraph_ms >= MIN_TELEGRAPH_MS, label, `cycle.telegraph_ms must be >= ${MIN_TELEGRAPH_MS}`);
  const telegraphFrames = msToFrames(c.telegraph_ms);
  const activeFrames = isNum(c.active_ms) ? msToFrames(c.active_ms) : 0;
  need(activeFrames >= 1, label, 'cycle.active_ms must last at least one tick');
  need(ge0(c.phase_ms ?? 0), label, 'cycle.phase_ms must be a number >= 0');
  const phaseFrames = msToFrames(c.phase_ms ?? 0);
  const busy = telegraphFrames + activeFrames;
  let periodFrames = 0;
  let jitterFrames = 0;
  let times = [];
  if (schedule === 'scripted') {
    need(src.times_ms !== undefined && Array.isArray(src.times_ms) && src.times_ms.length > 0, label, 'scripted schedule needs a non-empty times_ms list');
    times = src.times_ms.map((ms) => {
      need(ge0(ms), label, 'times_ms entries must be numbers >= 0');
      return msToFrames(ms);
    });
    for (let k = 1; k < times.length; k++) need(times[k] - times[k - 1] > busy, label, 'times_ms entries must be ascending, telegraph_ms + active_ms apart');
  } else {
    need(src.times_ms === undefined, label, "times_ms is only valid with schedule 'scripted'");
    periodFrames = isNum(c.period_ms) ? msToFrames(c.period_ms) : 0;
    need(periodFrames > busy, label, 'cycle.period_ms must exceed telegraph_ms + active_ms');
    need(ge0(c.jitter_ms ?? 0), label, 'cycle.jitter_ms must be a number >= 0');
    jitterFrames = schedule === 'random' ? msToFrames(c.jitter_ms ?? 0) : 0;
    need(jitterFrames < periodFrames - busy, label, 'cycle.jitter_ms must be smaller than period_ms - telegraph_ms - active_ms');
  }

  const e = section(src.effect, EFFECT_RULES.map((r) => r[0]), `${label} effect`);
  const effect = {};
  for (const [key, dflt, check, rule] of EFFECT_RULES) {
    const v = e[key] ?? dflt;
    need(check(v), label, `effect.${key} must be ${rule}`);
    effect[camel(key)] = v;
  }
  return { id: src.id, zone, schedule, telegraphFrames, activeFrames, periodFrames, phaseFrames, jitterFrames, times, effect };
}

/**
 * Validate and freeze a `hazards` section (a list; `undefined` means none). Throws with the hazard
 * id and field on bad data, like the move-table validator.
 * @example
 *   const hazards = buildHazards([{
 *     id: 'vent_left', zone: { x0: -3.2, x1: -2.4, y0: 0, y1: 0.6 },
 *     cycle: { period_ms: 9000, telegraph_ms: 900, active_ms: 500, phase_ms: 4000 },
 *     effect: { damage: 8, knockback: 0.6, hitstun_frames: 18, launch: 3 },
 *   }]);
 *   hazards[0].telegraphFrames // 54
 * @param {unknown} json
 * @returns {ReadonlyArray<HazardData>}
 */
export function buildHazards(json) {
  if (json === undefined || json === null) return deepFreeze([]);
  need(Array.isArray(json), 'hazards', 'must be a list');
  const seen = new Set();
  return deepFreeze(json.map((h, i) => buildOne(h, i, seen)));
}

/**
 * Per-duel runtime state of one hazard (public, read-only for perception: `phase`, `left`
 * ticks until the next phase change, `cycle` count of telegraphs so far, `data`).
 * @example sim.hazards[0].phase === HAZARD_PHASE.TELEGRAPH
 * @param {HazardData} data
 */
export function createHazardRuntime(data) {
  return { data, phase: HAZARD_PHASE.DORMANT, left: 0, cycle: 0, struck: 0, nextTime: 0 };
}

/**
 * Ticks until hazard `h` starts hurting: its telegraph countdown, 0 while active, -1 when idle.
 * @example const soon = hazardTimeToActive(sim.hazards[0]); if (soon >= 0) stepOut();
 */
export function hazardTimeToActive(h) {
  if (h.phase === HAZARD_PHASE.TELEGRAPH) return h.left;
  return h.phase === HAZARD_PHASE.ACTIVE ? 0 : -1;
}

/**
 * True when fighter `f`'s hurtbox overlaps `zone` (x band, and the y band when the zone has one).
 * Refreshes f.hurtbox; allocation-free.
 * @example fighterInZone(sim.fighters[0], sim.hazards[0].data.zone, sim.rules)
 * @param {object} f combatant @param {{x0:number,x1:number,y0:number,y1:number}} zone
 * @param {Readonly<Record<string, number>>} rules ruleset.rules
 */
export function fighterInZone(f, zone, rules) {
  const h = updateHurtboxes(f, rules);
  return h.x + h.r >= zone.x0 && h.x - h.r <= zone.x1 && h.y1 >= zone.y0 && h.y0 <= zone.y1;
}

/**
 * Rewind every hazard to its first telegraph (round reset / toggle; duel-sim calls it).
 * @example resetHazards(sim); // sim.hazardClock === 0
 */
export function resetHazards(sim) {
  sim.hazardClock = 0;
  for (const h of sim.hazards) {
    const d = h.data;
    h.cycle = 0;
    h.struck = 0;
    h.nextTime = 0;
    h.phase = sim.hazardsEnabled ? HAZARD_PHASE.IDLE : HAZARD_PHASE.DORMANT;
    h.left = d.schedule === 'scripted' ? d.times[(h.nextTime = 1) - 1] : d.phaseFrames;
  }
}

function emitHazard(sim, type, h, f, damage, knockback, blocked, armor, shake, flash) {
  if (sim.eventCount >= sim.events.length) return;
  const e = sim.events[sim.eventCount++];
  const d = h.data;
  const z = d.zone;
  e.type = type;
  e.id = e.moveId = d.id;
  e.zone = z;
  e.in_frames = h.phase === HAZARD_PHASE.TELEGRAPH ? h.left : 0;
  e.target = e.defender = f === null ? -1 : f.id;
  e.attacker = -1;
  e.fx = d.effect.fx;
  e.level = 'mid';
  e.damage = damage;
  e.knockback = knockback;
  e.blocked = blocked;
  e.armor = armor;
  e.super = 0;
  e.defenderHp = f === null ? 0 : f.hp;
  e.x = f === null ? (z.x0 + z.x1) * 0.5 : f.x;
  e.y = f === null ? (z.y0 > -Infinity ? z.y0 : 0) : f.y;
  e.z = f === null ? 0 : f.z;
  e.shake = shake;
  e.flash = flash;
}

/** Push `f` out of the zone along the lane (x), away from the zone centre. */
function knock(f, zone, distance, rules) {
  f.pushDirX = f.x >= (zone.x0 + zone.x1) * 0.5 ? 1 : -1;
  f.pushDirZ = 0;
  f.pushLeft = distance;
  f.pushFrames = distance > 0 ? rules.pushbackFrames : 0;
}

/**
 * Apply hazard `h` to fighter `f` (already known to stand in the zone). Returns the hitstop to apply.
 * `koType` is EVENT.KO (duel-sim.js) so a hazard KO drives the same KO presentation as a hit.
 */
function strike(sim, h, f, koType) {
  const fx = h.data.effect;
  const rules = sim.rules;
  const arm = f.move?.armor;
  const guarding = (f.state === STATE.GUARD || f.state === STATE.BLOCKSTUN) && !fx.ignoresGuard;
  const armoured = !guarding && !fx.armorBreaks && f.state === STATE.ATTACK && f.armorLeft > 0
    && arm !== undefined && f.stateFrame >= arm.from && f.stateFrame <= arm.to;
  const dmg = guarding ? Math.round(fx.damage * fx.guardScale) : armoured ? Math.round(fx.damage * arm.damageScale) : fx.damage;
  f.hp = Math.max(0, f.hp - dmg);
  if (f.hp === 0) {
    setState(f, STATE.KO);
    f.stunLeft = 0;
    if (sim.koFrame < 0) {
      sim.koFrame = sim.frame;
      sim.koBy = KO_BY.HAZARD;
    }
    emitHazard(sim, HAZARD_EVENT.HIT, h, f, dmg, 0, 0, 0, fx.shake, fx.flash);
    emitHazard(sim, koType, h, f, dmg, 0, 0, 0, rules.koShake, rules.koFlash);
    return fx.hitstop > rules.koHitstop ? fx.hitstop : rules.koHitstop;
  }
  if (armoured) {
    f.armorLeft--; // damage only: the move, its frame and position survive
    emitHazard(sim, HAZARD_EVENT.HIT, h, f, dmg, 0, 0, 1, fx.shake, fx.flash);
    return fx.hitstop;
  }
  setState(f, guarding ? STATE.BLOCKSTUN : STATE.HITSTUN);
  f.stunLeft = fx.hitstunFrames;
  knock(f, h.data.zone, fx.knockback, rules);
  if (!guarding && fx.launch > 0) {
    f.vy = fx.launch;
    f.grounded = false;
    f.airTime = 0;
  }
  emitHazard(sim, HAZARD_EVENT.HIT, h, f, dmg, fx.knockback, guarding ? 1 : 0, 0, guarding ? fx.shake * rules.blockShakeScale : fx.shake, guarding ? 0 : fx.flash);
  return fx.hitstop;
}

/** Strike every fighter in the active zone that this activation has not struck yet. */
function sweep(sim, h, koType) {
  let stop = 0;
  const fighters = sim.fighters;
  for (let i = 0; i < fighters.length; i++) {
    const f = fighters[i];
    if ((h.struck >> i) & 1 || f.state === STATE.KO || f.state === STATE.THROWN || !fighterInZone(f, h.data.zone, sim.rules)) continue;
    h.struck |= 1 << i;
    const s = strike(sim, h, f, koType);
    if (s > stop) stop = s;
  }
  if (stop > 0) sim.hitstop.trigger(stop);
}

/** Ticks from the end of this activation to the next telegraph; -1 when the hazard sleeps. */
function nextGap(sim, h) {
  const d = h.data;
  if (d.schedule === 'scripted') return h.nextTime < d.times.length ? d.times[h.nextTime++] - sim.hazardClock : -1;
  const gap = d.periodFrames - d.telegraphFrames - d.activeFrames;
  return d.schedule === 'random' ? gap + sim.rng.int(2 * d.jitterFrames + 1) - d.jitterFrames : gap;
}

/**
 * Advance every hazard one (unfrozen) tick: countdowns, phase changes, events and strikes.
 * Called by stepDuel after hit resolution; nothing to do while `sim.hazardsEnabled` is false.
 * @example stepHazards(sim, EVENT.KO); // inside stepDuel
 * @param {object} sim a createDuel sim
 * @param {string} koType the event type of a KO (duel-sim EVENT.KO)
 */
export function stepHazards(sim, koType) {
  sim.hazardClock++;
  for (const h of sim.hazards) {
    const p = h.phase;
    if (p === HAZARD_PHASE.DORMANT) continue;
    if (p === HAZARD_PHASE.ACTIVE && h.left > 1) {
      h.left--;
      sweep(sim, h, koType);
    } else if (--h.left <= 0) {
      if (p === HAZARD_PHASE.IDLE) {
        h.phase = HAZARD_PHASE.TELEGRAPH;
        h.left = h.data.telegraphFrames;
        h.struck = 0;
        h.cycle++;
        emitHazard(sim, HAZARD_EVENT.TELEGRAPH, h, null, 0, 0, 0, 0, 0, 0);
      } else if (p === HAZARD_PHASE.TELEGRAPH) {
        h.phase = HAZARD_PHASE.ACTIVE;
        h.left = h.data.activeFrames;
        emitHazard(sim, HAZARD_EVENT.ACTIVE, h, null, 0, 0, 0, 0, 0, 0);
        sweep(sim, h, koType);
      } else {
        emitHazard(sim, HAZARD_EVENT.END, h, null, 0, 0, 0, 0, 0, 0);
        const gap = nextGap(sim, h);
        h.phase = gap < 0 ? HAZARD_PHASE.DORMANT : HAZARD_PHASE.IDLE;
        h.left = gap;
      }
    }
  }
}

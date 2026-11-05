// Fighter state machine (story-002 AC 1, 5, 6, 7; design/game-brief.md MVP feature 2).
// Pure and allocation-free: no DOM, no three.js. One sim tick per fighter is
//   bufferInput -> decideFighter -> stepFighter (movement, story-001) -> advanceFighter,
// and duel-sim.js resolves hits between the two fighters afterwards.
//
// Frame convention (60 Hz ticks): an attack started on tick T has stateFrame 1 on T, is active
// on stateFrame startup+1 .. startup+active, and the fighter acts again on tick T+total.
// hitstun/blockstun/thrown N lock the fighter for N ticks after hitstop ends.
import { BUFFER } from './fighter.js';

/** Fighter states. */
export const STATE = Object.freeze({
  IDLE: 'idle',
  WALK: 'walk',
  CROUCH: 'crouch',
  JUMP: 'jump',
  SIDESTEP: 'sidestep',
  ATTACK: 'attack',
  GUARD: 'guard',
  HITSTUN: 'hitstun',
  BLOCKSTUN: 'blockstun',
  THROWN: 'thrown',
  /** Broke out of a throw (both fighters): locked and pushed apart for rules.techFrames (see techReady). */
  TECH: 'tech',
  KO: 'ko',
});

/** Sub-phases of the attack state. */
export const PHASE = Object.freeze({ NONE: 'none', STARTUP: 'startup', ACTIVE: 'active', RECOVERY: 'recovery' });

const S = STATE;
const LOCO = [S.IDLE, S.WALK, S.CROUCH, S.JUMP, S.SIDESTEP];

function row(...targets) {
  const r = {};
  for (const t of targets) r[t] = true;
  return Object.freeze(r);
}

/**
 * Explicit transition table: TRANSITIONS[from][to] === true when legal. Anything else is
 * rejected by setState. Self-entries mark states that may re-enter (re-hit, repeated block).
 */
export const TRANSITIONS = Object.freeze({
  [S.IDLE]: row(...LOCO, S.ATTACK, S.GUARD, S.HITSTUN, S.THROWN, S.KO),
  [S.WALK]: row(...LOCO, S.ATTACK, S.GUARD, S.HITSTUN, S.THROWN, S.KO),
  [S.CROUCH]: row(...LOCO, S.ATTACK, S.GUARD, S.HITSTUN, S.THROWN, S.KO),
  // Airborne: no attacks, no guard, not throwable (presses stay buffered until landing).
  [S.JUMP]: row(...LOCO, S.HITSTUN, S.KO),
  // Past its cut a sidestep is actionable (sidestepCancellable): attack or guard, facing locked as ever.
  [S.SIDESTEP]: row(...LOCO, S.ATTACK, S.GUARD, S.HITSTUN, S.THROWN, S.KO),
  // A Light-string cancel (story-003 AC 3) swaps the move without leaving ATTACK: see chainAttack.
  [S.ATTACK]: row(S.IDLE, S.HITSTUN, S.THROWN, S.TECH, S.KO),
  [S.GUARD]: row(S.IDLE, S.WALK, S.CROUCH, S.ATTACK, S.BLOCKSTUN, S.HITSTUN, S.THROWN, S.KO),
  [S.HITSTUN]: row(S.IDLE, S.HITSTUN, S.KO),
  [S.BLOCKSTUN]: row(S.IDLE, S.BLOCKSTUN, S.HITSTUN, S.THROWN, S.KO),
  [S.THROWN]: row(S.IDLE, S.TECH, S.KO),
  // Hazards may still strike a fighter in tech; nothing grabs it, and it acts again from IDLE.
  [S.TECH]: row(S.IDLE, S.HITSTUN, S.KO),
  [S.KO]: row(),
});

/** States where asking for the current state again is a harmless no-op. */
const IDEMPOTENT = row(...LOCO, S.GUARD);
/** States from which a grounded fighter may start an attack or guard (a sidestep past its cut too). */
const ACTIONABLE = row(S.IDLE, S.WALK, S.CROUCH, S.GUARD);
const LOCO_SET = row(...LOCO);

/** @param {string} from @param {string} to */
export function canTransition(from, to) {
  const r = TRANSITIONS[from];
  return r !== undefined && r[to] === true;
}

/**
 * Move `f` to state `to` if the table allows it. Resets stateFrame; leaving ATTACK clears the move.
 * @returns {boolean} false (and no change) for an illegal transition
 */
export function setState(f, to) {
  if (f.state === to && IDEMPOTENT[to] === true) return true;
  if (!canTransition(f.state, to)) return false;
  f.state = to;
  f.stateFrame = 0;
  if (to !== S.ATTACK) {
    f.move = null;
    f.moveId = null;
  }
  return true;
}

/** Float slack for a sidestep clock that counts down in 1/60 s steps. */
const STEP_EPS = 1e-9;

/**
 * True when fighter `f` is in a sidestep it may cancel into an attack or guard: the step has run
 * sidestepCancelSeconds (its own kit's movement). A press before that stays buffered, and one more than
 * inputBufferFrames ticks before the cut ages out (the buffer is not extended for it).
 * Design: design/quick-specs/fight-systems-gap-2026-11-05.md P4.
 * @example sidestepCancellable(f) // true from 0.13 s into a 0.3 s step at the shared value
 * @param {Readonly<Record<string, any>>} f
 */
export function sidestepCancellable(f) {
  if (f.state !== S.SIDESTEP) return false;
  const m = f.movement;
  return m.sidestepDuration - f.sidestepT >= m.sidestepCancelSeconds - STEP_EPS;
}

/**
 * True while the throw holding `f` can still be broken: a techable throw holds it and fewer than
 * rules.throwTechWindow unfrozen ticks have run (the throw's hitstop does not count: stateFrame is frozen, and reads
 * 0 on the first unfrozen tick). The rule's window and the read a presentation layer needs (a throw's damage and
 * contact meter land at the connect and a tech refunds them, so anything shown before this goes false may be undone).
 * Read only. Design: design/quick-specs/fight-systems-gap-2026-11-05.md P2.
 * @example techWindowOpen(f, opp, sim.rules) // false again once the throw has really landed
 * @param {Readonly<Record<string, any>>} f the thrown fighter
 * @param {Readonly<Record<string, any>>} opp the thrower (a KO'd one leaves nothing to break free from)
 * @param {Readonly<Record<string, number>>} rules ruleset.rules
 */
export function techWindowOpen(f, opp, rules) {
  return f.state === S.THROWN && !!f.grabMove && f.stateFrame < rules.throwTechWindow && opp.state !== S.KO;
}

/**
 * True when thrown fighter `f` breaks the throw this tick: its tech window is open (techWindowOpen) and a Throw
 * press is buffered. Call on an unfrozen tick, before decideFighter (frozen ticks never reach it, so a press made
 * during the throw's hitstop waits for the window's first tick). A press from before the connect does not count:
 * duel-sim clears the buffer at the connect.
 * Design: design/quick-specs/fight-systems-gap-2026-11-05.md P2.
 * @example techReady(f, opp, sim.rules) // true when duel-sim should apply the tech
 * @param {Readonly<Record<string, any>>} f the thrown fighter
 * @param {Readonly<Record<string, any>>} opp the thrower
 * @param {Readonly<Record<string, number>>} rules ruleset.rules
 */
export function techReady(f, opp, rules) {
  return f.bufAction === BUFFER.THROW && techWindowOpen(f, opp, rules);
}

/**
 * True when fighter `f` Vents this tick: in its own blockstun with stun still to run, a Throw press buffered and
 * meter for the cost. Below the cost, or on the tick blockstun ends, the press stays the buffered throw it always
 * was. Call on an unfrozen tick, before decideFighter (so a press during hitstop or a super freeze waits).
 * Design: design/quick-specs/fight-systems-gap-2026-11-05.md P3.
 * @example ventReady(f, opp, sim.meter) // true when duel-sim should apply the Vent
 * @param {Readonly<Record<string, any>>} f the blocking fighter
 * @param {Readonly<Record<string, any>>} opp the fighter it would push (a KO'd one has nothing to answer)
 * @param {Readonly<Record<string, number>>} meter ruleset.meter
 */
export function ventReady(f, opp, meter) {
  return f.state === S.BLOCKSTUN && f.stunLeft > 0 && f.bufAction === BUFFER.THROW && f.meter >= meter.ventCost && opp.state !== S.KO;
}

/** Total ticks of a move. @param {import('./moves.js').MoveData} m */
export function moveTotal(m) {
  return m.startup + m.active + m.recovery;
}

/** Current attack phase of `f` (PHASE.NONE when not attacking). */
export function attackPhase(f) {
  if (f.state !== S.ATTACK) return PHASE.NONE;
  const n = f.stateFrame;
  const m = f.move;
  if (n <= m.startup) return PHASE.STARTUP;
  if (n <= m.startup + m.active) return PHASE.ACTIVE;
  return PHASE.RECOVERY;
}

/**
 * True when Overwind may be used: a full Wind meter and still standing (story-009 §3).
 * @example f.meter = f.meterMax; overwindReady(f) // true while f.hp > 0
 */
export function overwindReady(f) {
  return f.meter >= f.meterMax && f.hp > 0;
}

/**
 * True when `f` can pay move `m`'s meterCost now (a move without one is always affordable).
 * @example canAfford(f, f.moves.specialBack) // false while f.meter < specialBack.meterCost
 * @param {import('./moves.js').MoveData} m
 */
export function canAfford(f, m) {
  return m.meterCost === undefined || f.meter >= m.meterCost;
}

/** True while `f` performs its own Overwind, start through end of recovery (no meter gain). */
export function inOwnOverwind(f) {
  return f.state === S.ATTACK && f.moveId === f.moveInputs.overwind;
}

/**
 * Record this tick's button presses (runs during hitstop too, so presses are not lost).
 * @param {{light:boolean,heavy:boolean,throw:boolean,guard:boolean}} input
 */
export function bufferInput(f, input, rules) {
  let a = BUFFER.NONE;
  if (input.throw) a = BUFFER.THROW;
  else if (input.heavy) a = BUFFER.HEAVY;
  else if (input.light) a = BUFFER.LIGHT;
  if (a !== BUFFER.NONE) {
    f.bufAction = a;
    f.bufFrames = rules.inputBufferFrames;
    // Stick X at the press (story-009 §2); a down-diagonal never selects a special.
    f.bufDir = input.stick.y <= -f.movement.verticalThreshold ? 0 : input.stick.x;
  }
  f.guardHeld = input.guard;
}

/**
 * Move id the buffered press starts now, or null. Heavy resolves first match wins (story-009 §2):
 * Guard + full meter -> overwind; crouching -> crouchHeavy; bufDir >= +threshold -> specialForward;
 * bufDir <= -threshold -> specialBack; else heavy. A missing special id (greybox) or one whose
 * meterCost the fighter cannot pay falls to heavy.
 */
export function bufferedMoveId(f, meter) {
  const inputs = f.moveInputs;
  switch (f.bufAction) {
    case BUFFER.THROW:
      return inputs.throw;
    case BUFFER.HEAVY: {
      if (f.guardHeld && overwindReady(f)) return inputs.overwind;
      if (f.crouching) return inputs.crouchHeavy;
      const th = meter.specialDirThreshold;
      if (f.bufDir >= th && specialAvailable(f, inputs.specialForward)) return inputs.specialForward;
      if (f.bufDir <= -th && specialAvailable(f, inputs.specialBack)) return inputs.specialBack;
      return inputs.heavy;
    }
    case BUFFER.LIGHT:
      return f.crouching ? inputs.crouchLight : inputs.light;
    default:
      return null;
  }
}

/** A special id the kit has and the fighter can pay for now. */
function specialAvailable(f, id) {
  if (id === undefined) return false;
  const m = f.moves[id];
  return m !== undefined && canAfford(f, m);
}

/**
 * Move id the current attack chains into this tick, or null (story-003 AC 3). The chain move would
 * start on frame stateFrame+1 of the current move, which must lie inside move.cancel's window;
 * the trigger is a buffered Light press, and requiresContact needs the current attack to have
 * hit or been blocked.
 */
export function chainMoveId(f) {
  if (f.state !== S.ATTACK || f.bufAction !== BUFFER.LIGHT || !f.grounded) return null;
  const c = f.move.cancel;
  if (c === undefined) return null;
  const n = f.stateFrame + 1;
  if (n < c.from || n > c.to) return null;
  if (c.requiresContact && !f.attackHasHit) return null;
  return c.into;
}

/**
 * Start attack `moveId` from f.moves, facing the opponent; the facing stays locked for the attack.
 * @returns {boolean} false if the current state cannot attack
 */
export function startAttack(f, opp, moveId) {
  if (!setState(f, S.ATTACK)) return false;
  beginMove(f, opp, moveId);
  f.chainStep = 0;
  return true;
}

/**
 * Cancel the current attack into the next move of its Light string (story-003 AC 3). Stays in
 * ATTACK (not a state transition): the move, its frame counter and its hit flag restart.
 * @returns {boolean} false unless chainMoveId(f) allows this tick
 */
export function chainAttack(f, opp) {
  const next = chainMoveId(f);
  if (next === null) return false;
  const step = f.chainStep + 1;
  f.stateFrame = 0;
  beginMove(f, opp, next);
  f.chainStep = step;
  return true;
}

function beginMove(f, opp, moveId) {
  f.moveId = moveId;
  f.move = f.moves[moveId];
  f.attackHasHit = false;
  f.hitCounter = 0;
  f.armorLeft = f.move.armor === undefined ? 0 : f.move.armor.hits;
  const dx = opp.x - f.x;
  const dz = opp.z - f.z;
  const d = Math.hypot(dx, dz);
  if (d > 1e-6) {
    f.attackDirX = dx / d;
    f.attackDirZ = dz / d;
    f.attackYaw = Math.atan2(f.attackDirX, f.attackDirZ);
  } else {
    f.attackYaw = f.yaw;
    f.attackDirX = Math.sin(f.yaw);
    f.attackDirZ = Math.cos(f.yaw);
  }
  // Overwind spends the whole meter on frame 1, before the freeze (story-009 §3); a move with a
  // meterCost spends that much (clamped at 0) on the same tick.
  if (moveId === f.moveInputs.overwind) f.meter = 0;
  else if (f.move.meterCost !== undefined) f.meter = f.meter > f.move.meterCost ? f.meter - f.move.meterCost : 0;
  f.travelStopped = false;
  f.bufAction = BUFFER.NONE;
  f.bufFrames = 0;
}

/**
 * Decide this tick's state from timers and buffered input, then write f.intent (the movement
 * input this state allows).
 * @param {{stick:{x:number,y:number},sidestep:number}} input
 * @param {Readonly<Record<string, number>>} rules ruleset.rules @param {Readonly<Record<string, number>>} meter ruleset.meter
 */
export function decideFighter(f, opp, input, rules, meter) {
  const s = f.state;
  if (s === S.ATTACK) {
    if (f.stateFrame >= moveTotal(f.move)) setState(f, S.IDLE);
    else chainAttack(f, opp);
  } else if (s === S.HITSTUN || s === S.BLOCKSTUN || s === S.THROWN || s === S.TECH) {
    if (f.stunLeft <= 0) setState(f, S.IDLE);
  }

  const cut = sidestepCancellable(f);
  if ((ACTIONABLE[f.state] === true || cut) && f.grounded) {
    const id = bufferedMoveId(f, meter);
    // An unaffordable move (meterCost) is refused; the press stays buffered until it ages out.
    if (id !== null && canAfford(f, f.moves[id])) {
      if (cut) f.sidestepT = 0; // the arc stops: an attack out of a step lands from where the step reached
      startAttack(f, opp, id);
    } else if (f.guardHeld) {
      if (cut) f.sidestepT = 0;
      setState(f, S.GUARD);
    } else if (f.state === S.GUARD) setState(f, S.IDLE);
  }

  const it = f.intent;
  const st = it.stick;
  switch (f.state) {
    case S.IDLE:
    case S.WALK:
    case S.CROUCH:
    case S.JUMP:
    case S.SIDESTEP:
      st.x = input.stick.x;
      st.y = input.stick.y;
      it.sidestep = input.sidestep;
      break;
    case S.GUARD:
    case S.BLOCKSTUN:
      // Hold still; stick down = crouch guard. No jumping or sidestepping out of guard.
      st.x = 0;
      st.y = input.stick.y < 0 ? input.stick.y : 0;
      it.sidestep = 0;
      break;
    case S.ATTACK:
      st.x = 0;
      st.y = f.move.crouching ? -1 : 0;
      it.sidestep = 0;
      break;
    default:
      st.x = 0;
      st.y = 0;
      it.sidestep = 0;
  }
}

/**
 * After movement: restore the locked attack facing, derive locomotion states from the body,
 * count down timers, apply pushback and age the input buffer.
 */
export function advanceFighter(f, rules, mcfg) {
  if (f.state === S.ATTACK) {
    f.yaw = f.attackYaw;
  } else if (LOCO_SET[f.state] === true) {
    let to;
    if (!f.grounded) to = S.JUMP;
    else if (f.sidestepT > 0) to = S.SIDESTEP;
    else if (f.crouching) to = S.CROUCH;
    else if (f.intent.stick.x >= mcfg.deadzone || f.intent.stick.x <= -mcfg.deadzone) to = S.WALK;
    else to = S.IDLE;
    setState(f, to);
  } else if (f.state === S.HITSTUN || f.state === S.BLOCKSTUN || f.state === S.THROWN || f.state === S.TECH) {
    f.stunLeft--;
  }
  f.stateFrame++;

  if (f.pushFrames > 0) {
    const step = f.pushLeft / f.pushFrames;
    f.x += f.pushDirX * step;
    f.z += f.pushDirZ * step;
    f.pushLeft -= step;
    f.pushFrames--;
    const r = Math.hypot(f.x, f.z);
    if (r > mcfg.ringRadius) {
      const k = mcfg.ringRadius / r;
      f.x *= k;
      f.z *= k;
    }
  }

  if (f.bufFrames > 0 && --f.bufFrames === 0) f.bufAction = BUFFER.NONE;
}

/**
 * Push `f` away from `from` by `distance`, spread over rules.pushbackFrames ticks.
 */
export function startPushback(f, from, distance, rules) {
  let dx = f.x - from.x;
  let dz = f.z - from.z;
  const d = Math.hypot(dx, dz);
  if (d > 1e-6) {
    dx /= d;
    dz /= d;
  } else {
    dx = from.attackDirX;
    dz = from.attackDirZ;
  }
  f.pushDirX = dx;
  f.pushDirZ = dz;
  f.pushLeft = distance;
  f.pushFrames = distance > 0 ? rules.pushbackFrames : 0;
}


/**
 * Move travel (story-009 §4): on attack frames travel.from..to move `f` distance/(to-from+1) along
 * its locked attack direction. Reaching minSeparation from `opp` or the ring edge stops the travel
 * there and drops the rest. Call after advanceFighter (so stateFrame is this tick's attack frame).
 * @example applyTravel(f, opp, f.movement);
 */
export function applyTravel(f, opp, mcfg) {
  if (f.state !== S.ATTACK || f.travelStopped) return;
  const t = f.move.travel;
  if (t === undefined || f.stateFrame < t.from || f.stateFrame > t.to) return;
  let step = t.distance / (t.to - t.from + 1);
  const dx = f.attackDirX;
  const dz = f.attackDirZ;
  // Closest approach along the step: solve |q + dir * s| = minSeparation for the first s.
  const qx = f.x - opp.x;
  const qz = f.z - opp.z;
  const min = mcfg.minSeparation;
  const ex = qx + dx * step;
  const ez = qz + dz * step;
  if (ex * ex + ez * ez < min * min) {
    const b = qx * dx + qz * dz;
    const c = qx * qx + qz * qz - min * min;
    const disc = b * b - c;
    const s = disc > 0 ? -b - Math.sqrt(disc) : 0;
    step = Math.sign(step) * Math.max(0, Math.min(Math.abs(step), Math.abs(s)));
    f.travelStopped = true;
  }
  f.x += dx * step;
  f.z += dz * step;
  const r = Math.hypot(f.x, f.z);
  if (r > mcfg.ringRadius) {
    const k = mcfg.ringRadius / r;
    f.x *= k;
    f.z *= k;
    f.travelStopped = true;
  }
}

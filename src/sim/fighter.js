// Combat fighter = story-001 movement body + combat state (story-002). DOM/three-free.
// Also derives the fighter's hurtbox and its current attack's hitbox from data.
import { createFighter } from './movement.js';
import { createCylinder } from '../core/collision.js';
import { MOVE_INPUTS } from './moves.js';

/** Buffered button press. */
export const BUFFER = Object.freeze({ NONE: 0, LIGHT: 1, HEAVY: 2, THROW: 3 });

/**
 * Create a fighter with movement and combat fields. All per-tick scratch objects are
 * allocated here so the sim never allocates.
 * The ruleset supplies the hp (rules), the meter size (meter), and the fallback move table and
 * movement an un-equipped fighter uses until a kit is equipped.
 * @example const f = createCombatant(0, -1.5, 0, ruleset); f.hp === ruleset.rules.maxHp
 * @param {number} id 0 or 1
 * @param {number} x @param {number} z
 * @param {{rules: Readonly<Record<string, number>>, meter: Readonly<Record<string, number>>,
 *   moves: Readonly<Record<string, import('./moves.js').MoveData>>, movement: Readonly<Record<string, number>>}} ruleset
 */
export function createCombatant(id, x, z, ruleset) {
  const { rules, meter } = ruleset;
  const f = Object.assign(createFighter(x, z), {
    id,
    hp: rules.maxHp,
    maxHp: rules.maxHp,
    /**
     * Round-start HP multiplier (story-007 retry_bonus hook). resetCombatant sets
     * maxHp = round(rules.maxHp * startHpScale). 1 = normal; main.js sets it per match.
     */
    startHpScale: 1,
    /** One of STATE (state-machine.js). */
    state: 'idle',
    /** Ticks spent in the current state (attack: 1 on its first tick). */
    stateFrame: 0,
    /** Current attack id and data (null when not attacking). */
    moveId: /** @type {string|null} */ (null),
    move: /** @type {import('./moves.js').MoveData|null} */ (null),
    /** The current attack already connected (one hit per attack). */
    attackHasHit: false,
    /** COUNTER_TIER (duel-sim.js) of the current attack's hit; 0 until it lands a counter or punish. */
    hitCounter: 0,
    /** Armour hits left on the current attack (move.armor.hits at attack start; see moves.js). */
    armorLeft: 0,
    /** Position in a Light string: 0 = opener / plain attack, 1+ = chained hits (story-003 AC 3). */
    chainStep: 0,
    /** Facing locked at attack start (unit vector on the ground plane) and its yaw. */
    attackDirX: 1,
    attackDirZ: 0,
    attackYaw: 0,
    /** Remaining hitstun / blockstun / thrown / tech ticks. */
    stunLeft: 0,
    /**
     * The techable throw holding this fighter (null otherwise) and the Wind that throw's contact gave
     * each side; a tech undoes both the damage and the gains (design: fight-systems-gap P2).
     */
    grabMove: /** @type {import('./moves.js').MoveData|null} */ (null),
    grabGainSelf: 0,
    grabGainOpp: 0,
    /** Pushback still to apply, spread over pushFrames ticks along pushDir. */
    pushLeft: 0,
    pushFrames: 0,
    pushDirX: 0,
    pushDirZ: 0,
    bufAction: BUFFER.NONE,
    bufFrames: 0,
    /** Stick X (toward opponent +) at the buffered press; 0 for a down-diagonal (story-009 §2). */
    bufDir: 0,
    guardHeld: false,
    /**
     * Wind meter 0..meterMax (story-009 §3). Public state for the HUD. Carries across rounds:
     * resetCombatant leaves it; duel-sim resetMeters zeroes it (match start, rematch, training).
     */
    meter: 0,
    meterMax: meter.max,
    /** Wind a Vent spends (meter.ventCost), public like meterMax: the pilot reads it from the fighter. */
    ventCost: meter.ventCost,
    /** Attack frames of the current move's travel already blocked (rest of the distance dropped). */
    travelStopped: false,
    /** This fighter's move table and button -> move id map (story-003 swaps in per-fighter kits). */
    moves: ruleset.moves,
    moveInputs: MOVE_INPUTS,
    /** Movement config fed to stepFighter (story-003 AC 1: equipKit swaps in the kit's). */
    movement: ruleset.movement,
    /** Movement input the state machine allows this tick (fed to stepFighter). */
    intent: { stick: { x: 0, y: 0 }, sidestep: 0 },
    hurtbox: createCylinder(),
    hitbox: createCylinder(),
    /** Striking-limb hurtbox (story-003 AC 5): live while attacking with a kit (see hurtbox.js). */
    limbHurtbox: createCylinder(),
    limbHurtActive: false,
    /** Kit spec (fighter-data.js) set by equipKit; null = greybox fighter with the rules hurtbox. */
    spec: null,
    /** Sim-side pose scratch for joint-following hurtboxes (allocated by equipKit). */
    simPose: null,
    simPoseCtx: null,
  });
  return f;
}

/**
 * Restore full HP, neutral state and a start position (greybox round reset; story 005 owns rounds).
 * The Wind meter is NOT reset here: it carries across rounds (story-009 §3).
 * Full HP is rules.maxHp scaled by f.startHpScale (1 unless a retry_bonus match set it).
 * @example f.startHpScale = 1.2; resetCombatant(f, -1.5, 0, ruleset.rules); // f.hp === f.maxHp === 120 at maxHp 100
 * @param {ReturnType<typeof createCombatant>} f
 * @param {number} x @param {number} z
 * @param {Readonly<Record<string, number>>} rules ruleset.rules
 */
export function resetCombatant(f, x, z, rules) {
  f.x = f.prevX = x;
  f.z = f.prevZ = z;
  f.y = f.prevY = 0;
  f.vy = 0;
  f.grounded = true;
  f.airTime = 0;
  f.crouching = false;
  f.sidestepT = 0;
  f.sidestepDir = 0;
  f.hp = f.maxHp = Math.round(rules.maxHp * (f.startHpScale ?? 1));
  f.state = 'idle';
  f.stateFrame = 0;
  f.moveId = null;
  f.move = null;
  f.attackHasHit = false;
  f.hitCounter = 0;
  f.armorLeft = 0;
  f.chainStep = 0;
  f.limbHurtActive = false;
  f.stunLeft = 0;
  f.grabMove = null;
  f.grabGainSelf = 0;
  f.grabGainOpp = 0;
  f.pushLeft = 0;
  f.pushFrames = 0;
  f.bufAction = BUFFER.NONE;
  f.bufFrames = 0;
  f.bufDir = 0;
  f.guardHeld = false;
  f.travelStopped = false;
  f.intent.stick.x = 0;
  f.intent.stick.y = 0;
  f.intent.sidestep = 0;
}

/**
 * Write the fighter's hurtbox into f.hurtbox (crouching shortens it).
 * @example updateHurtbox(f, ruleset.rules).r === ruleset.rules.hurtRadius
 * @param {ReturnType<typeof createCombatant>} f
 * @param {Readonly<Record<string, number>>} rules ruleset.rules
 */
export function updateHurtbox(f, rules) {
  const h = f.hurtbox;
  h.x = f.x;
  h.z = f.z;
  h.r = rules.hurtRadius;
  h.y0 = f.y;
  h.y1 = f.y + (f.crouching ? rules.hurtHeightCrouch : rules.hurtHeightStand);
  return h;
}

/**
 * Write the current attack's hitbox into f.hitbox, ahead of the attacker along its locked facing.
 * @param {ReturnType<typeof createCombatant>} f fighter with a non-null move
 */
export function updateHitbox(f) {
  const hb = f.move.hitbox;
  const c = f.hitbox;
  c.x = f.x + f.attackDirX * hb.forward;
  c.z = f.z + f.attackDirZ * hb.forward;
  c.r = hb.radius;
  c.y0 = f.y + hb.yMin;
  c.y1 = f.y + hb.yMax;
  return c;
}

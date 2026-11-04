// CPU perception (story-004 AC 1, 3): copies only what a player can see of a fighter into a
// preallocated observation, and delays the opponent's observations by the level's reaction time.
// Pure, DOM-free, three-free, allocation-free per tick.
import { attackPhase, PHASE } from '../sim/state-machine.js';

/**
 * Public, on-screen view of one fighter. `move` is the frozen frame-data record of the attack
 * being performed (what the animation shows); hidden fields (input buffer, held buttons, stun
 * counters) are never copied.
 * @returns {{x:number,z:number,grounded:boolean,crouching:boolean,state:string,stateFrame:number,
 *   hp:number,maxHp:number,phase:string,moveId:string|null,move:import('../fighters/moves.js').MoveData|null,
 *   attackHasHit:boolean,frame:number}}
 */
export function createObservation() {
  return {
    x: 0, z: 0, grounded: true, crouching: false, state: 'idle', stateFrame: 0, hp: 0, maxHp: 0,
    phase: PHASE.NONE, moveId: null, move: null, attackHasHit: false, frame: -1,
  };
}

/**
 * Copy the visible state of fighter `f` into observation `o` (never writes to `f`).
 * @param {ReturnType<typeof createObservation>} o
 * @param {Readonly<Record<string, any>>} f combatant (read only)
 * @param {number} frame tick the observation was taken on
 */
export function observe(o, f, frame) {
  o.x = f.x;
  o.z = f.z;
  o.grounded = f.grounded;
  o.crouching = f.crouching;
  o.state = f.state;
  o.stateFrame = f.stateFrame;
  o.hp = f.hp;
  o.maxHp = f.maxHp;
  o.phase = attackPhase(f);
  o.moveId = f.moveId;
  o.move = f.move;
  o.attackHasHit = f.attackHasHit;
  o.frame = frame;
  return o;
}

/**
 * Ring buffer of observations: `push` records the present, `perceived` is what the CPU knows,
 * which is `delay` ticks old (or the oldest recorded one during the first `delay` ticks).
 */
export class DelayedView {
  /** @param {number} delay reaction frames (integer >= 0) */
  constructor(delay) {
    this.delay = delay;
    this.ring = [];
    for (let i = 0; i <= delay; i++) this.ring.push(createObservation());
    this.count = 0;
    this.perceived = this.ring[0];
  }

  /**
   * Record fighter `f` as seen this tick and update `perceived`.
   * @param {Readonly<Record<string, any>>} f
   */
  push(f) {
    const n = this.ring.length;
    observe(this.ring[this.count % n], f, this.count);
    const read = this.count >= this.delay ? this.count - this.delay : 0;
    this.perceived = this.ring[read % n];
    this.count++;
    return this.perceived;
  }

  /** Forget everything (round reset). */
  reset() {
    this.count = 0;
    this.perceived = this.ring[0];
  }
}

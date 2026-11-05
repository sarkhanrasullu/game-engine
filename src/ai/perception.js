// CPU perception (story-004 AC 1, 3): copies only what a player can see of a fighter into a
// preallocated observation, and delays the opponent's observations by the level's reaction time.
// Pure, DOM-free, three-free, allocation-free per tick.
import { attackPhase, PHASE } from '../sim/state-machine.js';
import { hazardTimeToActive } from '../sim/hazards.js';

/**
 * Public, on-screen view of one fighter. `move` is the frozen frame-data record of the attack
 * being performed (what the animation shows); hidden fields (input buffer, held buttons, stun
 * counters) are never copied. hitCounter is the current attack's counter tier (the on-screen call);
 * pushLeft is the slide still to come from a push already on screen.
 * @returns {{x:number,z:number,grounded:boolean,crouching:boolean,state:string,stateFrame:number,
 *   hp:number,maxHp:number,phase:string,moveId:string|null,move:import('../fighters/moves.js').MoveData|null,
 *   attackHasHit:boolean,hitCounter:number,pushLeft:number,frame:number}}
 */
export function createObservation() {
  return {
    x: 0, z: 0, grounded: true, crouching: false, state: 'idle', stateFrame: 0, hp: 0, maxHp: 0,
    phase: PHASE.NONE, moveId: null, move: null, attackHasHit: false, hitCounter: 0, pushLeft: 0, frame: -1,
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
  o.hitCounter = f.hitCounter;
  o.pushLeft = f.pushFrames > 0 ? f.pushLeft : 0;
  o.frame = frame;
  return o;
}

/**
 * Public, on-screen view of one stage hazard (hazards.js): its lane zone and how soon it hurts.
 * `visible` is false while the hazard is idle or its telegraph is younger than the CPU's reaction
 * delay; `inFrames` is 0 while the zone is active; `cycle` counts its telegraphs (a per-activation serial).
 * @returns {{id:string,x0:number,x1:number,y0:number,y1:number,inFrames:number,visible:boolean,cycle:number}}
 */
export function createHazardObservation() {
  return { id: '', x0: 0, x1: 0, y0: 0, y1: 0, inFrames: -1, visible: false, cycle: 0 };
}

/**
 * Copy what a player can see of the sim's hazards into `list` (preallocated observations, one slot
 * per hazard, same order as `hazards`), `delay` ticks late: a telegraph is seen once it has been
 * showing for `delay` ticks, an active zone always. Never writes to `hazards`; allocation-free.
 * @example const n = observeHazards(zones, sim.hazards, difficulty.reactionFrames); // zones[i].visible
 * @param {ReturnType<typeof createHazardObservation>[]} list
 * @param {ReadonlyArray<Readonly<Record<string, any>>>} hazards sim.hazards (read only)
 * @param {number} delay reaction frames
 * @returns {number} slots written: min(hazards.length, list.length)
 */
export function observeHazards(list, hazards, delay) {
  const n = hazards.length < list.length ? hazards.length : list.length;
  for (let i = 0; i < n; i++) {
    const h = hazards[i];
    const o = list[i];
    const z = h.data.zone;
    const t = hazardTimeToActive(h);
    o.id = h.data.id;
    o.x0 = z.x0;
    o.x1 = z.x1;
    o.y0 = z.y0;
    o.y1 = z.y1;
    o.cycle = h.cycle;
    o.inFrames = t;
    o.visible = t === 0 || (t > 0 && h.data.telegraphFrames - h.left >= delay);
  }
  return n;
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

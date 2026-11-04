// Training-mode frame data (pocket-ready/008, design/milestone-2-brief.md Revision 2; story AC 2, 4).
// Pure: no DOM, no three.js. Reads only the sim's public state (fighter state, stateFrame, move)
// and its presentation events. Every frame value comes from the fighter's move data (the game's
// kit / tuning data); nothing here duplicates a number.
//
// Advantage derivation (state-machine.js frame convention): a strike that connects when the
// attacker's stateFrame is n leaves the attacker (total - n) more ticks of its move, while the
// defender is locked for `stun` ticks (hitstun / blockstun / thrownFrames). Hitstop freezes both
// equally. Both become actionable on the tick their counter runs out, so
//   advantage = stun - (total - n)        (+ = attacker acts first)
// tests/core/frame-data.test.js checks this against the sim tick by tick.
import { EVENT } from './duel-sim.js';
import { STATE, moveTotal } from './state-machine.js';

/** Outcome of the last tracked move. */
export const OUTCOME = Object.freeze({
  PENDING: 'pending',
  WHIFF: 'whiff',
  HIT: 'hit',
  BLOCK: 'block',
  THROW: 'throw',
  ARMOR: 'armor',
  TRADE: 'trade',
});

/**
 * Frame advantage of move `move` connecting on attacker stateFrame `contactFrame`.
 * @param {{startup:number,active:number,recovery:number,hitstun:number,blockstun:number,thrownFrames:number,level:string}} move
 * @param {number} contactFrame attacker stateFrame on the contact tick (startup+1 .. startup+active)
 * @param {'hit'|'block'} outcome
 * @returns {number} + = attacker recovers first
 */
export function frameAdvantage(move, contactFrame, outcome) {
  const stun = outcome === 'block' ? move.blockstun : move.level === 'throw' ? move.thrownFrames : move.hitstun;
  return stun - (moveTotal(move) - contactFrame);
}

const isStun = (s) => s === STATE.HITSTUN || s === STATE.THROWN;

/**
 * Observes one fighter's moves from the sim and keeps the overlay's numbers. Call `observe(sim)`
 * after every stepDuel (frozen hitstop ticks included). `version` bumps whenever a shown value
 * changes, so a view can skip unchanged frames. Allocation-free per tick.
 */
export class FrameDataTracker {
  /** @param {number} [playerId] fighter index whose moves are tracked */
  constructor(playerId = 0) {
    this.playerId = playerId;
    this.version = 0;
    this.reset();
  }

  /** Forget everything (training reset). */
  reset() {
    /** Move id / display name of the last started move ('' = none yet). */
    this.moveId = '';
    this.moveName = '';
    this.startup = 0;
    this.active = 0;
    this.recovery = 0;
    /** Static advantage from the move data, assuming contact on the first active frame. */
    this.onHit = 0;
    this.onBlock = 0;
    this.outcome = OUTCOME.PENDING;
    /** Advantage of the actual contact (its real active frame); null when not meaningful. */
    this.advantage = null;
    /** Damage of the last connecting hit. */
    this.damage = 0;
    /** Current / last combo: hits and total damage. */
    this.comboHits = 0;
    this.comboDamage = 0;
    this.prevState = '';
    this.prevFrame = 0;
    /** Attack stateFrame seen on the previous observe (0 when not attacking). */
    this.attackFrame = 0;
    /** True when the defender was still locked in hitstun/thrown going into this tick. */
    this.defenderLocked = false;
    this.version++;
  }

  /**
   * Read one tick's state and events.
   * @param {ReturnType<typeof import('../fighters/duel-sim.js').createDuel>} sim
   */
  observe(sim) {
    const f = sim.fighters[this.playerId];
    const d = sim.fighters[1 - this.playerId];
    // A move starts on the tick its stateFrame reads 1 (startAttack or a chain cancel).
    if (f.state === STATE.ATTACK && f.stateFrame === 1 && !(this.prevState === STATE.ATTACK && this.prevFrame === 1)) {
      this.startMove(f);
    }
    let hitMe = false;
    for (let i = 0; i < sim.eventCount; i++) {
      const e = sim.events[i];
      if (e.defender === this.playerId && (e.type === EVENT.HIT || e.type === EVENT.THROW)) hitMe = true;
    }
    for (let i = 0; i < sim.eventCount; i++) {
      const e = sim.events[i];
      if (e.attacker !== this.playerId || e.type === EVENT.KO) continue;
      this.onContact(f, e, hitMe);
    }
    if (this.outcome === OUTCOME.PENDING && f.state !== STATE.ATTACK && this.prevState === STATE.ATTACK) {
      this.outcome = OUTCOME.WHIFF;
      this.version++;
    }
    this.prevState = f.state;
    this.prevFrame = f.stateFrame;
    this.attackFrame = f.state === STATE.ATTACK ? f.stateFrame : 0;
    this.defenderLocked = isStun(d.state) && d.stunLeft > 0;
  }

  /** @private */
  startMove(f) {
    const m = f.move;
    this.moveId = f.moveId;
    this.moveName = m.name ?? f.moveId;
    this.startup = m.startup;
    this.active = m.active;
    this.recovery = m.recovery;
    this.onHit = frameAdvantage(m, m.startup + 1, 'hit');
    this.onBlock = m.level === 'throw' ? null : frameAdvantage(m, m.startup + 1, 'block');
    this.outcome = OUTCOME.PENDING;
    this.advantage = null;
    this.version++;
  }

  /** @private */
  onContact(f, e, hitMe) {
    // The move that connected is the one this tracker last started (events carry its id).
    const m = f.moves[e.moveId];
    // Contact tick: the attacker advanced once since the last observe. If a trade knocked it out
    // of ATTACK this tick, derive the frame from the previous observation.
    const n = f.state === STATE.ATTACK && f.moveId === e.moveId ? f.stateFrame : this.attackFrame + 1;
    if (e.type === EVENT.BLOCK) {
      this.outcome = OUTCOME.BLOCK;
      this.advantage = frameAdvantage(m, n, 'block');
    } else {
      const armored = e.armor === 1;
      this.outcome = armored ? OUTCOME.ARMOR : hitMe ? OUTCOME.TRADE : e.type === EVENT.THROW ? OUTCOME.THROW : OUTCOME.HIT;
      this.advantage = armored || hitMe ? null : frameAdvantage(m, n, 'hit');
      this.damage = e.damage;
      if (!armored && this.defenderLocked) {
        this.comboHits++;
        this.comboDamage += e.damage;
      } else {
        this.comboHits = 1;
        this.comboDamage = e.damage;
      }
    }
    this.version++;
  }
}

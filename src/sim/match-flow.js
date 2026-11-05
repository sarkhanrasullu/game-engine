// Round and match flow state machine (best-of-N rounds; e.g. best of 3: losing 2 rounds loses).
// Pure: no DOM, no three.js, no wall clock. Time comes only from the `dt` passed to update()
// (the injected clock), so the flow is deterministic and runs under node:test.
//
// Transition table (anything not listed is ignored):
//   IDLE      --startMatch()------------------------> INTRO      (MATCH_START, ROUND_START)
//   RESULT    --rematch() / startMatch()------------> INTRO      (MATCH_START, ROUND_START)
//   INTRO     --introSeconds elapsed----------------> FIGHT      (FIGHT)
//   FIGHT     --a fighter at 0 HP, or timer at 0----> ROUND_END  (ROUND_END)
//   ROUND_END --roundEndSeconds, match undecided----> INTRO      (ROUND_START)
//   ROUND_END --roundEndSeconds, match decided------> MATCH_END  (MATCH_END = onMatchEnd hook)
//   MATCH_END --matchEndSeconds elapsed-------------> RESULT
// Inputs are live only in FIGHT. Per-tick update() allocates nothing.

/** Flow states. */
export const MATCH_STATE = Object.freeze({
  IDLE: 'idle', INTRO: 'intro', FIGHT: 'fight', ROUND_END: 'round_end', MATCH_END: 'match_end', RESULT: 'result',
});

/** Events emitted through MatchFlow#on. */
export const MATCH_EVENT = Object.freeze({
  /** payload: settings (difficulty, fighter, ...) for the match that is starting */
  MATCH_START: 'matchStart',
  /** payload: round number (1-based); the host resets positions, HP and the CPU here */
  ROUND_START: 'roundStart',
  /** payload: round number; inputs unlock */
  FIGHT: 'fight',
  /** payload: { round, winner: 0|1|-1, reason: 'ko'|'hazard'|'time', wins } */
  ROUND_END: 'roundEnd',
  /** payload: match result (see MatchFlow#result); the AdService (story 007) listens here */
  MATCH_END: 'matchEnd',
});

/**
 * Why a round ended. HAZARD is a KO scored by a stage hazard (hazards.js; the host passes it to
 * update() from `sim.koBy`): it counts as a KO everywhere (slow-mo, isKoReason), the HUD may call it.
 */
export const ROUND_REASON = Object.freeze({ KO: 'ko', HAZARD: 'hazard', TIME: 'time' });

/**
 * True for the reasons that are a knockout (KO by a fighter or by a hazard), false for a time-out.
 * @example if (isKoReason(r.reason)) view.finalKo();
 * @param {string} reason a ROUND_REASON
 */
export function isKoReason(reason) {
  return reason === ROUND_REASON.KO || reason === ROUND_REASON.HAZARD;
}

/**
 * Winner of a round from the two HP fractions (0..1): 0 or 1, -1 for a draw (double KO, or
 * equal HP% at time-out), null while the round is still on. A KO decides even on the tick the
 * timer runs out. Allocation-free (called every tick).
 * @param {number} hp0 fighter 0 HP / maxHp
 * @param {number} hp1 fighter 1 HP / maxHp
 * @param {boolean} timeUp the round timer has reached 0
 * @returns {null | 0 | 1 | -1}
 */
export function roundWinner(hp0, hp1, timeUp) {
  const ko0 = hp0 <= 0;
  const ko1 = hp1 <= 0;
  if (ko0 || ko1) return ko0 && ko1 ? -1 : ko1 ? 0 : 1;
  if (!timeUp) return null;
  return hp0 > hp1 ? 0 : hp1 > hp0 ? 1 : -1;
}

/** Best-of-N match flow: wind-up intro, timed rounds, KO slow-mo, result and rematch. */
export class MatchFlow {
  /**
   * @example const flow = new MatchFlow({ rules: ruleset.round }); flow.startMatch();
   * @param {object} opts
   * @param {Readonly<Record<string, number>>} opts.rules round rules (ruleset.round, or a table from buildRoundRules)
   * @param {((result: object) => void) | null} [opts.onMatchEnd] match-end hook (same as on(MATCH_EVENT.MATCH_END, fn))
   */
  constructor({ rules, onMatchEnd = null }) {
    this.rules = rules;
    /** @type {Map<string, Array<(payload: any) => void>>} */
    this.listeners = new Map();
    if (onMatchEnd) this.on(MATCH_EVENT.MATCH_END, onMatchEnd);
    /** Settings of the current (or last) match; changed only when a match starts. */
    this.settings = Object.freeze({});
    this.state = MATCH_STATE.IDLE;
    /** Seconds spent in the current state. */
    this.stateTime = 0;
    /** Current round, 1-based (0 before the first match). */
    this.round = 0;
    /** Round wins per fighter. */
    this.wins = [0, 0];
    /** Round timer, seconds remaining. */
    this.timeLeft = rules.roundSeconds;
    /** Outcome of the last finished round, or null. */
    this.lastRound = null;
    /** Seconds since the match started (intro of round 1) until the match ended. */
    this.durationSec = 0;
    /** Result of the last finished match, or null. */
    this.result = null;
  }

  /**
   * Subscribe to a MATCH_EVENT. Returns an unsubscribe function.
   * @param {string} type
   * @param {(payload: any) => void} fn
   */
  on(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    const list = this.listeners.get(type);
    list.push(fn);
    return () => {
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    };
  }

  /** @param {string} type @param {any} payload */
  emit(type, payload) {
    const list = this.listeners.get(type);
    if (!list) return;
    for (const fn of list.slice()) fn(payload);
  }

  /**
   * Start a fresh match (from IDLE or RESULT). `settings` replaces the previous settings.
   * @param {Record<string, unknown>} [settings] e.g. { difficulty: 'normal', fighter: 'a' }
   */
  startMatch(settings = this.settings) {
    if (this.state !== MATCH_STATE.IDLE && this.state !== MATCH_STATE.RESULT) {
      throw new Error(`startMatch: not allowed in state ${this.state}`);
    }
    this.settings = Object.freeze({ ...settings });
    this.wins[0] = 0;
    this.wins[1] = 0;
    this.round = 0;
    this.durationSec = 0;
    this.lastRound = null;
    this.result = null;
    this.emit(MATCH_EVENT.MATCH_START, this.settings);
    this.beginRound();
  }

  /**
   * One-tap rematch from the result screen: same settings, with `changes` applied on top
   * (e.g. a difficulty picked on the result screen).
   * @param {Record<string, unknown>} [changes]
   */
  rematch(changes = {}) {
    if (this.state !== MATCH_STATE.RESULT) throw new Error(`rematch: not allowed in state ${this.state}`);
    this.startMatch({ ...this.settings, ...changes });
  }

  /** True only while fighting: intro, round end and result screens lock inputs. */
  get inputsLive() {
    return this.state === MATCH_STATE.FIGHT;
  }

  /** Sim time scale: koSlowMoScale just after a KO, else 1. */
  get timeScale() {
    return this.state === MATCH_STATE.ROUND_END && isKoReason(this.lastRound.reason)
      && this.stateTime < this.rules.koSlowMoSeconds ? this.rules.koSlowMoScale : 1;
  }

  /** Whole seconds shown on the round timer. */
  get secondsLeft() {
    return Math.max(0, Math.ceil(this.timeLeft - 1e-9));
  }

  /** Countdown number during the intro (e.g. 3, 2, 1), else 0. */
  get introCount() {
    if (this.state !== MATCH_STATE.INTRO) return 0;
    return Math.max(1, Math.ceil(this.rules.introSeconds - this.stateTime - 1e-9));
  }

  /**
   * Advance the flow by `dt` seconds of real time. Call once per sim tick, after the sim step.
   * @example flow.update(dt, p1.hp / p1.maxHp, p2.hp / p2.maxHp, sim.koBy === KO_BY.HAZARD ? ROUND_REASON.HAZARD : ROUND_REASON.KO);
   * @param {number} dt seconds
   * @param {number} hp0 fighter 0 HP fraction (hp / maxHp)
   * @param {number} hp1 fighter 1 HP fraction
   * @param {string} [koReason] reason recorded if a fighter is at 0 HP this tick: ROUND_REASON.KO
   *   (default) or ROUND_REASON.HAZARD when a stage hazard scored the KO (sim.koBy)
   */
  update(dt, hp0, hp1, koReason = ROUND_REASON.KO) {
    const s = this.state;
    if (s === MATCH_STATE.IDLE || s === MATCH_STATE.RESULT) return;
    if (s !== MATCH_STATE.MATCH_END) this.durationSec += dt;
    this.stateTime += dt;
    const r = this.rules;
    if (s === MATCH_STATE.INTRO) {
      if (this.stateTime >= r.introSeconds) {
        this.setState(MATCH_STATE.FIGHT);
        this.emit(MATCH_EVENT.FIGHT, this.round);
      }
    } else if (s === MATCH_STATE.FIGHT) {
      this.timeLeft = Math.max(0, this.timeLeft - dt);
      const winner = roundWinner(hp0, hp1, this.timeLeft <= 0);
      if (winner !== null) this.endRound(winner, hp0 <= 0 || hp1 <= 0 ? koReason : ROUND_REASON.TIME);
    } else if (s === MATCH_STATE.ROUND_END) {
      if (this.stateTime >= r.roundEndSeconds) {
        if (this.matchWinner() === null) this.beginRound();
        else this.endMatch();
      }
    } else if (s === MATCH_STATE.MATCH_END) {
      if (this.stateTime >= r.matchEndSeconds) this.setState(MATCH_STATE.RESULT);
    }
  }

  /**
   * Match outcome from the current score, or null while undecided: 0 / 1 for a winner, -1 for a
   * drawn match (only possible at maxRounds).
   * @returns {null | 0 | 1 | -1}
   */
  matchWinner() {
    const [w0, w1] = this.wins;
    const need = this.rules.roundsToWin;
    if ((w0 >= need || w1 >= need) && w0 !== w1) return w0 > w1 ? 0 : 1;
    if (this.round >= this.rules.maxRounds) return w0 > w1 ? 0 : w1 > w0 ? 1 : -1;
    return null;
  }

  /** @private */
  setState(state) {
    this.state = state;
    this.stateTime = 0;
  }

  /** @private */
  beginRound() {
    this.round++;
    this.timeLeft = this.rules.roundSeconds;
    this.setState(MATCH_STATE.INTRO);
    this.emit(MATCH_EVENT.ROUND_START, this.round);
  }

  /** @private */
  endRound(winner, reason) {
    if (winner >= 0) this.wins[winner]++;
    else if (this.rules.drawScoresBoth === 1) { this.wins[0]++; this.wins[1]++; }
    this.lastRound = Object.freeze({ round: this.round, winner, reason, wins: Object.freeze([...this.wins]) });
    this.setState(MATCH_STATE.ROUND_END);
    this.emit(MATCH_EVENT.ROUND_END, this.lastRound);
  }

  /** @private */
  endMatch() {
    const winner = this.matchWinner();
    this.result = Object.freeze({
      /** Player 1 (fighter 0) won the match. */
      won: winner === 0,
      draw: winner === -1,
      winner,
      wins: Object.freeze([...this.wins]),
      rounds: this.round,
      durationSec: this.durationSec,
      settings: this.settings,
    });
    this.setState(MATCH_STATE.MATCH_END);
    this.emit(MATCH_EVENT.MATCH_END, this.result);
  }
}

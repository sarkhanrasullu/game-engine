// Story-005 round/match flow: wind-up intro, timer, KO/time-out, draws, Bo3, rematch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import COMBAT from '../fixtures/combat_tuning.json' with { type: 'json' };
import { MatchFlow, MATCH_STATE, MATCH_EVENT, ROUND_REASON, roundWinner } from '../fixtures/bound/match-flow.js';
import { ROUND_RULES, ROUND_KEYS, buildRoundRules } from '../fixtures/bound/match-config.js';

const DT = 1 / 60;
const RULES = buildRoundRules({
  roundsToWin: 2, maxRounds: 5, drawScoresBoth: 1, introSeconds: 3, roundSeconds: 60,
  koSlowMoSeconds: 1, koSlowMoScale: 0.25, roundEndSeconds: 2, matchEndSeconds: 1,
});

function make(rules = RULES) {
  const flow = new MatchFlow({ rules });
  const log = [];
  for (const type of Object.values(MATCH_EVENT)) flow.on(type, (p) => log.push([type, p]));
  return { flow, log };
}

/** Run `seconds` of ticks with fixed HP fractions. */
function run(flow, seconds, hp0 = 1, hp1 = 1) {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) flow.update(DT, hp0, hp1);
}

/** From the start of a round's intro, play it to the next INTRO/MATCH_END with a KO by `winner`. */
function koRound(flow, winner) {
  run(flow, RULES.introSeconds + DT);
  assert.equal(flow.state, MATCH_STATE.FIGHT);
  if (winner === -1) flow.update(DT, 0, 0);
  else flow.update(DT, winner === 0 ? 1 : 0, winner === 1 ? 1 : 0);
  assert.equal(flow.state, MATCH_STATE.ROUND_END);
  run(flow, RULES.roundEndSeconds + DT);
}

test('round rules load from combat_tuning.json and reject bad data', () => {
  for (const k of ROUND_KEYS) assert.equal(ROUND_RULES[k], COMBAT.round[k], k);
  assert.equal(ROUND_RULES.roundsToWin, 2);
  assert.equal(ROUND_RULES.roundSeconds, 60);
  assert.throws(() => buildRoundRules({ ...COMBAT.round, roundTime: 60 }), /unknown key/);
  assert.throws(() => buildRoundRules({ ...COMBAT.round, drawScoresBoth: 2 }), /drawScoresBoth/);
  assert.throws(() => buildRoundRules({ ...COMBAT.round, maxRounds: 2 }), /maxRounds/);
  assert.throws(() => buildRoundRules({ ...COMBAT.round, koSlowMoScale: 0 }), /koSlowMoScale/);
});

test('roundWinner: KO, double KO, time-out by HP%, equal HP% draw', () => {
  assert.equal(roundWinner(0.5, 0.4, false), null);
  assert.equal(roundWinner(0.5, 0, false), 0);
  assert.equal(roundWinner(0, 0.2, false), 1);
  assert.equal(roundWinner(0, 0, false), -1);
  assert.equal(roundWinner(0.5, 0.4, true), 0);
  assert.equal(roundWinner(0.3, 0.9, true), 1);
  assert.equal(roundWinner(0.5, 0.5, true), -1);
  assert.equal(roundWinner(0, 0.9, true), 1, 'KO decides on the time-up tick');
});

test('intro counts 3-2-1 with inputs locked, then FIGHT unlocks inputs', () => {
  const { flow, log } = make();
  assert.equal(flow.inputsLive, false);
  flow.startMatch({ difficulty: 'normal' });
  assert.deepEqual(log.map((e) => e[0]), [MATCH_EVENT.MATCH_START, MATCH_EVENT.ROUND_START]);
  assert.equal(flow.state, MATCH_STATE.INTRO);
  const counts = new Set();
  for (let i = 0; i < Math.round(RULES.introSeconds / DT) - 1; i++) {
    flow.update(DT, 1, 1);
    assert.equal(flow.inputsLive, false);
    counts.add(flow.introCount);
  }
  assert.deepEqual([...counts], [3, 2, 1]);
  run(flow, 2 * DT);
  assert.equal(flow.state, MATCH_STATE.FIGHT);
  assert.equal(flow.inputsLive, true);
  assert.equal(log.at(-1)[0], MATCH_EVENT.FIGHT);
});

test('timer expiry: higher HP% wins the round, timer shows whole seconds', () => {
  const { flow } = make();
  flow.startMatch();
  run(flow, RULES.introSeconds + DT);
  assert.equal(flow.secondsLeft, 60);
  run(flow, 0.5, 0.7, 0.6);
  assert.equal(flow.secondsLeft, 60);
  run(flow, 59.4, 0.7, 0.6);
  assert.equal(flow.state, MATCH_STATE.FIGHT);
  assert.equal(flow.secondsLeft, 1);
  run(flow, 0.2, 0.7, 0.6);
  assert.equal(flow.state, MATCH_STATE.ROUND_END);
  assert.equal(flow.secondsLeft, 0);
  assert.deepEqual({ ...flow.lastRound, wins: [...flow.lastRound.wins] },
    { round: 1, winner: 0, reason: ROUND_REASON.TIME, wins: [1, 0] });
  assert.equal(flow.inputsLive, false);
  assert.equal(flow.timeScale, 1, 'no slow-mo on a time-out');
});

test('equal HP% at time-out is a draw; the data rule picks both-score or neither', () => {
  for (const both of [1, 0]) {
    const { flow } = make(buildRoundRules({ ...RULES, drawScoresBoth: both }));
    flow.startMatch();
    run(flow, RULES.introSeconds + DT);
    run(flow, 61, 0.4, 0.4);
    assert.equal(flow.lastRound.winner, -1);
    assert.deepEqual(flow.wins, both ? [1, 1] : [0, 0]);
  }
});

test('KO slows the sim for koSlowMoSeconds, then the next round resets the timer', () => {
  const { flow, log } = make();
  flow.startMatch();
  run(flow, RULES.introSeconds + DT);
  run(flow, 10, 0.8, 0.8);
  flow.update(DT, 0.8, 0);
  assert.equal(flow.lastRound.reason, ROUND_REASON.KO);
  assert.equal(flow.timeScale, RULES.koSlowMoScale);
  run(flow, RULES.koSlowMoSeconds + DT);
  assert.equal(flow.timeScale, 1);
  assert.equal(flow.state, MATCH_STATE.ROUND_END);
  run(flow, RULES.roundEndSeconds);
  assert.equal(flow.state, MATCH_STATE.INTRO);
  assert.equal(flow.round, 2);
  assert.equal(flow.timeLeft, RULES.roundSeconds);
  assert.deepEqual(log.filter((e) => e[0] === MATCH_EVENT.ROUND_START).map((e) => e[1]), [1, 2]);
});

test('Bo3: first to 2 round wins takes the match; losing 2 is the fail state', () => {
  const { flow, log } = make();
  flow.startMatch({ difficulty: 'hard' });
  koRound(flow, 1);
  koRound(flow, 0);
  assert.equal(flow.state, MATCH_STATE.INTRO);
  assert.equal(flow.round, 3);
  koRound(flow, 1);
  assert.equal(flow.state, MATCH_STATE.MATCH_END);
  const end = log.filter((e) => e[0] === MATCH_EVENT.MATCH_END);
  assert.equal(end.length, 1);
  const r = end[0][1];
  assert.equal(r.won, false);
  assert.equal(r.draw, false);
  assert.equal(r.winner, 1);
  assert.deepEqual([...r.wins], [1, 2]);
  assert.equal(r.rounds, 3);
  assert.equal(r.settings.difficulty, 'hard');
  run(flow, RULES.matchEndSeconds + DT);
  assert.equal(flow.state, MATCH_STATE.RESULT);
  run(flow, 5);
  assert.equal(flow.state, MATCH_STATE.RESULT, 'result waits for a tap');
});

test('2-0 ends after two rounds; onMatchEnd hook gets {won, durationSec}', () => {
  const results = [];
  const flow = new MatchFlow({ rules: RULES, onMatchEnd: (r) => results.push(r) });
  flow.startMatch();
  koRound(flow, 0);
  koRound(flow, 0);
  assert.equal(results.length, 1);
  assert.equal(results[0].won, true);
  assert.equal(results[0].rounds, 2);
  // Two rounds of intro + roundEnd hold, plus the few fight / boundary ticks of each round.
  const expected = 2 * (RULES.introSeconds + RULES.roundEndSeconds);
  assert.ok(Math.abs(results[0].durationSec - expected) < 0.2, `durationSec=${results[0].durationSec}`);
});

test('draw at 1-1 (both score) makes 2-2, a sudden-death round decides', () => {
  const { flow } = make();
  flow.startMatch();
  koRound(flow, 0);
  koRound(flow, 1);
  koRound(flow, -1);
  assert.deepEqual(flow.wins, [2, 2]);
  assert.equal(flow.state, MATCH_STATE.INTRO);
  koRound(flow, 0);
  assert.equal(flow.state, MATCH_STATE.MATCH_END);
  assert.equal(flow.result.won, true);
  assert.equal(flow.result.rounds, 4);
});

test('draws to the maxRounds cap end in a drawn match', () => {
  const { flow } = make(buildRoundRules({ ...RULES, drawScoresBoth: 0, maxRounds: 3 }));
  flow.startMatch();
  koRound(flow, -1);
  koRound(flow, 0);
  koRound(flow, 1);
  assert.equal(flow.state, MATCH_STATE.MATCH_END);
  assert.equal(flow.result.draw, true);
  assert.equal(flow.result.won, false);
  assert.equal(flow.result.winner, -1);
});

test('rematch resets score, round and timer, keeps settings, and applies a new difficulty', () => {
  const { flow, log } = make();
  assert.throws(() => flow.rematch(), /rematch/);
  flow.startMatch({ difficulty: 'easy', fighter: 'guest' });
  assert.throws(() => flow.startMatch(), /startMatch/);
  koRound(flow, 0);
  koRound(flow, 0);
  run(flow, RULES.matchEndSeconds + DT);
  assert.equal(flow.state, MATCH_STATE.RESULT);

  log.length = 0;
  flow.rematch();
  assert.deepEqual(log.map((e) => e[0]), [MATCH_EVENT.MATCH_START, MATCH_EVENT.ROUND_START]);
  assert.deepEqual({ ...log[0][1] }, { difficulty: 'easy', fighter: 'guest' });
  assert.deepEqual(flow.wins, [0, 0]);
  assert.equal(flow.round, 1);
  assert.equal(flow.timeLeft, RULES.roundSeconds);
  assert.equal(flow.result, null);
  assert.equal(flow.durationSec, 0);
  assert.equal(flow.state, MATCH_STATE.INTRO);

  koRound(flow, 1);
  koRound(flow, 1);
  run(flow, RULES.matchEndSeconds + DT);
  log.length = 0;
  flow.rematch({ difficulty: 'hard' });
  assert.deepEqual({ ...log[0][1] }, { difficulty: 'hard', fighter: 'guest' });
  assert.equal(flow.settings.difficulty, 'hard');
});

test('difficulty only changes when a match starts', () => {
  const { flow } = make();
  flow.startMatch({ difficulty: 'normal' });
  assert.throws(() => flow.rematch({ difficulty: 'hard' }));
  assert.equal(flow.settings.difficulty, 'normal');
});

test('update in IDLE does nothing', () => {
  const { flow, log } = make();
  run(flow, 5);
  assert.equal(flow.state, MATCH_STATE.IDLE);
  assert.equal(log.length, 0);
});

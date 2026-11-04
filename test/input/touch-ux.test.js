// story-003: gameplay items of production/ux/touch-ux-review-2026-11-04.md (changes 2, 5, 6, 8, 9, 10).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InputState, DoubleTapDetector, createSnapshot, KEY_BINDINGS } from '../fixtures/bound/input-snapshot.js';
import { INPUT_CONFIG, resolveHandedness, stickZoneSide } from '../fixtures/bound/input-config.js';
import { clampStickOrigin, stickZoneRect } from '../../src/input/touch-stick.js';

const sampleAt = (inp, t) => inp.sample(createSnapshot(), t);

test('config carries the review values', () => {
  assert.equal(INPUT_CONFIG.throwWindowMs, 50);
  assert.equal(INPUT_CONFIG.touchThrowChord, false);
  assert.equal(INPUT_CONFIG.stickDeadZone, 0.15);
  assert.equal(INPUT_CONFIG.stickTapThreshold, 0.65);
  assert.equal(INPUT_CONFIG.stickTapReleaseThreshold, 0.45);
  assert.equal(INPUT_CONFIG.doubleTapWindowMs, 300);
  assert.equal(INPUT_CONFIG.handedness, 'right');
});

test('pressThrow latches throw for exactly one sample', () => {
  const inp = new InputState();
  inp.pressThrow();
  const s = sampleAt(inp, 0);
  assert.deepEqual([s.throw, s.light, s.heavy], [true, false, false]);
  assert.equal(sampleAt(inp, 16).throw, false);
});

test('KeyU is a dedicated throw key, no auto-repeat', () => {
  assert.equal(KEY_BINDINGS.KeyU, 'throw');
  const inp = new InputState();
  assert.equal(inp.keyDown('KeyU', 0), true);
  assert.equal(sampleAt(inp, 0).throw, true);
  inp.keyDown('KeyU', 10); // held: auto-repeat ignored
  assert.equal(sampleAt(inp, 16).throw, false);
  inp.keyUp('KeyU');
  inp.keyDown('KeyU', 30);
  assert.equal(sampleAt(inp, 32).throw, true);
});

test('touch Light and Heavy show up on the very next sample (no chord delay)', () => {
  const inp = new InputState();
  inp.pressTouch('light', 0);
  const s = sampleAt(inp, 0);
  assert.deepEqual([s.light, s.heavy, s.throw], [true, false, false]);
  inp.pressTouch('heavy', 16);
  assert.equal(sampleAt(inp, 16).heavy, true);
});

test('touch Light+Heavy together are two attacks, never a throw', () => {
  const inp = new InputState();
  inp.pressTouch('light', 0);
  inp.pressTouch('heavy', 5);
  const s = sampleAt(inp, 5);
  assert.deepEqual([s.light, s.heavy, s.throw], [true, true, false]);
});

test('touchThrowChord opt-in restores the chord on touch', () => {
  const inp = new InputState({ ...INPUT_CONFIG, touchThrowChord: true });
  inp.pressTouch('light', 0);
  inp.pressTouch('heavy', 20);
  assert.equal(sampleAt(inp, 100).throw, true);
});

test('keyboard J+K within 50 ms gives throw only', () => {
  const inp = new InputState();
  inp.keyDown('KeyJ', 0);
  inp.keyDown('KeyK', 45);
  const s = sampleAt(inp, 60);
  assert.deepEqual([s.throw, s.light, s.heavy], [true, false, false]);
});

test('keyboard J+K 60 ms apart gives Light then Heavy', () => {
  const inp = new InputState();
  inp.keyDown('KeyJ', 0);
  inp.keyDown('KeyK', 60);
  const a = sampleAt(inp, 61);
  assert.deepEqual([a.throw, a.light, a.heavy], [false, true, false]);
  const b = sampleAt(inp, 111);
  assert.deepEqual([b.throw, b.light, b.heavy], [false, false, true]);
});

test('radial stick dead zone 0.15: zero inside, raw outside', () => {
  const inp = new InputState();
  inp.setStick(0.1, 0.1); // |v| ~0.141
  let s = sampleAt(inp, 0);
  assert.deepEqual([s.stick.x, s.stick.y], [0, 0]);
  inp.setStick(0.12, 0.1); // |v| ~0.156
  s = sampleAt(inp, 16);
  assert.deepEqual([s.stick.x, s.stick.y], [0.12, 0.1]);
  inp.setStick(0.5, 0);
  assert.equal(sampleAt(inp, 32).stick.x, 0.5);
});

test('dead zone does not touch keyboard input', () => {
  const inp = new InputState();
  inp.keyDown('KeyD', 0);
  assert.equal(sampleAt(inp, 0).stick.x, 1);
});

test('tap threshold 0.65: 0.6 is not a tap, 0.7 is', () => {
  const d = new DoubleTapDetector();
  d.update(0.6, 0);
  d.update(0, 50);
  assert.equal(d.update(0.6, 100), 0);
  d.update(0.7, 120);
  d.update(0, 150);
  assert.equal(d.update(0.7, 200), 1);
});

test('hysteresis: 0.62 <-> 0.58 jitter after a tap fires no sidestep', () => {
  const d = new DoubleTapDetector();
  assert.equal(d.update(0.7, 0), 0);
  let fired = 0;
  for (let t = 16, i = 0; t < 280; t += 16, i++) fired |= d.update(i % 2 ? 0.62 : 0.58, t);
  assert.equal(fired, 0);
});

test('hysteresis: 0.7 -> 0.3 -> 0.7 within the window fires one sidestep', () => {
  const d = new DoubleTapDetector();
  assert.equal(d.update(0.7, 0), 0);
  assert.equal(d.update(0.3, 80), 0);
  assert.equal(d.update(0.7, 160), 1);
  assert.equal(d.update(0.3, 200), 0);
});

test('a dip that stays above 0.45 does not leave the zone', () => {
  const d = new DoubleTapDetector();
  d.update(-0.7, 0);
  assert.equal(d.update(-0.5, 50), 0);
  assert.equal(d.update(-0.8, 100), 0);
});

test('double-tap window is 300 ms inclusive', () => {
  const ok = new DoubleTapDetector();
  ok.update(1, 0);
  ok.update(0, 100);
  assert.equal(ok.update(1, 300), 1);
  const late = new DoubleTapDetector();
  late.update(-1, 0);
  late.update(0, 100);
  assert.equal(late.update(-1, 301), 0);
});

test('InputState uses the configured window/thresholds for sidestep', () => {
  const inp = new InputState();
  inp.setStick(0, -0.7);
  sampleAt(inp, 0);
  inp.setStick(0, -0.3);
  sampleAt(inp, 100);
  inp.setStick(0, -0.7);
  assert.equal(sampleAt(inp, 290).sidestep, -1);
});

test('handedness: right hand puts the stick zone on the left, left hand mirrors it', () => {
  assert.equal(stickZoneSide('right'), 'left');
  assert.equal(stickZoneSide('left'), 'right');
  assert.equal(resolveHandedness('bogus'), 'right');
  assert.equal(stickZoneSide(undefined), 'left');
  const vp = { width: 800, height: 400 };
  assert.deepEqual(stickZoneRect(stickZoneSide('right'), vp), { left: 0, top: 0, right: 400, bottom: 400 });
  assert.deepEqual(stickZoneRect(stickZoneSide('left'), vp), { left: 400, top: 0, right: 800, bottom: 400 });
});

test('stick origin is clamped inside the safe area and the zone', () => {
  const vp = { width: 844, height: 390 };
  const safe = { top: 0, right: 0, bottom: 21, left: 47 };
  const zone = stickZoneRect('left', vp);
  // Touch at the notch edge, bottom corner: pushed in by safe + r + 8.
  assert.deepEqual(clampStickOrigin(5, 389, zone, safe, vp, 64, 8), { x: 47 + 72, y: 390 - 21 - 72 });
  // Touch well inside: unchanged.
  assert.deepEqual(clampStickOrigin(200, 200, zone, safe, vp, 64, 8), { x: 200, y: 200 });
  // Near the zone's inner edge: kept off the midline.
  assert.equal(clampStickOrigin(421, 200, zone, safe, vp, 64, 8).x, 422 - 72);
});

test('left-hand stick origin respects the right safe inset', () => {
  const vp = { width: 844, height: 390 };
  const safe = { top: 0, right: 47, bottom: 0, left: 0 };
  const zone = stickZoneRect('right', vp);
  assert.equal(clampStickOrigin(843, 200, zone, safe, vp, 64, 8).x, 844 - 47 - 72);
  assert.equal(clampStickOrigin(423, 200, zone, safe, vp, 64, 8).x, 422 + 72);
});

test('stick origin reserves the knob radius so a rim-deflected knob stays on screen', () => {
  const vp = { width: 844, height: 390 };
  const safe = { top: 0, right: 0, bottom: 0, left: 0 };
  const zone = stickZoneRect('left', vp);
  const r = INPUT_CONFIG.stickRadiusPx;
  const k = INPUT_CONFIG.stickKnobRadiusPx;
  const m = INPUT_CONFIG.stickEdgeMarginPx;
  assert.equal(k, 32);
  const o = clampStickOrigin(0, 0, zone, safe, vp, r, m, k);
  // Knob fully deflected toward the corner: its outer edge is still >= margin from the edge.
  assert.equal(o.x - r - k, m);
  assert.equal(o.y - r - k, m);
  const b = clampStickOrigin(0, 390, zone, safe, vp, r, m, k);
  assert.equal(390 - (b.y + r + k), m);
});

test('reset clears a pending throw', () => {
  const inp = new InputState();
  inp.pressThrow();
  inp.reset();
  assert.equal(sampleAt(inp, 0).throw, false);
});

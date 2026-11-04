import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InputState, DoubleTapDetector, createSnapshot, KEY_BINDINGS } from '../fixtures/bound/input-snapshot.js';

const sampleAt = (inp, t) => inp.sample(createSnapshot(), t);

test('keyboard WASD and arrows map to the stick axes', () => {
  const inp = new InputState();
  inp.keyDown('KeyD', 0);
  inp.keyDown('ArrowUp', 0);
  const s = sampleAt(inp, 10);
  assert.equal(s.stick.x, 1);
  assert.equal(s.stick.y, 1);
  inp.keyUp('KeyD');
  inp.keyDown('KeyA', 20);
  assert.equal(sampleAt(inp, 30).stick.x, -1);
  assert.equal(KEY_BINDINGS.KeyJ, 'light');
});

test('touch stick and keyboard combine and clamp', () => {
  const inp = new InputState();
  inp.setStick(0.5, 0);
  inp.keyDown('KeyD', 0);
  assert.equal(sampleAt(inp, 1).stick.x, 1);
});

test('unbound keys are reported as unhandled', () => {
  assert.equal(new InputState().keyDown('KeyQ', 0), false);
});

test('Light alone fires after the throw window, once', () => {
  const inp = new InputState();
  inp.pressButton('light', 0);
  assert.equal(sampleAt(inp, 10).light, false);
  const s = sampleAt(inp, 100);
  assert.equal(s.light, true);
  assert.equal(s.throw, false);
  assert.equal(sampleAt(inp, 116).light, false);
});

test('Light+Heavy within the window emits Throw only', () => {
  const inp = new InputState();
  inp.pressButton('light', 0);
  inp.pressButton('heavy', 40);
  const s = sampleAt(inp, 200);
  assert.deepEqual([s.throw, s.light, s.heavy], [true, false, false]);
});

test('Light then Heavy outside the window emits both, not Throw', () => {
  const inp = new InputState();
  inp.pressButton('light', 0);
  inp.pressButton('heavy', 500);
  const s = sampleAt(inp, 520);
  assert.deepEqual([s.throw, s.light, s.heavy], [false, true, false]);
  assert.equal(sampleAt(inp, 700).heavy, true);
});

test('Heavy then Light also throws', () => {
  const inp = new InputState();
  inp.pressButton('heavy', 0);
  inp.pressButton('light', 30);
  assert.equal(sampleAt(inp, 100).throw, true);
});

test('guard is held while moving (multi-touch)', () => {
  const inp = new InputState();
  inp.setGuard(true);
  inp.setStick(1, 0);
  const s = sampleAt(inp, 0);
  assert.equal(s.guard, true);
  assert.equal(s.stick.x, 1);
  inp.setGuard(false);
  assert.equal(sampleAt(inp, 16).guard, false);
  inp.keyDown('KeyL', 0);
  assert.equal(sampleAt(inp, 32).guard, true);
});

test('double tap up within window fires +1; down fires -1', () => {
  const d = new DoubleTapDetector(280, 0.6);
  assert.equal(d.update(1, 0), 0);
  assert.equal(d.update(0, 50), 0);
  assert.equal(d.update(1, 150), 1);
  assert.equal(d.update(0, 200), 0);
  assert.equal(d.update(-1, 300), 0);
  assert.equal(d.update(0, 340), 0);
  assert.equal(d.update(-1, 400), -1);
});

test('double tap outside the window or across directions does not fire', () => {
  const d = new DoubleTapDetector(280, 0.6);
  d.update(1, 0);
  d.update(0, 50);
  assert.equal(d.update(1, 400), 0);
  d.update(0, 450);
  assert.equal(d.update(-1, 500), 0);
});

test('holding the stick does not retrigger; triple tap does not chain', () => {
  const d = new DoubleTapDetector(280, 0.6);
  d.update(1, 0);
  assert.equal(d.update(1, 100), 0);
  d.update(0, 120);
  assert.equal(d.update(1, 150), 1);
  d.update(0, 170);
  assert.equal(d.update(1, 200), 0);
});

test('sidestep surfaces in the snapshot for one sample', () => {
  const inp = new InputState();
  inp.setStick(0, 1);
  sampleAt(inp, 0);
  inp.setStick(0, 0);
  sampleAt(inp, 50);
  inp.setStick(0, 1);
  assert.equal(sampleAt(inp, 100).sidestep, 1);
  assert.equal(sampleAt(inp, 116).sidestep, 0);
});

test('reset clears held state and pending events', () => {
  const inp = new InputState();
  inp.keyDown('KeyD', 0);
  inp.setGuard(true);
  inp.pressButton('light', 0);
  inp.reset();
  const s = sampleAt(inp, 500);
  assert.deepEqual([s.stick.x, s.guard, s.light], [0, false, false]);
});

// story-009 §2: specials and Overwind use existing inputs (stick + Heavy, Guard + Heavy).
test('keyboard: D/A + K gives a full-tilt stick with Heavy; L + K gives Guard + Heavy', () => {
  const s = new InputState();
  const out = createSnapshot();
  s.keyDown('KeyD', 0);
  s.keyDown('KeyK', 0);
  s.sample(out, 100);
  assert.equal(out.stick.x, 1);
  assert.equal(out.heavy, true);
  s.reset();
  s.keyDown('KeyA', 0);
  s.keyDown('KeyK', 0);
  s.sample(out, 100);
  assert.equal(out.stick.x, -1);
  assert.equal(out.heavy, true);
  s.reset();
  s.keyDown('KeyL', 0);
  s.keyDown('KeyK', 0);
  s.sample(out, 100);
  assert.equal(out.guard, true);
  assert.equal(out.heavy, true);
});

test('touch: stick tilt at the special threshold plus the Heavy button arrive in one snapshot', () => {
  const s = new InputState();
  const out = createSnapshot();
  s.setStick(0.65, 0);
  s.pressTouch('heavy', 0);
  s.sample(out, 0);
  assert.equal(out.stick.x, 0.65);
  assert.equal(out.heavy, true);
});

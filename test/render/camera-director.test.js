// pocket-ready story-007: dynamic fight camera (push-in, HUD clamp, orbit, shake, reduced motion).
import test from 'node:test';
import assert from 'node:assert/strict';
import { CAMERA_FEEL, createCameraDirector, clampPush, pushEnvelope, orbitProgress } from '../../src/render/camera-director.js';
import { computeFraming } from '../../src/render/framing.js';

const VFOV = 50;
const ASPECT = 844 / 390;
const tanV = Math.tan((VFOV * Math.PI) / 360);
const frame = (sep) => computeFraming(-sep / 2, 0, sep / 2, 0, VFOV, ASPECT, { x: 0, y: 0, z: 0, lx: 0, ly: 0, lz: 0 });
const pose = () => ({ x: 0, y: 0, z: 0, lx: 0, ly: 0, lz: 0 });
const dist = (o) => Math.hypot(o.x - o.lx, o.y - o.ly, o.z - o.lz);

test('pushEnvelope_attackHoldRelease_endsAtZero', () => {
  const p = CAMERA_FEEL.push;
  assert.equal(pushEnvelope(0, p), 0);
  assert.equal(pushEnvelope(p.attackMs + 1, p), 1);
  assert.equal(pushEnvelope(p.attackMs + p.holdMs + p.releaseMs + 1, p), 0);
});

test('clampPush_neverFramesFightersUnderHudOrOffscreen', () => {
  const c = CAMERA_FEEL.clamp;
  for (const sep of [0.5, 2, 4, 7]) {
    const t = frame(sep);
    const d = dist(t);
    const k = 1 - clampPush(0.9, d, sep, tanV, ASPECT, t.ly, c);
    const dd = d * k;
    assert.ok(dd * tanV * ASPECT >= sep / 2 + c.sidePad - 1e-9, `sides sep=${sep}`);
    const usable = 1 - 2 * Math.max(c.topBandFrac, c.bottomBandFrac);
    assert.ok(dd * tanV * usable >= c.headY - t.ly - 1e-9, `head below HUD sep=${sep}`);
  }
  assert.equal(clampPush(0, 10, 2, tanV, ASPECT, 0.6, c), 0);
});

test('director_heavyHit_pushesIn_lightHitDoesNot', () => {
  const t = frame(2);
  const d = createCameraDirector({ vfovDeg: VFOV });
  const out = pose();
  d.update(16, t, 2, ASPECT, out);
  const base = dist(out);
  d.impact('light', 0.3);
  assert.equal(d.pushNow(), 0);
  d.impact('heavy', 0.6);
  for (let i = 0; i < 6; i++) d.update(16, t, 2, ASPECT, out);
  assert.ok(dist(out) < base - 1e-3, 'closer on heavy');
  for (let i = 0; i < 80; i++) d.update(16, t, 2, ASPECT, out);
  assert.ok(Math.abs(dist(out) - base) < 1e-6, 'returns to framing');
});

test('director_shake_scalesWithHitWeight', () => {
  const a = createCameraDirector({ vfovDeg: VFOV });
  const b = createCameraDirector({ vfovDeg: VFOV });
  a.impact('light', 0.5);
  b.impact('heavy', 0.5);
  assert.ok(b.shakeNow() > a.shakeNow());
});

test('director_reducedMotion_noShakePushOrOrbit', () => {
  const t = frame(2);
  const d = createCameraDirector({ vfovDeg: VFOV, reducedMotion: true });
  const out = pose();
  d.update(16, t, 2, ASPECT, out);
  const ref = { ...out };
  d.impact('ko', 1);
  d.finalKo();
  for (let i = 0; i < 50; i++) d.update(16, t, 2, ASPECT, out);
  assert.equal(d.shakeNow(), 0);
  assert.deepEqual(out, ref);
});

test('director_finalKo_orbitsAndHolds', () => {
  const t = frame(2);
  const d = createCameraDirector({ vfovDeg: VFOV });
  const out = pose();
  d.update(16, t, 2, ASPECT, out);
  const x0 = out.x;
  d.finalKo();
  for (let i = 0; i < 200; i++) d.update(16, t, 2, ASPECT, out);
  assert.ok(Math.abs(out.x - x0) > 0.5, 'camera moved round the look-at');
  assert.equal(orbitProgress(CAMERA_FEEL.orbit.durationMs * 2, CAMERA_FEEL.orbit.durationMs), 1);
  d.reset();
  d.update(16, t, 2, ASPECT, out);
  assert.ok(Math.abs(out.x - x0) < 1e-9, 'reset snaps back');
});

test('director_follow_smoothsFramingJumps_snapsOnTeleport', () => {
  const d = createCameraDirector({ vfovDeg: VFOV });
  const out = pose();
  d.update(16, frame(2), 2, ASPECT, out);
  const t = frame(2);
  t.lx += 1; t.x += 1;
  d.update(16, t, 2, ASPECT, out);
  assert.ok(out.lx > 0 && out.lx < 1, 'eased toward target');
  t.lx += 10; t.x += 10;
  d.update(16, t, 2, ASPECT, out);
  assert.equal(out.lx, t.lx);
});

test('director_overwind_pushesTowardAttacker_thenReleases', () => {
  const t = frame(2);
  const d = createCameraDirector({ vfovDeg: VFOV });
  const out = pose();
  d.update(16, t, 2, ASPECT, out);
  const base = dist(out);
  d.overwind(-1, 0);
  for (let ms = 0; ms < 300; ms += 16) d.update(16, t, 2, ASPECT, out);
  assert.ok(dist(out) < base, 'pushed in during the freeze');
  assert.ok(out.lx < t.lx, 'look-at leans toward the attacker');
  for (let ms = 0; ms < 400; ms += 16) d.update(16, t, 2, ASPECT, out);
  assert.equal(d.overwindActive(), false);
  assert.ok(Math.abs(dist(out) - base) < 1e-6, 'released');
});

// --- game-feel audit F5 (impulse / shake / roll) and KD-10 (focus) ---

/** Offset of the camera from its unshaken pose: both the eye and the look-at move by the same vector. */
const frameOffset = (out, ref) => ({ x: out.x - ref.x, y: out.y - ref.y, z: out.z - ref.z, lx: out.lx - ref.lx, ly: out.ly - ref.ly, lz: out.lz - ref.lz });

test('impulse_movesEyeAndLookAtTogether_peaksAlongTheKick_decaysToSilence', () => {
  const t = frame(2);
  const d = createCameraDirector({ vfovDeg: VFOV });
  const out = pose();
  d.update(16, t, 2, ASPECT, out);
  const ref = { ...out };
  d.impulse({ dir: { x: 1, y: 0, z: 0 }, strength: 0.1, ms: 240, hz: 10 });
  d.update(0, t, 2, ASPECT, out);
  const o = frameOffset(out, ref);
  assert.ok(Math.abs(o.x - 0.1) < 1e-9, 'full kick along +x at t = 0 (camera right is world x for this framing)');
  assert.ok(Math.abs(o.lx - o.x) < 1e-12 && Math.abs(o.ly - o.y) < 1e-12 && Math.abs(o.lz - o.z) < 1e-12, 'look-at carries the same offset');
  assert.equal(out.roll, 0, 'no roll requested');
  let peakLate = 0;
  for (let ms = 0; ms < 240; ms += 16) {
    d.update(16, t, 2, ASPECT, out);
    if (ms > 160) peakLate = Math.max(peakLate, Math.abs(frameOffset(out, ref).x));
  }
  assert.ok(peakLate < 0.1 * 0.12, 'quadratic decay: under 12 % of the kick in the last third');
  d.update(16, t, 2, ASPECT, out);
  assert.equal(d.impulseNow(), 0);
  assert.deepEqual(frameOffset(out, ref), { x: 0, y: 0, z: 0, lx: 0, ly: 0, lz: 0 });
});

test('impulse_frequency_isTheRequestedHz', () => {
  const t = frame(2);
  const d = createCameraDirector({ vfovDeg: VFOV });
  const out = pose();
  d.update(16, t, 2, ASPECT, out);
  const ref = { ...out };
  d.impulse({ dir: { x: 1 }, strength: 0.1, ms: 2000, hz: 10 }); // long decay so the zero crossings are clean
  let last = 1;
  let crossings = 0;
  let ms = 0;
  while (ms < 500) {
    d.update(1, t, 2, ASPECT, out);
    ms += 1;
    const x = frameOffset(out, ref).x;
    if (Math.sign(x) !== Math.sign(last) && x !== 0) crossings++;
    last = x;
  }
  assert.equal(crossings, 10, '10 Hz over 500 ms = 5 cycles = 10 zero crossings');
});

test('shake_isIsotropicNoise_withRoll_andClampsStrengthAndRoll', () => {
  const t = frame(2);
  const d = createCameraDirector({ vfovDeg: VFOV });
  const out = pose();
  d.update(16, t, 2, ASPECT, out);
  const ref = { ...out };
  d.impulse({ strength: 5, ms: 300, roll: 90 });
  d.update(0, t, 2, ASPECT, out);
  const o = frameOffset(out, ref);
  assert.ok(Math.hypot(o.x, o.y, o.z) <= CAMERA_FEEL.impulse.maxAmplitude + 1e-9, 'strength clamped');
  assert.ok(Math.abs(out.roll) <= (CAMERA_FEEL.impulse.maxRollDeg * Math.PI) / 180 + 1e-9, 'roll clamped');
  assert.ok(Math.abs(out.roll) > 0, 'roll present');
  assert.equal(d.impulseNow(), CAMERA_FEEL.impulse.maxAmplitude);
  d.shake(0.02, 100);
  assert.ok(d.impulseNow() > CAMERA_FEEL.impulse.maxAmplitude, 'a second impulse overlaps in its own slot');
});

test('impulse_fifthImpulse_replacesTheWeakest_notTheStrongest', () => {
  const t = frame(2);
  const d = createCameraDirector({ vfovDeg: VFOV });
  const out = pose();
  d.update(16, t, 2, ASPECT, out);
  d.impulse({ strength: 0.2, ms: 1000 });
  for (let i = 0; i < 3; i++) d.impulse({ strength: 0.01, ms: 1000 });
  d.impulse({ strength: 0.05, ms: 1000 });
  assert.ok(Math.abs(d.impulseNow() - (0.2 + 0.01 + 0.01 + 0.05)) < 1e-12);
});

test('impulse_reducedMotion_ignored_byDefaultScale_andScaledWhenConfigured', () => {
  const t = frame(2);
  const a = createCameraDirector({ vfovDeg: VFOV, reducedMotion: true });
  const out = pose();
  a.update(16, t, 2, ASPECT, out);
  const ref = { ...out };
  a.impulse({ dir: { x: 1 }, strength: 0.1, ms: 200, roll: 2 });
  a.update(0, t, 2, ASPECT, out);
  assert.deepEqual(out, ref);
  const cfg = { ...CAMERA_FEEL, impulse: { ...CAMERA_FEEL.impulse, reducedMotionScale: 0.25 } };
  const b = createCameraDirector({ vfovDeg: VFOV, reducedMotion: true, cfg });
  b.update(16, t, 2, ASPECT, out);
  b.impulse({ dir: { x: 1 }, strength: 0.1, ms: 200 });
  assert.ok(Math.abs(b.impulseNow() - 0.025) < 1e-12);
});

test('impulse_kickAlongTheViewAxis_fallsBackToSideways', () => {
  const t = frame(2);
  const d = createCameraDirector({ vfovDeg: VFOV });
  const out = pose();
  d.update(16, t, 2, ASPECT, out);
  const ref = { ...out };
  const fwd = { x: ref.lx - ref.x, y: ref.ly - ref.y, z: ref.lz - ref.z };
  d.impulse({ dir: fwd, strength: 0.1, ms: 200 });
  d.update(0, t, 2, ASPECT, out);
  const o = frameOffset(out, ref);
  assert.ok(Math.abs(Math.abs(o.x) - 0.1) < 1e-6 && Math.abs(o.z) < 1e-6, 'kick is sideways in the camera plane');
});

test('legacyImpactShake_unchangedByDefault_coupleLookAtMovesTheFrame_holdKeepsFullAmplitude', () => {
  const t = frame(2);
  const d = createCameraDirector({ vfovDeg: VFOV });
  const out = pose();
  d.update(16, t, 2, ASPECT, out);
  const ref = { ...out };
  d.impact('heavy', 1);
  d.update(16, t, 2, ASPECT, out);
  const o = frameOffset(out, ref);
  assert.ok(Math.hypot(o.x, o.y) > 0, 'eye shakes');
  assert.deepEqual([o.lx, o.ly, o.lz], [0, 0, 0], 'look-at still fixed (default re-aims, today\'s pixels)');
  assert.equal(out.roll, 0);
  const cfg = { ...CAMERA_FEEL, shake: { ...CAMERA_FEEL.shake, coupleLookAt: true, holdMs: 100 } };
  const c = createCameraDirector({ vfovDeg: VFOV, cfg });
  c.update(16, t, 2, ASPECT, out);
  c.impact('heavy', 1);
  c.update(50, t, 2, ASPECT, out);
  const oc = frameOffset(out, ref);
  // the heavy push-in also moves the eye's y/z (not x: the camera sits on the z axis here), so compare
  // x for the eye and read the pure shake off the look-at offset
  assert.ok(Math.abs(oc.lx - oc.x) < 1e-12 && Math.abs(oc.ly) > 0, 'look-at follows the shake');
  const full = CAMERA_FEEL.shake.weights.heavy * CAMERA_FEEL.shake.maxAmplitude;
  assert.ok(Math.hypot(oc.lx, oc.ly) <= full + 1e-9 && Math.hypot(oc.lx, oc.ly) > full * 0.3, 'held near full amplitude inside holdMs');
});

test('impact_withDirection_firesAKick_onlyWhenConfigured', () => {
  const t = frame(2);
  const d = createCameraDirector({ vfovDeg: VFOV });
  d.update(16, t, 2, ASPECT, pose());
  d.impact('heavy', 1, 1, 0);
  assert.equal(d.impulseNow(), 0, 'kick 0 by default');
  const cfg = { ...CAMERA_FEEL, shake: { ...CAMERA_FEEL.shake, kick: 0.5 } };
  const k = createCameraDirector({ vfovDeg: VFOV, cfg });
  k.update(16, t, 2, ASPECT, pose());
  k.impact('heavy', 1, 1, 0);
  const amp = CAMERA_FEEL.shake.weights.heavy * CAMERA_FEEL.shake.maxAmplitude * 0.5;
  assert.ok(Math.abs(k.impulseNow() - amp) < 1e-12);
});

test('focus_blendsLookAtTowardTarget_lowersAndDollies_thenReleasesToFraming', () => {
  const t = frame(2);
  const d = createCameraDirector({ vfovDeg: VFOV });
  const out = pose();
  d.update(16, t, 2, ASPECT, out);
  const ref = { ...out };
  const base = dist(out);
  d.focus({ target: { x: -1, y: ref.ly, z: 0 }, weight: 0.5, ms: 400, lowerBy: 0.2, dollyIn: 0.1, inMs: 160, outMs: 400 });
  for (let ms = 0; ms < 160; ms += 16) d.update(16, t, 2, ASPECT, out);
  d.update(16, t, 2, ASPECT, out);
  assert.ok(Math.abs(d.focusLevel() - 1) < 1e-9, 'fully blended after inMs');
  assert.ok(Math.abs(out.lx - (ref.lx - 0.5)) < 1e-9, 'look-at half way toward the target');
  assert.ok(Math.abs(out.ly - (ref.ly - 0.2)) < 1e-9, 'look-at lowered');
  assert.ok(out.y - ref.y <= -0.2 + 1e-9, 'camera lowered with it (plus the dolly brings it down the offset)');
  assert.ok(dist(out) < base, 'dollied in');
  for (let ms = 0; ms < 400 + 400 + 100; ms += 16) d.update(16, t, 2, ASPECT, out);
  assert.equal(d.focusActive(), false);
  assert.ok(Math.abs(out.lx - ref.lx) < 1e-9 && Math.abs(dist(out) - base) < 1e-9, 'released to framing');
});

test('focus_release_startsTheReleaseFromTheCurrentLevel_withoutASnap', () => {
  const t = frame(2);
  const d = createCameraDirector({ vfovDeg: VFOV });
  const out = pose();
  d.update(16, t, 2, ASPECT, out);
  d.focus({ target: { x: -1, y: 0.6, z: 0 }, weight: 1, ms: 5000, inMs: 200 });
  for (let i = 0; i < 5; i++) d.update(16, t, 2, ASPECT, out); // mid blend-in (80 of 200 ms)
  const before = d.focusLevel();
  assert.ok(before > 0.3 && before < 0.5);
  d.release(300);
  d.update(1, t, 2, ASPECT, out);
  assert.ok(Math.abs(d.focusLevel() - before) < 0.01, 'continuous');
  for (let i = 0; i < 25; i++) d.update(16, t, 2, ASPECT, out);
  assert.equal(d.focusActive(), false);
  d.focus({ target: { x: -1, y: 0.6, z: 0 }, ms: 100 });
  d.reset();
  assert.equal(d.focusActive(), false, 'reset clears a focus');
});

test('focus_reducedMotion_blendPlays_butNoDolly', () => {
  const t = frame(2);
  const d = createCameraDirector({ vfovDeg: VFOV, reducedMotion: true });
  const out = pose();
  d.update(16, t, 2, ASPECT, out);
  const ref = { ...out };
  const base = dist(out);
  d.focus({ target: { x: -1, y: ref.ly, z: 0 }, weight: 1, ms: 500, dollyIn: 0.2 });
  for (let i = 0; i < 20; i++) d.update(16, t, 2, ASPECT, out);
  assert.ok(out.lx < ref.lx, 'look-at moved toward the target');
  assert.ok(Math.abs(dist(out) - base) < 1e-9, 'no push-in');
});

test('director_partialCameraFeelOverride_withoutImpulseOrFocus_stillWorks', () => {
  const cfg = { ...CAMERA_FEEL };
  delete cfg.impulse;
  delete cfg.focus;
  const d = createCameraDirector({ vfovDeg: VFOV, cfg });
  const out = pose();
  d.update(16, frame(2), 2, ASPECT, out);
  d.impulse({ strength: 0.05 });
  d.focus({ target: { x: 0, y: 0, z: 0 }, ms: 100 });
  assert.ok(d.impulseNow() > 0 && d.focusActive());
});

test('director_overwind_reducedMotion_noPush', () => {
  const t = frame(2);
  const d = createCameraDirector({ vfovDeg: VFOV, reducedMotion: true });
  const out = pose();
  d.update(16, t, 2, ASPECT, out);
  const base = dist(out);
  d.overwind(-1, 0);
  d.update(200, t, 2, ASPECT, out);
  assert.equal(d.overwindActive(), false);
  assert.ok(Math.abs(dist(out) - base) < 1e-9);
});

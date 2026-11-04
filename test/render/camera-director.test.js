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

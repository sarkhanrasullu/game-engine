// Dynamic fight camera (pocket-ready story-007, presentation only). Takes the raw framing target
// from framing.js each frame and layers on: smoothed follow, weight-scaled impact shake, a short
// push-in on heavy hits and KO, and an orbit on the match-deciding KO. Every push-in is clamped so
// both fighters stay clear of the HUD bands. Pure (no DOM, no three.js), allocation-free per frame.
// prefers-reduced-motion: shake, push-in and orbit are all off; hit-fx turns shake into a flash.

/** Camera feel tuning (story-007 AC 2: "tunable as data"). Times in ms, distances in world units. */
export const CAMERA_FEEL = Object.freeze({
  /** Follow smoothing rates (1/s): fraction kept per frame = exp(-rate * dt). */
  follow: Object.freeze({ posRate: 7, lookRate: 10, snapDistance: 3 }),
  /**
   * Shake: amplitude = event shake (0..1) * weight[kind] * maxAmplitude, decaying quadratically
   * over durationMs; smooth two-sine noise at freqHz (no random jitter).
   */
  shake: Object.freeze({
    maxAmplitude: 0.12,
    durationMs: 240,
    freqHz: 26,
    weights: Object.freeze({ light: 0.55, heavy: 1.15, throw: 1, super: 1.35, guard: 0.45, armor: 0.8, ko: 1.5 }),
  }),
  /**
   * Push-in as a fraction of camera distance (0.1 = 10 % closer), per hit kind; kinds not listed
   * do not push. Envelope: attack -> hold -> release.
   */
  push: Object.freeze({
    amount: Object.freeze({ heavy: 0.08, super: 0.12, armor: 0.05, ko: 0.16 }),
    attackMs: 60,
    holdMs: 140,
    releaseMs: 420,
  }),
  /** Final-KO orbit: yaw around the look-at point, eased in and held, plus an extra push. */
  orbit: Object.freeze({ degrees: 24, durationMs: 1700, push: 0.12, lookLift: 0.15 }),
  /**
   * HUD clamp: the push never brings the camera closer than the distance that keeps both
   * fighters (plus sidePad) inside the frame and the fighter head height below the top HUD band
   * (topBandFrac of the screen height) and above the bottom band (touch controls).
   */
  clamp: Object.freeze({ sidePad: 1.1, headY: 1.55, topBandFrac: 0.18, bottomBandFrac: 0.1 }),
  /**
   * Overwind super freeze (story-009 spec §7): push ~15 % toward the attacker over 8f (133 ms),
   * hold through the rest of the 24f freeze (267 ms), release over the first 6 startup frames
   * (100 ms). lean: fraction of the way the look-at slides toward the attacker at full envelope
   * (the HUD clamp is widened by that slide so the opponent stays in frame). Off under reduced motion.
   */
  overwind: Object.freeze({ push: 0.15, lean: 0.2, attackMs: 133, holdMs: 267, releaseMs: 100 }),
});

const DEG = Math.PI / 180;

/** 0..1 envelope of a push started `t` ms ago (attack, hold, release). Pure. */
export function pushEnvelope(t, p) {
  if (t < 0) return 0;
  if (t < p.attackMs) return t / p.attackMs;
  t -= p.attackMs;
  if (t < p.holdMs) return 1;
  t -= p.holdMs;
  if (t >= p.releaseMs) return 0;
  const u = 1 - t / p.releaseMs;
  return u * u * (3 - 2 * u);
}

/**
 * Largest push fraction (0..1) that keeps the clamp rule at camera distance `dist`.
 * @param {number} want requested push @param {number} dist current camera-to-look-at distance
 * @param {number} sep fighter separation @param {number} tanV tan(vfov/2) @param {number} aspect
 * @param {number} lookY look-at height @param {typeof CAMERA_FEEL.clamp} c
 */
export function clampPush(want, dist, sep, tanV, aspect, lookY, c) {
  if (!(want > 0) || !(dist > 0)) return 0;
  const minSide = (sep / 2 + c.sidePad) / (tanV * aspect);
  const usable = 1 - 2 * Math.max(c.topBandFrac, c.bottomBandFrac);
  const minUp = usable > 0 ? Math.max(0, c.headY - lookY) / (tanV * usable) : dist;
  const minDist = Math.max(minSide, minUp);
  const maxPush = 1 - minDist / dist;
  if (maxPush <= 0) return 0;
  return want < maxPush ? want : maxPush;
}

/** Smooth 0..1 orbit progress `t` ms into the orbit (ease in-out, then held). Pure. */
export function orbitProgress(t, durationMs) {
  if (t <= 0) return 0;
  if (t >= durationMs) return 1;
  const u = t / durationMs;
  return u * u * (3 - 2 * u);
}

/**
 * @param {{vfovDeg:number, reducedMotion?:boolean, cfg?: typeof CAMERA_FEEL}} opts
 */
export function createCameraDirector({ vfovDeg, reducedMotion = false, cfg = CAMERA_FEEL }) {
  const tanV = Math.tan((vfovDeg * Math.PI) / 360);
  const cur = { x: 0, y: 0, z: 0, lx: 0, ly: 0, lz: 0 };
  let snapped = false;
  let shakeAmp = 0;
  let shakeLeft = 0;
  let pushWant = 0;
  let pushAge = 1e9;
  let orbitAge = -1;
  let owAge = -1;
  let owX = 0;
  let owZ = 0;
  let clock = 0;
  const still = { reducedMotion };

  /**
   * One hit/KO for the camera. kind: move fx class ('light'|'heavy'|'throw'|'super'), 'guard',
   * 'armor' or 'ko'; shake: the event's 0..1 shake value.
   */
  function impact(kind, shake) {
    if (still.reducedMotion) return;
    const w = cfg.shake.weights[kind] ?? 1;
    const amp = shake * w * cfg.shake.maxAmplitude;
    const live = shakeAmp * (shakeLeft / cfg.shake.durationMs) ** 2;
    if (amp >= live) {
      shakeAmp = amp;
      shakeLeft = cfg.shake.durationMs;
    }
    const p = cfg.push.amount[kind];
    if (p > 0) {
      const env = pushEnvelope(pushAge, cfg.push);
      if (p >= pushWant * env) {
        // restart the attack from the current push level so a second push never snaps back
        pushAge = cfg.push.attackMs * ((pushWant * env) / p);
        pushWant = p;
      }
    }
  }

  /** Match-deciding KO: start the orbit. */
  function finalKo() {
    if (!still.reducedMotion && orbitAge < 0) orbitAge = 0;
  }

  /**
   * Overwind freeze beat (story-009 §7): push in toward the attacker standing at world (x, z).
   * No-op under reduced motion (the HUD dim still plays).
   * @param {number} x attacker world x @param {number} z attacker world z
   */
  function overwind(x, z) {
    if (still.reducedMotion) return;
    owAge = 0;
    owX = x;
    owZ = z;
  }

  /** New round / match: drop all feel state and snap to the next framing. */
  function reset() {
    owAge = -1;
    shakeAmp = 0;
    shakeLeft = 0;
    pushWant = 0;
    pushAge = 1e9;
    orbitAge = -1;
    snapped = false;
  }

  /**
   * Advance by dtMs and write the camera pose.
   * @param {number} dtMs real ms since the last frame
   * @param {{x:number,y:number,z:number,lx:number,ly:number,lz:number}} target framing.js output
   * @param {number} sep fighter separation (world units) @param {number} aspect width/height
   * @param {{x:number,y:number,z:number,lx:number,ly:number,lz:number}} out camera position + look-at
   */
  function update(dtMs, target, sep, aspect, out) {
    const dt = dtMs > 0 ? dtMs / 1000 : 0;
    clock += dtMs > 0 ? dtMs : 0;
    const jump = Math.abs(target.lx - cur.lx) + Math.abs(target.lz - cur.lz);
    if (!snapped || jump > cfg.follow.snapDistance) {
      cur.x = target.x; cur.y = target.y; cur.z = target.z;
      cur.lx = target.lx; cur.ly = target.ly; cur.lz = target.lz;
      snapped = true;
    } else {
      const kp = 1 - Math.exp(-cfg.follow.posRate * dt);
      const kl = 1 - Math.exp(-cfg.follow.lookRate * dt);
      cur.x += (target.x - cur.x) * kp;
      cur.y += (target.y - cur.y) * kp;
      cur.z += (target.z - cur.z) * kp;
      cur.lx += (target.lx - cur.lx) * kl;
      cur.ly += (target.ly - cur.ly) * kl;
      cur.lz += (target.lz - cur.lz) * kl;
    }
    let ox = cur.x - cur.lx;
    let oy = cur.y - cur.ly;
    let oz = cur.z - cur.lz;
    let ly = cur.ly;
    let want = 0;
    if (pushWant > 0) {
      pushAge += dtMs > 0 ? dtMs : 0;
      want = pushWant * pushEnvelope(pushAge, cfg.push);
      if (want === 0 && pushAge > cfg.push.attackMs) pushWant = 0;
    }
    if (orbitAge >= 0) {
      orbitAge += dtMs > 0 ? dtMs : 0;
      const u = orbitProgress(orbitAge, cfg.orbit.durationMs);
      const a = cfg.orbit.degrees * DEG * u;
      const c = Math.cos(a);
      const s = Math.sin(a);
      const nx = ox * c + oz * s;
      oz = -ox * s + oz * c;
      ox = nx;
      ly += cfg.orbit.lookLift * u;
      want = Math.max(want, cfg.orbit.push * u);
    }
    let lx = cur.lx;
    let lz = cur.lz;
    let clampSep = sep;
    if (owAge >= 0) {
      const ow = cfg.overwind;
      owAge += dtMs > 0 ? dtMs : 0;
      const e = pushEnvelope(owAge, ow);
      if (e === 0 && owAge > ow.attackMs) owAge = -1;
      else {
        const dx = (owX - cur.lx) * ow.lean * e;
        const dz = (owZ - cur.lz) * ow.lean * e;
        lx += dx;
        lz += dz;
        clampSep = sep + 2 * Math.hypot(dx, dz); // the slide eats into the far side's margin
        want = Math.max(want, ow.push * e);
      }
    }
    const dist = Math.hypot(ox, oy, oz);
    const k = 1 - clampPush(want, dist, clampSep, tanV, aspect, ly, cfg.clamp);
    out.x = lx + ox * k;
    out.y = cur.ly + oy * k;
    out.z = lz + oz * k;
    out.lx = lx;
    out.ly = ly;
    out.lz = lz;
    if (shakeLeft > 0) {
      shakeLeft = Math.max(0, shakeLeft - (dtMs > 0 ? dtMs : 0));
      const f = shakeLeft / cfg.shake.durationMs;
      const a = shakeAmp * f * f;
      const w = (clock / 1000) * cfg.shake.freqHz * 2 * Math.PI;
      out.x += a * (0.6 * Math.sin(w) + 0.4 * Math.sin(1.73 * w + 1.3));
      out.y += a * (0.6 * Math.sin(1.31 * w + 0.7) + 0.4 * Math.sin(2.11 * w + 2.1));
    }
    return out;
  }

  /** Current push-in fraction actually wanted (tests/debug). */
  const pushNow = () => (pushWant > 0 ? pushWant * pushEnvelope(pushAge, cfg.push) : 0);
  /** Current shake amplitude (tests/debug). */
  const shakeNow = () => (shakeLeft > 0 ? shakeAmp * (shakeLeft / cfg.shake.durationMs) ** 2 : 0);

  /** True while the Overwind push is playing (tests/debug). */
  const overwindActive = () => owAge >= 0;

  return { impact, finalKo, overwind, reset, update, pushNow, shakeNow, overwindActive, still };
}

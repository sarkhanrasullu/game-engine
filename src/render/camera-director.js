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
    /** Full amplitude is held for the first holdMs of the shake before the quadratic decay (0 = none). */
    holdMs: 0,
    /** Move the look-at with the camera (the whole frame jolts) instead of the camera alone (re-aims). */
    coupleLookAt: false,
    /**
     * impact(kind, shake, dirX, dirZ): a directional kick (impulse) of amplitude x kick along the hit
     * direction, lasting kickMs at impulse.hz. 0 = no kick (impact ignores the direction).
     */
    kick: 0,
    kickMs: 120,
  }),
  /**
   * impulse()/shake(): damped oscillation defaults. hz is the dominant frequency (9-12 reads as a
   * thud, 20+ as a buzz), ms the time to silence (quadratic decay), maxAmplitude a clamp on any
   * strength passed in (world units), maxRollDeg a clamp on roll, reducedMotionScale multiplies the
   * strength under prefers-reduced-motion (0 = impulses off).
   */
  impulse: Object.freeze({ hz: 10, ms: 260, maxAmplitude: 0.3, maxRollDeg: 2.5, reducedMotionScale: 0 }),
  /** focus(): blend-in and release times (ms) when a call does not give its own. */
  focus: Object.freeze({ inMs: 160, outMs: 420 }),
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

/** Impulse slots live at once; a further impulse replaces the one with the least energy left. */
const IMPULSE_SLOTS = 4;
const TWO_PI = 2 * Math.PI;

/**
 * Pure fight camera: smoothed follow, hit shake and push-in, final-KO orbit, Overwind lean, plus the
 * audit hooks: impulse()/shake() (whole-frame damped oscillation with optional roll), focus() (blend
 * the look-at toward a point and release) and `out.roll`. update() allocates nothing.
 * @param {{vfovDeg:number, reducedMotion?:boolean, cfg?: typeof CAMERA_FEEL}} opts
 *   cfg: a full CAMERA_FEEL-shaped object; `impulse` and `focus` fall back to the engine defaults when
 *   a partial override omits them.
 * @example const director = createCameraDirector({ vfovDeg: 50 });
 *   director.impulse({ dir: { x: 1, y: 0, z: 0 }, strength: 0.08, ms: 220, hz: 11, roll: 0.8 });
 *   director.focus({ target: loser.position, weight: 0.3, ms: 1500, lowerBy: 0.25, dollyIn: 0.1 });
 *   director.update(dtMs, framingTarget, separation, aspect, cam); camera.position.set(cam.x, cam.y, cam.z);
 */
export function createCameraDirector({ vfovDeg, reducedMotion = false, cfg = CAMERA_FEEL }) {
  const tanV = Math.tan((vfovDeg * Math.PI) / 360);
  const impCfg = cfg.impulse ?? CAMERA_FEEL.impulse;
  const focCfg = cfg.focus ?? CAMERA_FEEL.focus;
  const shakeHoldMs = cfg.shake.holdMs ?? 0;
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
  /** Reused by impact()'s directional kick so a hit allocates nothing. */
  const kickDir = { x: 0, y: 0, z: 0 };
  const kickOpts = { dir: kickDir, strength: 0, ms: 0 };
  /** Preallocated impulse pool: kick direction (k*), camera basis at fire time (r*, u*), timing. */
  const slots = [];
  for (let i = 0; i < IMPULSE_SLOTS; i++) {
    slots.push({ amp: 0, ms: 1, hz: 10, roll: 0, age: 0, active: false, iso: true, kx: 0, ky: 0, kz: 0, rx: 1, ry: 0, rz: 0, ux: 0, uy: 1, uz: 0 });
  }
  /** Focus state: target, weight, lower, dolly, envelope (mutated in place) and a release scale. */
  const foc = { x: 0, y: 0, z: 0, w: 0, lower: 0, dolly: 0, age: -1, scale: 1, env: { attackMs: 1, holdMs: 0, releaseMs: 1 } };

  /** Remaining energy of a slot (amplitude x decay), 0 when idle. */
  function slotEnergy(s) {
    if (!s.active) return 0;
    const u = s.age / s.ms;
    return u >= 1 ? 0 : s.amp * (1 - u) * (1 - u);
  }

  /**
   * Fire a damped camera oscillation that moves the whole frame (camera and look-at together), so the
   * fighters and the stage jolt as one. Directional: a kick along `dir` (world space, projected onto
   * the camera plane; a direction along the view axis kicks sideways) that rings at `hz` and decays
   * quadratically to silence over `ms`. Without `dir`: isotropic two-sine noise at `hz`. Up to four
   * impulses overlap; a fifth replaces the weakest. Strength and roll are clamped by cfg.impulse;
   * under reduced motion the strength is scaled by cfg.impulse.reducedMotionScale (0 = ignored).
   * @param {{dir?: {x:number,y?:number,z?:number}, strength: number, ms?: number, hz?: number, roll?: number}} o
   *   strength: peak offset in world units; ms: time to silence; hz: dominant frequency; roll: peak
   *   roll in degrees (signed), rings and decays with the kick.
   * @example director.impulse({ dir: { x: contact.x - defender.x, z: contact.z - defender.z }, strength: 0.08, ms: 220, hz: 11, roll: 0.6 });
   */
  function impulse(o) {
    let strength = o.strength > 0 ? o.strength : 0;
    if (still.reducedMotion) strength *= impCfg.reducedMotionScale;
    if (!(strength > 0)) return;
    let s = null;
    let weakest = Infinity;
    for (let i = 0; i < IMPULSE_SLOTS; i++) {
      const e = slotEnergy(slots[i]);
      if (e < weakest) { weakest = e; s = slots[i]; }
    }
    s.active = true;
    s.age = 0;
    s.amp = strength < impCfg.maxAmplitude ? strength : impCfg.maxAmplitude;
    s.ms = o.ms > 0 ? o.ms : impCfg.ms;
    s.hz = o.hz > 0 ? o.hz : impCfg.hz;
    const rollDeg = o.roll ?? 0;
    s.roll = Math.max(-impCfg.maxRollDeg, Math.min(impCfg.maxRollDeg, rollDeg)) * DEG;
    // camera basis at fire time (forward = look - eye, right = forward x up, up' = right x forward)
    let fx = cur.lx - cur.x;
    let fy = cur.ly - cur.y;
    let fz = cur.lz - cur.z;
    const fl = Math.hypot(fx, fy, fz) || 1;
    fx /= fl; fy /= fl; fz /= fl;
    let rx = -fz;
    let rz = fx;
    const rl = Math.hypot(rx, rz) || 1;
    rx /= rl; rz /= rl;
    s.rx = rx; s.ry = 0; s.rz = rz;
    // up' = right x forward (ry = 0)
    s.ux = -rz * fy; s.uy = rz * fx - rx * fz; s.uz = rx * fy;
    const d = o.dir;
    if (d && ((d.x ?? 0) !== 0 || (d.y ?? 0) !== 0 || (d.z ?? 0) !== 0)) {
      const dx = d.x ?? 0;
      const dy = d.y ?? 0;
      const dz = d.z ?? 0;
      const pr = dx * s.rx + dy * s.ry + dz * s.rz;
      const pu = dx * s.ux + dy * s.uy + dz * s.uz;
      const pl = Math.hypot(pr, pu);
      if (pl > 1e-6) {
        s.kx = (s.rx * pr + s.ux * pu) / pl; s.ky = (s.ry * pr + s.uy * pu) / pl; s.kz = (s.rz * pr + s.uz * pu) / pl;
      } else {
        s.kx = s.rx; s.ky = s.ry; s.kz = s.rz;
      }
      s.iso = false;
    } else {
      s.iso = true;
    }
  }

  /**
   * Non-directional shake: isotropic noise in the camera plane at `hz` (default cfg.impulse.hz),
   * decaying over `ms`. Sugar for impulse({ strength, ms, hz }).
   * @param {number} strength peak offset (world units) @param {number} [ms] @param {number} [hz]
   * @example director.shake(0.05, 200); // ground slam
   */
  function shake(strength, ms, hz) {
    impulse({ strength, ms, hz });
  }

  /**
   * Blend the look-at (and the camera with it) toward a world point, hold, then release: the KO
   * fall, a super-move beat, a cinematic. weight 1 centres the point, 0.3 leans toward it. lowerBy
   * lowers camera and look-at (world units) at full weight; dollyIn pushes in by that fraction
   * (HUD-clamped like every push; off under reduced motion). A second call restarts the blend from
   * the current level. The blend itself plays under reduced motion (no oscillation).
   * @param {{target: {x:number,y:number,z:number}, weight?: number, ms: number, lowerBy?: number, dollyIn?: number, inMs?: number, outMs?: number}} o
   *   ms: hold at full weight after the blend-in; inMs / outMs: blend-in and release (cfg.focus defaults)
   * @example director.focus({ target: loserRoot.position, weight: 0.35, ms: 1400, lowerBy: 0.25, dollyIn: 0.12 });
   */
  function focus(o) {
    const t = o.target;
    const live = focusLevel();
    foc.x = t.x; foc.y = t.y; foc.z = t.z;
    foc.w = o.weight ?? 1;
    foc.lower = o.lowerBy ?? 0;
    foc.dolly = still.reducedMotion ? 0 : (o.dollyIn ?? 0);
    const inMs = o.inMs ?? focCfg.inMs;
    foc.env.attackMs = inMs > 0 ? inMs : 1;
    foc.env.holdMs = o.ms > 0 ? o.ms : 0;
    foc.env.releaseMs = (o.outMs ?? focCfg.outMs) > 0 ? (o.outMs ?? focCfg.outMs) : 1;
    foc.scale = 1;
    foc.age = live * foc.env.attackMs; // continue from the current level rather than snapping to zero
  }

  /**
   * End a focus early: the release starts now from the current level (no snap) and lasts outMs
   * (default: the focus's own release time).
   * @param {number} [outMs]
   * @example director.release(300);
   */
  function release(outMs) {
    if (foc.age < 0) return;
    const live = focusLevel();
    if (live <= 0) { foc.age = -1; return; }
    foc.scale = live;
    foc.env.attackMs = 1;
    foc.env.holdMs = 0;
    if (outMs > 0) foc.env.releaseMs = outMs;
    foc.age = 1; // top of the release curve
  }

  /** Current focus blend 0..1 (tests/debug). */
  function focusLevel() {
    return foc.age < 0 ? 0 : foc.scale * pushEnvelope(foc.age, foc.env);
  }

  /**
   * One hit/KO for the camera. kind: move fx class ('light'|'heavy'|'throw'|'super'), 'guard',
   * 'armor' or 'ko'; shake: the event's 0..1 shake value. dirX/dirZ (optional): hit direction in
   * world space; with cfg.shake.kick > 0 it fires a directional impulse of amplitude x kick.
   */
  function impact(kind, shake, dirX, dirZ) {
    if (still.reducedMotion) return;
    const w = cfg.shake.weights[kind] ?? 1;
    const amp = shake * w * cfg.shake.maxAmplitude;
    const live = shakeAmp * (shakeLeft / cfg.shake.durationMs) ** 2;
    if (amp >= live) {
      shakeAmp = amp;
      shakeLeft = cfg.shake.durationMs;
    }
    if (cfg.shake.kick > 0 && amp > 0 && dirX !== undefined) {
      kickDir.x = dirX; kickDir.z = dirZ ?? 0;
      kickOpts.strength = amp * cfg.shake.kick;
      kickOpts.ms = cfg.shake.kickMs;
      impulse(kickOpts);
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
    foc.age = -1;
    for (let i = 0; i < IMPULSE_SLOTS; i++) slots[i].active = false;
  }

  /**
   * Advance by dtMs and write the camera pose.
   * @param {number} dtMs real ms since the last frame
   * @param {{x:number,y:number,z:number,lx:number,ly:number,lz:number}} target framing.js output
   * @param {number} sep fighter separation (world units) @param {number} aspect width/height
   * @param {{x:number,y:number,z:number,lx:number,ly:number,lz:number,roll?:number}} out camera position,
   *   look-at and roll (radians about the view axis; 0 unless an impulse carries roll)
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
    let dy = 0;
    if (foc.age >= 0) {
      foc.age += dtMs > 0 ? dtMs : 0;
      const e = focusLevel();
      if (e === 0 && foc.age > foc.env.attackMs) foc.age = -1;
      else {
        const dx = (foc.x - cur.lx) * foc.w * e;
        const dz = (foc.z - cur.lz) * foc.w * e;
        dy = (foc.y - cur.ly) * foc.w * e - foc.lower * e;
        lx += dx;
        lz += dz;
        ly += dy;
        clampSep += 2 * Math.hypot(dx, dz);
        want = Math.max(want, foc.dolly * e);
      }
    }
    const dist = Math.hypot(ox, oy, oz);
    const k = 1 - clampPush(want, dist, clampSep, tanV, aspect, ly, cfg.clamp);
    out.x = lx + ox * k;
    out.y = cur.ly + dy + oy * k;
    out.z = lz + oz * k;
    out.lx = lx;
    out.ly = ly;
    out.lz = lz;
    out.roll = 0;
    if (shakeLeft > 0) {
      shakeLeft = Math.max(0, shakeLeft - (dtMs > 0 ? dtMs : 0));
      const held = cfg.shake.durationMs - shakeHoldMs;
      const f = shakeLeft > held ? 1 : shakeLeft / held;
      const a = shakeAmp * f * f;
      const w = (clock / 1000) * cfg.shake.freqHz * TWO_PI;
      const sx = a * (0.6 * Math.sin(w) + 0.4 * Math.sin(1.73 * w + 1.3));
      const sy = a * (0.6 * Math.sin(1.31 * w + 0.7) + 0.4 * Math.sin(2.11 * w + 2.1));
      out.x += sx;
      out.y += sy;
      if (cfg.shake.coupleLookAt === true) {
        out.lx += sx;
        out.ly += sy;
      }
    }
    for (let i = 0; i < IMPULSE_SLOTS; i++) {
      const s = slots[i];
      if (!s.active) continue;
      s.age += dtMs > 0 ? dtMs : 0;
      const u = s.age / s.ms;
      if (u >= 1) { s.active = false; continue; }
      const env = (1 - u) * (1 - u);
      const w = (s.age / 1000) * s.hz * TWO_PI;
      let ix;
      let iy;
      let iz;
      if (s.iso) {
        const a = s.amp * env;
        const nr = a * (0.6 * Math.sin(w) + 0.4 * Math.sin(1.73 * w + 1.3));
        const nu = a * (0.6 * Math.sin(1.31 * w + 0.7) + 0.4 * Math.sin(2.11 * w + 2.1));
        ix = s.rx * nr + s.ux * nu; iy = s.ry * nr + s.uy * nu; iz = s.rz * nr + s.uz * nu;
      } else {
        const a = s.amp * env * Math.cos(w); // peak along the kick at t = 0, then rings
        ix = s.kx * a; iy = s.ky * a; iz = s.kz * a;
      }
      out.x += ix; out.y += iy; out.z += iz;
      out.lx += ix; out.ly += iy; out.lz += iz;
      out.roll += s.roll * env * Math.cos(w);
    }
    return out;
  }

  /** Current push-in fraction actually wanted (tests/debug). */
  const pushNow = () => (pushWant > 0 ? pushWant * pushEnvelope(pushAge, cfg.push) : 0);
  /** Current shake amplitude (tests/debug). */
  const shakeNow = () => (shakeLeft > 0 ? shakeAmp * (shakeLeft / cfg.shake.durationMs) ** 2 : 0);
  /** Sum of the live impulse amplitudes (tests/debug). */
  const impulseNow = () => {
    let sum = 0;
    for (let i = 0; i < IMPULSE_SLOTS; i++) sum += slotEnergy(slots[i]);
    return sum;
  };
  /** True while a focus blend is active (tests/debug). */
  const focusActive = () => foc.age >= 0;

  /** True while the Overwind push is playing (tests/debug). */
  const overwindActive = () => owAge >= 0;

  return {
    impact, finalKo, overwind, reset, update, pushNow, shakeNow, overwindActive, still,
    impulse, shake, focus, release, impulseNow, focusLevel, focusActive,
  };
}

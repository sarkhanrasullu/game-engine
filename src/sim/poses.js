// Code-keyed fighter poses (story-003 AC 4, 5). Pure and allocation-free: no DOM, no three.js.
// computePose maps sim state + frame (read-only) to joint angles for the procedural rig
// (rig.js applies them). Angles are radians, distances world units, in the fighter's local frame:
// +z = facing, +y = up, +x = the fighter's left.
//
// Angle conventions (rig.js applies the same ones):
//   *Pitch on a limb  = forward swing of a hanging segment (0 = straight down, 90deg = pointing ahead)
//   *Roll  on a limb  = outward swing away from the body centre line
//   *Elbow            = forearm folds forward/up; *Knee = shin folds backward
//   torsoPitch / headPitch = lean forward; hipYaw / torsoYaw = twist; hipRoll / torsoRoll = side lean
//   lungeX / lungeZ / hipLift = hip translation; hipY = hip height (derived, see groundHipY)
import { STATE, PHASE, attackPhase } from './state-machine.js';

/** Data-driven pose fields (fighter JSON). Everything except DIST_KEYS is an angle in degrees there. */
export const POSE_KEYS = Object.freeze([
  'lungeX', 'lungeZ', 'hipLift', 'hipYaw', 'hipRoll',
  'torsoPitch', 'torsoYaw', 'torsoRoll', 'headPitch', 'headYaw',
  'armLPitch', 'armLRoll', 'armLElbow', 'armRPitch', 'armRRoll', 'armRElbow',
  'legLPitch', 'legLRoll', 'legLKnee', 'legRPitch', 'legRRoll', 'legRKnee',
]);
/** Pose fields in world units (not converted from degrees). */
export const DIST_KEYS = Object.freeze(['lungeX', 'lungeZ', 'hipLift']);

/** Share of the startup frames spent coiling into the wind-up pose before swinging to the strike. */
export const WINDUP_SHARE = 0.65;
const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

/** New pose with every field zeroed, plus the derived hipY and keyRate (rev/s). */
export function createPose() {
  const p = {};
  for (const k of POSE_KEYS) p[k] = 0;
  p.hipY = 0;
  p.keyRate = 0;
  return p;
}

/** Per-fighter render-side animation state (clock and walk-cycle phase). */
export function createPoseContext() {
  return { time: 0, walkPhase: 0 };
}

/** Copy the data fields of `a` into `out`. */
export function copyPose(out, a) {
  for (let i = 0; i < POSE_KEYS.length; i++) out[POSE_KEYS[i]] = a[POSE_KEYS[i]];
  return out;
}

/** out = a + (b - a) * t over the data fields (out may alias a or b). */
export function lerpPose(out, a, b, t) {
  for (let i = 0; i < POSE_KEYS.length; i++) {
    const k = POSE_KEYS[i];
    out[k] = a[k] + (b[k] - a[k]) * t;
  }
  return out;
}

/** out += d * t over the data fields (additive delta poses such as hit recoil). */
export function addPose(out, d, t) {
  for (let i = 0; i < POSE_KEYS.length; i++) {
    const k = POSE_KEYS[i];
    out[k] += d[k] * t;
  }
  return out;
}

/** Smoothstep on t clamped to [0, 1]. */
export function smooth(t) {
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return c * c * (3 - 2 * c);
}

/**
 * Write the attack pose for frame `n` of `move` (stateFrame convention of state-machine.js) into out.
 * Startup coils base -> windup, then swings windup -> strike so the strike pose is reached on the
 * first active frame; active holds the strike; recovery eases strike -> base.
 */
export function attackPose(out, base, move, n) {
  const s = move.startup;
  if (n <= s) {
    const u = n / (s + 1);
    if (u < WINDUP_SHARE) return lerpPose(out, base, move.windupPose, smooth(u / WINDUP_SHARE));
    return lerpPose(out, move.windupPose, move.strikePose, smooth((u - WINDUP_SHARE) / (1 - WINDUP_SHARE)));
  }
  if (n <= s + move.active) return copyPose(out, move.strikePose);
  return lerpPose(out, move.strikePose, base, smooth((n - s - move.active) / move.recovery));
}

/**
 * Recoil weight 0..1 for a stun state: ramps up over `peak` frames, then decays to 0 as the stun
 * runs out. n = ticks in the state, left = stun ticks remaining.
 */
export function stunAmount(n, left, peak) {
  if (n <= peak) return peak > 0 ? n / peak : 1;
  const tail = n + left - peak;
  if (tail <= 0) return 0;
  const a = left / tail;
  return a < 0 ? 0 : a > 1 ? 1 : a;
}

/** Vertical drop from hip joint to floor for one leg (ankle height included). */
function legDrop(p, pitch, roll, knee) {
  return Math.cos(roll) * (p.thigh * Math.cos(pitch) + p.shin * Math.cos(pitch - knee)) + p.ankle;
}

/** Hip height that plants the lower foot on the floor for this leg pose. */
export function groundHipY(spec, pose) {
  const p = spec.proportions;
  const l = legDrop(p, pose.legLPitch, pose.legLRoll, pose.legLKnee);
  const r = legDrop(p, pose.legRPitch, pose.legRRoll, pose.legRKnee);
  return l > r ? l : r;
}

/**
 * Forward kinematics of a limb's striking tip (glove/hand front, or ankle) in the fighter's
 * sagittal plane: writes out.y (height above feet) and out.z (distance ahead). Twist (yaw) is
 * ignored, roll shortens the chain. Uses pose.hipY, so call after computePose.
 * @param {'armL'|'armR'|'legL'|'legR'} limb
 * @param {{y:number,z:number}} out
 */
export function limbTip(spec, pose, limb, out) {
  const p = spec.proportions;
  const hipY = pose.hipY + pose.hipLift;
  let baseY;
  let baseZ;
  let a1;
  let a2;
  let l1;
  let l2;
  let roll;
  if (limb === 'armL' || limb === 'armR') {
    const lean = pose.torsoPitch;
    baseY = hipY + p.shoulderY * Math.cos(lean);
    baseZ = pose.lungeZ + p.shoulderY * Math.sin(lean);
    const pitch = limb === 'armL' ? pose.armLPitch : pose.armRPitch;
    const elbow = limb === 'armL' ? pose.armLElbow : pose.armRElbow;
    roll = limb === 'armL' ? pose.armLRoll : pose.armRRoll;
    a1 = pitch - lean;
    a2 = a1 + elbow;
    l1 = p.upperArm;
    l2 = p.foreArm + p.hand;
  } else {
    baseY = hipY;
    baseZ = pose.lungeZ;
    const pitch = limb === 'legL' ? pose.legLPitch : pose.legRPitch;
    const knee = limb === 'legL' ? pose.legLKnee : pose.legRKnee;
    roll = limb === 'legL' ? pose.legLRoll : pose.legRRoll;
    a1 = pitch;
    a2 = pitch - knee;
    l1 = p.thigh;
    l2 = p.shin + p.ankle;
  }
  const c = Math.cos(roll);
  out.y = baseY - c * (l1 * Math.cos(a1) + l2 * Math.cos(a2));
  out.z = baseZ + c * (l1 * Math.sin(a1) + l2 * Math.sin(a2));
  return out;
}

/** Height of the top of the head above the feet for a pose (head pitch ignored). */
export function headTopY(spec, pose) {
  const p = spec.proportions;
  return pose.hipY + pose.hipLift + (p.neckY + p.head[1]) * Math.cos(pose.torsoPitch);
}

/** Wind-up key spin rate (revolutions/second) for the fighter's state; 0 when it has no key. */
export function keySpinRate(spec, f) {
  const k = spec.key;
  if (!k) return 0;
  switch (f.state) {
    case STATE.ATTACK: {
      const ph = attackPhase(f);
      return ph === PHASE.STARTUP ? k.windup : ph === PHASE.ACTIVE ? k.active : k.recovery;
    }
    case STATE.WALK:
    case STATE.SIDESTEP:
    case STATE.JUMP:
      return k.walk;
    case STATE.GUARD:
    case STATE.BLOCKSTUN:
      return k.guard;
    case STATE.HITSTUN:
    case STATE.THROWN:
    case STATE.TECH:
      return k.stun;
    case STATE.KO:
      return 0;
    default:
      return k.idle;
  }
}

/**
 * Pose for fighter `f` (sim state, read only) into `out`. ctx carries the render clock (ctx.time,
 * seconds) for idle bob and the walk-cycle phase (ctx.walkPhase, radians); everything else comes
 * from state + stateFrame, so a frozen sim (hitstop) freezes the pose.
 * KO with stateFrame > 0 returns the neutral (all-zero) pose: ko-break.js takes over from there.
 */
export function computePose(spec, f, ctx, out) {
  const P = spec.poses;
  const D = spec.deltas;
  const A = spec.anim;
  const n = f.stateFrame;
  let airborne = !f.grounded;
  switch (f.state) {
    case STATE.WALK: {
      const w = A.walk;
      const s = Math.sin(ctx.walkPhase);
      copyPose(out, P.stand);
      out.legLPitch += w.stride * s;
      out.legRPitch -= w.stride * s;
      out.legLKnee += w.knee * (s < 0 ? -s : 0);
      out.legRKnee += w.knee * (s > 0 ? s : 0);
      out.armLPitch -= w.armSwing * s;
      out.armRPitch += w.armSwing * s;
      break;
    }
    case STATE.CROUCH:
      copyPose(out, P.crouch);
      break;
    case STATE.JUMP:
      copyPose(out, P.jump);
      airborne = true;
      break;
    case STATE.SIDESTEP: {
      const dur = spec.movement.sidestepDuration;
      const u = dur > 0 ? 1 - f.sidestepT / dur : 1;
      const k = Math.sin(Math.PI * (u < 0 ? 0 : u > 1 ? 1 : u));
      const dir = f.sidestepDir < 0 ? -1 : 1;
      copyPose(out, P.stand);
      out.hipRoll += dir * A.sidestep.lean * k;
      out.legLRoll += A.sidestep.legSpread * k;
      out.legRRoll += A.sidestep.legSpread * k;
      break;
    }
    case STATE.ATTACK:
      attackPose(out, f.move.crouching ? P.crouch : P.stand, f.move, n);
      break;
    case STATE.GUARD:
      copyPose(out, f.crouching ? P.crouchGuard : P.guard);
      break;
    case STATE.BLOCKSTUN:
      copyPose(out, f.crouching ? P.crouchGuard : P.guard);
      addPose(out, D.blockstun, stunAmount(n, f.stunLeft, A.stunPeakFrames));
      break;
    case STATE.HITSTUN:
      copyPose(out, f.crouching ? P.crouch : P.stand);
      addPose(out, D.hitstun, stunAmount(n, f.stunLeft, A.stunPeakFrames));
      break;
    case STATE.THROWN:
      copyPose(out, P.stand);
      addPose(out, D.thrown, stunAmount(n, f.stunLeft, A.stunPeakFrames));
      out.hipYaw += n * A.thrownSpinPerFrame;
      break;
    case STATE.TECH:
      // Both fighters recoil from the broken grab: the kit's optional `deltas.tech`, else its block recoil.
      copyPose(out, P.stand);
      addPose(out, D.tech ?? D.blockstun, stunAmount(n, f.stunLeft, A.stunPeakFrames));
      break;
    case STATE.KO:
      if (n > 0) {
        copyPose(out, P.neutral);
        out.hipY = spec.legLength;
        out.keyRate = 0;
        return out;
      }
      // KO hitstop freeze: hold the full recoil until the springs pop.
      copyPose(out, P.stand);
      addPose(out, D.hitstun, 1);
      break;
    default: {
      // idle (and any state without its own pose): breathing bob.
      const i = A.idle;
      const b = Math.sin(TAU * i.bobHz * ctx.time);
      copyPose(out, f.crouching ? P.crouch : P.stand);
      out.hipLift += i.bobAmp * (0.5 + 0.5 * b);
      out.torsoPitch += i.breath * b;
      break;
    }
  }
  out.hipY = airborne ? spec.standHipY : groundHipY(spec, out);
  out.keyRate = keySpinRate(spec, f);
  return out;
}

/** Degrees -> radians for a partial pose object from data (distance fields pass through). */
export function poseFromData(partial, base) {
  const out = createPose();
  if (base) copyPose(out, base);
  if (!partial) return out;
  for (const k of Object.keys(partial)) {
    if (!POSE_KEYS.includes(k)) throw new Error(`unknown pose field ${k}`);
    out[k] = DIST_KEYS.includes(k) ? partial[k] : partial[k] * DEG;
  }
  return out;
}

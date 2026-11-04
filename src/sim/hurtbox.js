// Joint-following hurtboxes (story-003 AC 5; design/game-brief.md MVP feature 3).
// Pure, deterministic and allocation-free: no DOM, no three.js. The sim poses the fighter with
// computePose on a fixed sim context (time 0, walk phase 0), so the hurtbox depends only on sim
// state + frame, never on the render clock.
//
//   body : upright cylinder around the hips (shifted by the pose's lunge along the facing), from
//          the lowest foot to the top of the head -> a crouch pose lowers it, a jump tuck lifts it.
//   limb : while attacking, a cylinder around the striking limb's tip (fist or foot), so an
//          extended limb can be struck.
// Radii come from the kit JSON ("hurtbox": bodyRadius, limbRadius). Un-equipped greybox fighters
// keep the rules-driven cylinder of fighter.js updateHurtbox.
import { STATE } from './state-machine.js';
import { updateHurtbox } from './fighter.js';
import { computePose, groundHipY, headTopY, limbTip } from './poses.js';

const tip = { y: 0, z: 0 };

/**
 * Refresh f.hurtbox (body) and f.limbHurtbox / f.limbHurtActive from the fighter's current pose.
 * @param {ReturnType<typeof import('./fighter.js').createCombatant>} f
 * @param {Readonly<Record<string, number>>} rules ruleset.rules (greybox cylinder for an un-equipped fighter)
 * @returns {object} f.hurtbox
 * @example updateHurtboxes(f, sim.rules);
 */
export function updateHurtboxes(f, rules) {
  const spec = f.spec;
  if (spec === null || spec === undefined || f.simPose === null) {
    f.limbHurtActive = false;
    return updateHurtbox(f, rules);
  }
  const pose = computePose(spec, f, f.simPoseCtx, f.simPose);
  const attacking = f.state === STATE.ATTACK;
  const yaw = attacking ? f.attackYaw : f.yaw;
  const dx = Math.sin(yaw);
  const dz = Math.cos(yaw);
  const hb = spec.hurtbox;

  const h = f.hurtbox;
  const hipY = pose.hipY + pose.hipLift;
  const feet = hipY - groundHipY(spec, pose);
  h.x = f.x + dx * pose.lungeZ;
  h.z = f.z + dz * pose.lungeZ;
  h.r = hb.bodyRadius;
  h.y0 = f.y + (feet > 0 ? feet : 0);
  h.y1 = f.y + headTopY(spec, pose);

  f.limbHurtActive = attacking && f.move !== null && f.move.limb !== undefined;
  if (f.limbHurtActive) {
    limbTip(spec, pose, f.move.limb, tip);
    const l = f.limbHurtbox;
    l.x = f.x + dx * tip.z;
    l.z = f.z + dz * tip.z;
    l.r = hb.limbRadius;
    l.y0 = f.y + tip.y - hb.limbRadius;
    l.y1 = f.y + tip.y + hb.limbRadius;
  }
  return h;
}

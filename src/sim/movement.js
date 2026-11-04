// Greybox fighter movement (pure, fixed-step). Implements story-001 AC 1, 2, 6.
// Convention: stick.x > 0 = toward opponent ("forward"), stick.y > 0 = up (jump), < 0 = crouch.
// Sidestep +1 circles away from the camera, -1 toward it, keeping distance to the opponent.

const EPS = 1e-4;

/** @param {number} x @param {number} z */
export function createFighter(x, z) {
  return {
    x, y: 0, z,
    prevX: x, prevY: 0, prevZ: z,
    vy: 0,
    grounded: true,
    airTime: 0,
    crouching: false,
    sidestepT: 0,
    sidestepDir: 0,
    yaw: 0,
  };
}

/**
 * Advance one fighter by dt. Mutates `f`; allocation-free.
 * @param {ReturnType<typeof createFighter>} f
 * @param {{x:number,z:number}} opp opponent (read only)
 * @param {{stick:{x:number,y:number},sidestep:number}} input
 * @param {number} dt seconds
 * @param {Readonly<Record<string, number>>} cfg movement config (ruleset.movement or a kit's)
 * @example stepFighter(f, opp, snapshot, 1 / 60, f.movement);
 */
export function stepFighter(f, opp, input, dt, cfg) {
  f.prevX = f.x;
  f.prevY = f.y;
  f.prevZ = f.z;

  let nx = opp.x - f.x;
  let nz = opp.z - f.z;
  let d = Math.hypot(nx, nz);
  if (d < EPS) {
    nx = 1;
    nz = 0;
    d = 0;
  } else {
    nx /= d;
    nz /= d;
  }
  f.yaw = Math.atan2(nx, nz);

  // Sidestep trigger.
  if (input.sidestep !== 0 && f.sidestepT <= 0 && (f.grounded || f.airTime <= cfg.sidestepJumpCancelTime)) {
    f.y = 0;
    f.vy = 0;
    f.grounded = true;
    f.airTime = 0;
    f.sidestepT = cfg.sidestepDuration;
    f.sidestepDir = input.sidestep > 0 ? 1 : -1;
  }

  // Crouch / jump (ground only, not mid-sidestep).
  const sy = input.stick.y;
  if (f.grounded && f.sidestepT <= 0) {
    f.crouching = sy < -cfg.verticalThreshold;
    if (sy > cfg.verticalThreshold) {
      f.vy = cfg.jumpSpeed;
      f.grounded = false;
      f.airTime = 0;
    }
  } else {
    f.crouching = false;
  }

  if (!f.grounded) {
    f.vy -= cfg.gravity * dt;
    f.y += f.vy * dt;
    f.airTime += dt;
    if (f.y <= 0) {
      f.y = 0;
      f.vy = 0;
      f.grounded = true;
      f.airTime = 0;
    }
  }

  if (f.sidestepT > 0) {
    const s = f.sidestepDir * cfg.sidestepSpeed * dt;
    // tangent "away from camera" = (nz, -nx); re-project onto the circle around the opponent
    f.x += nz * s;
    f.z -= nx * s;
    if (d > 0) {
      let rx = f.x - opp.x;
      let rz = f.z - opp.z;
      const rl = Math.hypot(rx, rz);
      if (rl > EPS) {
        const k = d / rl;
        rx *= k;
        rz *= k;
        f.x = opp.x + rx;
        f.z = opp.z + rz;
      }
    }
    f.sidestepT -= dt;
  } else if (!f.crouching) {
    const sx = input.stick.x;
    const adv = sx > -cfg.deadzone && sx < cfg.deadzone ? 0 : sx;
    const speed = (adv > 0 ? cfg.walkSpeed : cfg.backSpeed) * adv * dt;
    f.x += nx * speed;
    f.z += nz * speed;
  }

  // Keep out of the opponent.
  let rx = f.x - opp.x;
  let rz = f.z - opp.z;
  const rl = Math.hypot(rx, rz);
  if (rl < cfg.minSeparation) {
    if (rl > EPS) {
      rx /= rl;
      rz /= rl;
    } else {
      rx = -nx;
      rz = -nz;
    }
    f.x = opp.x + rx * cfg.minSeparation;
    f.z = opp.z + rz * cfg.minSeparation;
  }

  // Stay on the ring.
  const r = Math.hypot(f.x, f.z);
  if (r > cfg.ringRadius) {
    const k = cfg.ringRadius / r;
    f.x *= k;
    f.z *= k;
  }
}

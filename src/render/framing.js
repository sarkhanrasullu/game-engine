// Camera framing math (pure). Camera sits perpendicular to the line between fighters so
// fighter 1 is always screen-left and "forward" is always screen-right. (story-001 AC 6)

export const FRAMING_CONFIG = Object.freeze({
  /** Extra world units each side of the fighters kept in view. */
  margin: 2.4,
  /** Never frame tighter than this half-width. */
  minHalfWidth: 3.6,
  height: 2.2,
  lookAtY: 0.6,
  /** Added height per unit distance so wide shots tilt down a little. */
  heightPerDistance: 0.12,
});

/**
 * @param {number} ax fighter 1 x @param {number} az fighter 1 z
 * @param {number} bx fighter 2 x @param {number} bz fighter 2 z
 * @param {number} vfovDeg vertical FOV @param {number} aspect width/height
 * @param {{x:number,y:number,z:number,lx:number,ly:number,lz:number}} out camera position + look-at
 */
export function computeFraming(ax, az, bx, bz, vfovDeg, aspect, out, cfg = FRAMING_CONFIG) {
  let dx = bx - ax;
  let dz = bz - az;
  const sep = Math.hypot(dx, dz);
  if (sep < 1e-4) {
    dx = 1;
    dz = 0;
  } else {
    dx /= sep;
    dz /= sep;
  }
  const halfW = Math.max(sep / 2 + cfg.margin, cfg.minHalfWidth);
  const tanV = Math.tan((vfovDeg * Math.PI) / 360);
  const dist = halfW / (tanV * aspect);
  const mx = (ax + bx) / 2;
  const mz = (az + bz) / 2;
  // camera forward f = (dz, 0, -dx); position = mid - f * dist
  out.x = mx - dz * dist;
  out.y = cfg.height + dist * cfg.heightPerDistance;
  out.z = mz + dx * dist;
  out.lx = mx;
  out.ly = cfg.lookAtY;
  out.lz = mz;
  return out;
}

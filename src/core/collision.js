// Upright-cylinder overlap tests for hitboxes and hurtboxes (story-002 AC 2).
// DOM/three-free and allocation-free: callers own and reuse the cylinder objects.

/**
 * An upright cylinder: circle (x, z, r) on the ground plane spanning heights y0..y1.
 * @returns {{x:number,z:number,r:number,y0:number,y1:number}}
 */
export function createCylinder() {
  return { x: 0, z: 0, r: 0, y0: 0, y1: 0 };
}

/**
 * True when two upright cylinders intersect (touching counts as overlap).
 * @param {ReturnType<typeof createCylinder>} a
 * @param {ReturnType<typeof createCylinder>} b
 */
export function cylindersOverlap(a, b) {
  if (a.y1 < b.y0 || b.y1 < a.y0) return false;
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  const rr = a.r + b.r;
  return dx * dx + dz * dz <= rr * rr;
}

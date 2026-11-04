// Hero geometry helpers (ADR-0001 HERO-1): bevelled armour plates, frusta and rings for the
// procedural skinned heroes. Plates are Extrude geometry with a chamfer/bevel and creased (smooth)
// normals so edges catch the highlight (art bible R2-2: plates are never raw boxes).
// Verified against node_modules/three/src (r187): Shape, ExtrudeGeometry (bevelThickness/bevelSize/
// bevelSegments, non-indexed), CylinderGeometry, LatheGeometry, BufferGeometryUtils.toCreasedNormals.
import * as THREE from 'three';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';

/** Crease angle that smooths a bevel into its faces but keeps the 90 degree plate corners hard. */
const CREASE = (50 * Math.PI) / 180;

/**
 * Extruded, bevelled plate from a 2D outline (x right, y up) extruded along z and centred on z.
 * `pts` describe the widest silhouette (the bevel rounds inward from it).
 * @param {number[][]} pts outline vertices [x, y] in either winding
 * @param {number} depth thickness along z including both bevels (the flat middle is `depth - 2 * bevel`)
 * @param {{bevel?: number, segs?: number}} [o]
 * @returns {THREE.BufferGeometry} non-indexed geometry with position, normal
 * @example plate(chamferRect(0.3, 0.2, 0.04), 0.1, { bevel: 0.012, segs: 2 })
 */
export function plate(pts, depth, { bevel = 0.012, segs = 2 } = {}) {
  const shape = new THREE.Shape();
  pts.forEach(([x, y], i) => (i === 0 ? shape.moveTo(x, y) : shape.lineTo(x, y)));
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(0.001, depth - 2 * bevel), bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelOffset: -bevel, bevelSegments: segs, curveSegments: 1, steps: 1,
  });
  g.translate(0, 0, -(depth - 2 * bevel) / 2);
  g.deleteAttribute('uv');
  const out = toCreasedNormals(g, CREASE);
  g.dispose();
  return out;
}

/**
 * Outline of a w x h rectangle centred on the origin with the corners cut by `c`.
 * @example chamferRect(0.4, 0.2, 0.05) // 8 points
 */
export function chamferRect(w, h, c) {
  const x = w / 2;
  const y = h / 2;
  return [[-x + c, -y], [x - c, -y], [x, -y + c], [x, y - c], [x - c, y], [-x + c, y], [-x, y - c], [-x, -y + c]];
}

/**
 * Outline of an isosceles trapezoid centred on the origin: `wTop` wide at +h/2, `wBot` at -h/2, the
 * four corners cut by `c`.
 */
export function trapezoid(wTop, wBot, h, c = 0.02) {
  const t = wTop / 2;
  const b = wBot / 2;
  const y = h / 2;
  return [[-b + c, -y], [b - c, -y], [b, -y + c], [t, y - c], [t - c, y], [-t + c, y], [-t, y - c], [-b, -y + c]];
}

/**
 * Bevelled slab: a chamfered box w x h x d centred on the origin.
 * @example slab(0.3, 0.1, 0.2, { chamfer: 0.03, bevel: 0.01, segs: 2 })
 */
export function slab(w, h, d, { chamfer = 0.03, bevel = 0.01, segs = 2 } = {}) {
  return plate(chamferRect(w, h, chamfer), d, { bevel, segs });
}

/**
 * Cone frustum hanging from y = y0 down to y1 (y1 < y0) with radii r0 (top) and r1 (bottom).
 * Non-indexed with smooth normals; caps are included.
 */
export function frustum(r0, r1, y0, y1, radial = 10, caps = true) {
  const g = new THREE.CylinderGeometry(r0, r1, y0 - y1, radial, 1, !caps).translate(0, (y0 + y1) / 2, 0);
  g.deleteAttribute('uv');
  return g;
}

/** Flat ring (a short open tube) of radius r, height h, centred at y. Used for glowing seam bands. */
export function band(r, h, y, radial = 12) {
  const g = new THREE.CylinderGeometry(r, r, h, radial, 1, true).translate(0, y, 0);
  g.deleteAttribute('uv');
  return g;
}

/**
 * Lathe solid from a [radius, y] profile (bottom to top), smooth normals.
 * @example lathe([[0.04, 0], [0.06, 0.05], [0.05, 0.12]], 10)
 */
export function lathe(profile, radial = 12) {
  const g = new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(r, y)), radial);
  g.deleteAttribute('uv');
  return g;
}

/** Mirror helper: x outline points for side `s` (+1 or -1). Winding is normalised by ExtrudeGeometry. */
export function mirrorPts(pts, s) {
  return pts.map(([x, y]) => [x * s, y]);
}

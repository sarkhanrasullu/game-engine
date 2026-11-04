// Procedural rig (engine /render, ADR-0001 HERO-1): a tree of THREE.Bone joints that a game's fighter
// builders hang meshes on (a toy builder attaches primitives to the joints; a hero builder skins
// merged meshes to the same bones, see skin.js), plus the shared toy material (flat-shaded
// Lambert with a warm toon rim term). applyPose writes a sim pose onto the joints, allocation-free.
// Verified against node_modules/three/src (r187): Bone (Object3D subclass), MeshLambertMaterial.flatShading,
// Material.onBeforeCompile/customProgramCacheKey, lambert shader chunks <emissivemap_fragment>
// and vViewPosition, <opaque_fragment> (reads outgoingLight), BufferGeometry.translate/toNonIndexed, addons mergeGeometries.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';


const RIM_PARS = /* glsl */ `#include <common>
uniform vec3 rimColor;
uniform float rimStrength;
uniform float rimStart;
uniform float rimEnd;`;
const RIM_APPLY = /* glsl */ `#include <emissivemap_fragment>
float rimF = 1.0 - saturate( dot( normal, normalize( vViewPosition ) ) );
totalEmissiveRadiance += rimColor * rimStrength * smoothstep( rimStart, rimEnd, rimF );`;
/** Art bible §5: rim + key (and any hit flash) never exceed 1.0 before tone mapping. */
const RIM_CLAMP = /* glsl */ `outgoingLight = min( outgoingLight, vec3( 1.0 ) );
#include <opaque_fragment>`;

/**
 * Rim uniforms shared by every material of one fighter.
 * @param {{color:string,strength:number,start:number,end:number}} rim
 */
export function createRimUniforms(rim) {
  return {
    rimColor: { value: new THREE.Color(rim.color) },
    rimStrength: { value: rim.strength },
    rimStart: { value: rim.start },
    rimEnd: { value: rim.end },
  };
}

/**
 * Flat-shaded Lambert toy material with a hard warm rim (toon edge) added to emissive.
 * All toy materials share one shader program (fixed cache key).
 */
export function createToyMaterial(color, rimUniforms) {
  const mat = new THREE.MeshLambertMaterial({ color, flatShading: true });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, rimUniforms);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', RIM_PARS)
      .replace('#include <emissivemap_fragment>', RIM_APPLY)
      .replace('#include <opaque_fragment>', RIM_CLAMP);
  };
  mat.customProgramCacheKey = () => 'wk-toy-rim';
  return mat;
}

/**
 * The fighter's material set from its palette: paint (body; the hit-flash target), trim, dark,
 * accent, glove (palette.glove, else trim; all rim-lit Lambert) and eye (unlit). Each fighter gets its own set so a hit flash
 * on one fighter does not light the other.
 */
export function createToyMaterials(spec) {
  const rim = createRimUniforms(spec.rim);
  const c = spec.palette;
  const mats = {
    paint: createToyMaterial(c.paint, rim),
    trim: createToyMaterial(c.trim, rim),
    dark: createToyMaterial(c.dark, rim),
    accent: createToyMaterial(c.accent, rim),
    glove: c.glove ? createToyMaterial(c.glove, rim) : null,
    eye: new THREE.MeshBasicMaterial({ color: c.eye }),
  };
  if (!mats.glove) mats.glove = mats.trim;
  return mats;
}

/**
 * Merge primitive geometries into one (one draw call). Each input may be indexed or not; they
 * are de-indexed so mixed primitives merge. Inputs are disposed.
 * @param {THREE.BufferGeometry[]} geos
 */
export function mergeParts(geos) {
  const flat = geos.map((g) => (g.index ? g.toNonIndexed() : g));
  const merged = mergeGeometries(flat);
  for (const g of geos) g.dispose();
  for (const g of flat) g.dispose();
  return merged;
}

/** Box geometry centred at (x, y, z). */
export function boxAt(w, h, d, x = 0, y = 0, z = 0) {
  return new THREE.BoxGeometry(w, h, d).translate(x, y, z);
}

/** Low-poly ball centred at (x, y, z). */
export function ballAt(r, x = 0, y = 0, z = 0, w = 6, h = 4) {
  return new THREE.SphereGeometry(r, w, h).translate(x, y, z);
}

/** Limb segment hanging down from its joint: top at y = 0, bottom at y = -length. */
export function segment(rTop, rBottom, length, sides = 6) {
  return new THREE.CylinderGeometry(rTop, rBottom, length, sides).translate(0, -length / 2, 0);
}

/** Add a mesh (no shadow casting: fighters use blob shadows) to a joint. */
export function attach(joint, geometry, material) {
  const m = new THREE.Mesh(geometry, material);
  joint.add(m);
  return m;
}

/**
 * Build the joint tree from spec.proportions. The root sits at the fighter's feet facing +z.
 * Joints (all THREE.Bone, `name` = the key below): root > hips > {torso > {head, armL > elbowL >
 * handL, armR > ..., keyMount > key}, legL > kneeL > ankleL, legR > ...}. Names and hierarchy are the
 * applyPose contract; a skinned builder binds a THREE.Skeleton to these bones (skin.js).
 * @example const rig = createRig(fighterSpec); rig.applyPose(pose); rig.joints.armL.isBone // true
 */
export function createRig(spec) {
  const p = spec.proportions;
  const g = () => new THREE.Bone();
  const j = {
    root: g(), hips: g(), torso: g(), head: g(),
    armL: g(), elbowL: g(), handL: g(), armR: g(), elbowR: g(), handR: g(),
    legL: g(), kneeL: g(), ankleL: g(), legR: g(), kneeR: g(), ankleR: g(),
    keyMount: g(), key: g(),
  };
  for (const k of Object.keys(j)) j[k].name = k;
  j.root.add(j.hips);
  j.hips.add(j.torso);
  j.head.position.set(0, p.neckY, 0);
  j.torso.add(j.head);
  for (const [s, arm, elbow, hand] of [[1, j.armL, j.elbowL, j.handL], [-1, j.armR, j.elbowR, j.handR]]) {
    arm.position.set(s * p.shoulderX, p.shoulderY, 0);
    elbow.position.set(0, -p.upperArm, 0);
    hand.position.set(0, -p.foreArm, 0);
    j.torso.add(arm);
    arm.add(elbow);
    elbow.add(hand);
  }
  for (const [s, leg, knee, ankle] of [[1, j.legL, j.kneeL, j.ankleL], [-1, j.legR, j.kneeR, j.ankleR]]) {
    leg.position.set(s * p.hipX, 0, 0);
    knee.position.set(0, -p.thigh, 0);
    ankle.position.set(0, -p.shin, 0);
    j.hips.add(leg);
    leg.add(knee);
    knee.add(ankle);
  }
  j.keyMount.position.set(0, p.keyY, -p.torso[2] / 2);
  j.keyMount.add(j.key);
  j.torso.add(j.keyMount);

  /** Rest local position of every joint (nothing but the hips ever moves; tests check it). */
  const rest = {};
  for (const k of Object.keys(j)) rest[k] = j[k].position.clone();
  let keyAngle = 0;

  /** Write a sim pose (computePose output) onto the joints (joint angles + hip placement only). */
  function applyPose(pose) {
    j.hips.position.set(pose.lungeX, pose.hipY + pose.hipLift, pose.lungeZ);
    j.hips.rotation.set(0, pose.hipYaw, pose.hipRoll);
    j.torso.rotation.set(pose.torsoPitch, pose.torsoYaw, pose.torsoRoll);
    j.head.rotation.set(pose.headPitch, pose.headYaw, 0);
    j.armL.rotation.set(-pose.armLPitch, 0, pose.armLRoll);
    j.armR.rotation.set(-pose.armRPitch, 0, -pose.armRRoll);
    j.elbowL.rotation.x = -pose.armLElbow;
    j.elbowR.rotation.x = -pose.armRElbow;
    j.legL.rotation.set(-pose.legLPitch, 0, pose.legLRoll);
    j.legR.rotation.set(-pose.legRPitch, 0, -pose.legRRoll);
    j.kneeL.rotation.x = pose.legLKnee;
    j.kneeR.rotation.x = pose.legRKnee;
    j.key.rotation.set(0, 0, keyAngle);
  }

  /** Turn the wind-up key by `revs` revolutions (rate * dt). */
  function spinKey(revs) {
    keyAngle = (keyAngle + revs * Math.PI * 2) % (Math.PI * 2);
    j.key.rotation.z = keyAngle;
  }

  return { joints: j, rest, applyPose, spinKey };
}

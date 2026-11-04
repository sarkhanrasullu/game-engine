// three.js scene (engine /render): renderer, an injected stage, two injected fighter views, camera
// rig. Render-only: reads fighter state, interpolates between the previous and current sim step. The
// game injects the stage factory, the fighter-view factory and its look constants (lighting, feel)
// through createScene's options (ADR-0004); ADR-0001 adds the PMREM env and the tiered bloom composer
// (pipeline.js). Bloom parameters, camera feel, framing and env panels default to the engine's tuning
// and can be injected the same way. Game-feel audit hooks (docs/render-hooks.md): a `lights` rig
// factory, a `shadows` caster, a `grade` pass on the composer path, camera impulse/focus/roll from the
// director and a per-frame `state` passed through to the light rig. Every hook is off unless its
// option is given, and the output is then identical to the version before the hooks.
import * as THREE from 'three';
import { computeFraming } from './framing.js';
import { createCameraDirector } from './camera-director.js';
import { createHeroComposer, disposeHeroEnvironment, getHeroEnvironment } from './pipeline.js';
import { QUALITY_CONFIG } from './quality-config.js';
import { materialTierFor } from './quality.js';
import { SHADOW_DEFAULTS, configureShadowCaster, createDefaultLightRig, setShadowFlag } from './lights.js';

/** Default maximum device pixel ratio; caps fill-rate cost on high-DPI phones (quality.js tiers lower it). */
const MAX_PIXEL_RATIO = 2;
const VFOV = 50;
/** Height of the play-mat top the fighters stand on. */
const FLOOR_Y = 0.05;

/** Hit kind for camera/squash tables from a duel-sim event. */
function hitKind(e) {
  if (e.type === 'ko') return 'ko';
  if (e.type === 'block') return 'guard';
  if (e.armor === 1) return 'armor';
  return e.fx;
}

/**
 * The app's one WebGLRenderer (one GL context, one canvas in `container`), configured per art
 * bible §5. Share it across view rebuilds via createScene(..., { renderer }) so the GL context and
 * compiled shader programs survive a pairing change. Not thread-safe (main thread only).
 * @example const renderer = createRenderer(app, { pixelRatio: 2, exposure: lighting.exposure });
 *   const view = createScene(app, [specA, specB], { renderer, ...look }); // view.dispose() keeps the renderer
 * @param {HTMLElement} container
 * @param {{pixelRatio?: number, exposure?: number}} [opts] exposure: tone-mapping exposure (default 1)
 */
export function createRenderer(container, opts = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, opts.pixelRatio ?? MAX_PIXEL_RATIO, MAX_PIXEL_RATIO));
  renderer.setSize(container.clientWidth, container.clientHeight);
  // Art bible §5: ACES filmic tone mapping at exposure 0.9, sRGB output; no realtime shadows
  // (fighters use blob shadows).
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = opts.exposure ?? 1;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = false;
  container.appendChild(renderer.domElement);
  return renderer;
}

/**
 * Build one fight view (scene, lights, stage, both fighters, camera). Single teardown path:
 * view.dispose() removes its window listeners and frees everything it owns; shared inputs
 * (opts.renderer, opts.stageAssets) are left alive for the next view.
 * @example const view = createScene(app, [specA, specB], {
 *     renderer, stageAssets, lighting, feel,
 *     createStage: (scene, assets) => createMyStage(scene, assets),
 *     createFighterView: (spec, scene, viewOpts) => createMyFighterView(spec, scene, viewOpts),
 *   });
 *   // pairing change: build the next view, then view.dispose();
 * @param {HTMLElement} container
 * @param {any[]} specs the game's fighter specs, index = fighter id (passed through to createFighterView)
 * @param {{tier?: {name:string,pixelRatio:number,bloom?:boolean,materialTier?:string,shadows?:boolean,grade?:boolean}, bloomCapable?: boolean,
 *   pixelRatio?: number, reducedMotion?: boolean, renderer?: THREE.WebGLRenderer,
 *   stageAssets?: any, createStage: (scene: THREE.Scene, stageAssets: any) => {update(dt:number):void, dispose():void},
 *   createFighterView: (spec: any, scene: THREE.Scene, viewOpts: {alt: boolean, hero: object}) => any,
 *   lighting: {key:{color:number,intensity:number,position:number[]}, front:object, rim:object,
 *     fill:{sky:number,ground:number,intensity:number}}, feel: {squash: Record<string, {strength:number,holdMs:number}>, koHoldMs:number},
 *   bloomParams?: typeof QUALITY_CONFIG.bloomParams, cameraFeel?: object, framing?: object, envPanels?: object,
 *   lights?: (scene: THREE.Scene, o: {lighting: object, tier: object|null}) => {update?(dt:number, state:any):void, setMood?(name:string):void, dispose():void},
 *   shadows?: Partial<typeof SHADOW_DEFAULTS>, grade?: object|null}} opts
 *   createStage / createFighterView / lighting / feel: the game's stage, fighter view and look constants.
 *   bloomParams / cameraFeel / framing / envPanels: optional overrides of QUALITY_CONFIG.bloomParams,
 *   CAMERA_FEEL, FRAMING_CONFIG and ENV_PANELS (the engine defaults when omitted).
 *   tier: the governor's current tier (pixel ratio, bloom, material tier, shadows, grade; material
 *   tier and shadows are read once here). bloomCapable: some tier of this device uses bloom, so build
 *   and prewarm the composer.
 *   lights: light-rig factory (default createDefaultLightRig); its update(dt, state) runs every frame
 *   with the `state` the game passes to view.render. shadows: real-time caster (SHADOW_DEFAULTS keys;
 *   active only with enabled: true AND tier.shadows !== false). grade: GRADE_DEFAULTS-shaped params
 *   for the composer's grade pass (runs on the bloom path when tier.grade !== false).
 */
export function createScene(container, specs, opts) {
  const { lighting: LIGHTING, feel: FEEL, createFighterView } = opts;
  /** Pixel-ratio cap of the current quality tier (opts.tier, else opts.pixelRatio, else MAX_PIXEL_RATIO). */
  let ratioCap = Math.min(opts.tier?.pixelRatio ?? opts.pixelRatio ?? MAX_PIXEL_RATIO, MAX_PIXEL_RATIO);
  const ownsRenderer = !opts.renderer;
  const renderer = opts.renderer ?? createRenderer(container, { pixelRatio: ratioCap, exposure: LIGHTING.exposure });
  /** Bloom composer path active (high tier). */
  let bloomOn = opts.tier?.bloom === true && opts.bloomCapable === true;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(VFOV, container.clientWidth / container.clientHeight, 0.1, 100);

  // Art bible §5 lights: hemisphere fill + warm key high front-left; no ambient. The game may swap
  // the rig (LF-F13); the default is the built-in one.
  const lightRig = (opts.lights ?? createDefaultLightRig)(scene, { lighting: LIGHTING, tier: opts.tier ?? null });

  // Real-time shadow caster (LF-F17): off unless asked for AND allowed by the tier; fixed for the
  // life of the view (toggling recompiles every receiving material), like the material tier.
  const shadowCfg = opts.shadows ? { ...SHADOW_DEFAULTS, ...opts.shadows } : null;
  const shadowsOn = shadowCfg !== null && shadowCfg.enabled === true && opts.tier?.shadows !== false;
  let shadowCaster = null;
  let ownCaster = null;
  let shadowRestore = null;
  if (shadowsOn) {
    const named = shadowCfg.caster !== 'own' ? lightRig[shadowCfg.caster] : null;
    if (named && named.isDirectionalLight) shadowCaster = named;
    else {
      ownCaster = new THREE.DirectionalLight(0xffffff, shadowCfg.ownIntensity);
      ownCaster.position.set(shadowCfg.offset[0], shadowCfg.offset[1], shadowCfg.offset[2]);
      scene.add(ownCaster);
      shadowCaster = ownCaster;
    }
    shadowRestore = configureShadowCaster(renderer, shadowCaster, scene, shadowCfg);
  }

  const stage = opts.createStage(scene, opts.stageAssets ?? null);

  const reducedMotion = opts.reducedMotion ?? (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  // Hero fighters: baked PMREM env on this renderer (fighters only) and the fixed material tier.
  const hero = { materialTier: materialTierFor(opts.tier), envMap: getHeroEnvironment(renderer, opts.envPanels), reducedMotion };
  // Mirror match: P2 wears the alt finish (art bible R2-3).
  const views = specs.map((spec, i) => createFighterView(spec, scene, { alt: i === 1 && specs[0].id === spec.id, hero }));

  const rig = { x: 0, y: 0, z: 0, lx: 0, ly: 0, lz: 0 };
  const cam = { x: 0, y: 0, z: 0, lx: 0, ly: 0, lz: 0, roll: 0 };
  const director = createCameraDirector({ vfovDeg: VFOV, reducedMotion, cfg: opts.cameraFeel });
  let holdLeft = 0;

  /**
   * Feed one duel-sim event (after fx.onEvent): camera impact, struck-fighter squash, KO hold.
   * @example for (let i = 0; i < sim.eventCount; i++) view.onEvent(sim.events[i]);
   */
  function onEvent(e) {
    const kind = hitKind(e);
    director.impact(kind, e.shake);
    const sq = FEEL.squash[kind];
    const v = views[e.defender];
    if (sq && v) v.squash(sq.strength, reducedMotion ? 0 : sq.holdMs);
    if (e.type === 'ko' && !reducedMotion) {
      holdLeft = FEEL.koHoldMs;
      for (const w of views) w.hold(true);
    }
  }

  /** Match-deciding KO (MatchFlow ROUND_END that ends the match): camera orbit. */
  function finalKo() {
    director.finalKo();
  }

  /** New round: clear camera feel, holds and squash. */
  function resetFeel() {
    director.reset();
    holdLeft = 0;
    for (const v of views) v.resetFeel();
  }

  /** High-tier composer, built only when this device can reach the bloom tier (after resize() sets the size). */
  let post = null;

  function resize() {
    const w = container.clientWidth;
    const h = container.clientHeight;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, ratioCap));
    renderer.setSize(w, h);
    if (post) post.setSize(w, h, renderer.getPixelRatio());
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', resize);
  resize();
  if (opts.bloomCapable === true) {
    post = createHeroComposer(renderer, scene, camera, opts.bloomParams ?? QUALITY_CONFIG.bloomParams, opts.grade ?? null);
    post.setGradeEnabled(opts.tier?.grade !== false);
    resize();
  }

  /**
   * Draw interpolated state. alpha in [0,1).
   * @param {{applyCamera:(camera:THREE.Camera)=>void}} [fx] optional post-framing camera hook (hit shake)
   * @param {number} [dt] seconds since the last render (animation clock; 0 = hold)
   * @param {any} [state] the game's per-frame presentation state, passed unchanged to the light rig's
   *   update(dt, state) (see docs/render-hooks.md for the suggested shape; reuse one object per frame)
   * @example view.render(p1, p2, alpha, fx, dt, frameState);
   */
  function render(f1, f2, alpha, fx, dt = 0, state = null) {
    pose(f1, f2, alpha, fx, dt, state);
    if (bloomOn && post) post.render(dt);
    else renderer.render(scene, camera);
  }

  /** Update stage, fighters and camera for this frame (everything render does except the draw). */
  function pose(f1, f2, alpha, fx, dt, state = null) {
    if (holdLeft > 0) {
      holdLeft -= dt * 1000;
      if (holdLeft <= 0) {
        holdLeft = 0;
        for (const v of views) v.hold(false);
      }
    }
    stage.update(holdLeft > 0 ? 0 : dt);
    const p1 = views[0].update(f1, alpha, dt, FLOOR_Y);
    const p2 = views[1].update(f2, alpha, dt, FLOOR_Y);
    if (fx && fx.landing) {
      for (const v of views) {
        if (v.flags.landed) fx.landing(v.root.position.x, FLOOR_Y, v.root.position.z);
        if (v.flags.koPop) fx.koBurst(v.root.position.x, FLOOR_Y, v.root.position.z);
      }
    }
    if (shadowCaster && shadowCfg.follow) {
      const mx = (p1.x + p2.x) * 0.5;
      const mz = (p1.z + p2.z) * 0.5;
      shadowCaster.position.set(mx + shadowCfg.offset[0], shadowCfg.offset[1], mz + shadowCfg.offset[2]);
      shadowCaster.target.position.set(mx, FLOOR_Y, mz);
    }
    if (lightRig.update) lightRig.update(dt, state);
    computeFraming(p1.x, p1.z, p2.x, p2.z, VFOV, camera.aspect, rig, opts.framing);
    director.update(dt * 1000, rig, Math.hypot(p2.x - p1.x, p2.z - p1.z), camera.aspect, cam);
    camera.position.set(cam.x, cam.y, cam.z);
    camera.lookAt(cam.lx, cam.ly, cam.lz);
    if (cam.roll !== 0) camera.rotateZ(cam.roll);
    if (fx) fx.applyCamera(camera);
  }

  /**
   * Mark every mesh under `root` as a shadow caster (fighter roots). No-op while shadows are off for
   * this view, so flags never change a shader program on the default path. Call before prewarm.
   * @param {THREE.Object3D} root @param {boolean} [on]
   * @example for (const v of view.views) view.setShadowCaster(v.root);
   */
  function setShadowCaster(root, on = true) {
    if (shadowsOn) setShadowFlag(root, 'castShadow', on);
  }

  /**
   * Mark every mesh under `root` as a shadow receiver (the stage floor or a ShadowMaterial catcher).
   * No-op while shadows are off for this view. Note MeshBasicMaterial never receives shadows.
   * @param {THREE.Object3D} root @param {boolean} [on]
   * @example view.setShadowReceiver(catcherDisc);
   */
  function setShadowReceiver(root, on = true) {
    if (shadowsOn) setShadowFlag(root, 'receiveShadow', on);
  }

  /**
   * Shader/material prewarm (pocket-ready story-002, ADR-0001), called once at the match intro: shows
   * every normally hidden FX mesh (spark pool via fx.setPrewarm, toy KO springs) for one compile +
   * one draw, so program link, material state, bone-texture upload and the composer's programs (when
   * the device can reach bloom) happen here instead of on the first hit/KO or tier change mid-fight.
   * The draw is invisible (opacity-0 sparks, springs inside the torso) and the next frame overwrites it.
   * @example view.prewarm(p1, p2, fx); // after createHitFx, before the loop starts
   * @param {any} f1 @param {any} f2 sim fighters (read only)
   * @param {{setPrewarm:(on:boolean)=>void}|null} fx
   */
  function prewarm(f1, f2, fx) {
    pose(f1, f2, 0, null, 0);
    if (fx) fx.setPrewarm(true);
    for (const v of views) {
      if (!v.ko.spring) continue;
      v.ko.spring.visible = true;
      v.ko.spring.frustumCulled = false;
    }
    renderer.compile(scene, camera);
    renderer.render(scene, camera);
    if (post) post.render(0); // composer programs (render pass, bloom mips, output) compile here, not at tier change
    if (fx) fx.setPrewarm(false);
    for (const v of views) {
      if (!v.ko.spring) continue;
      v.ko.spring.visible = false;
      v.ko.spring.frustumCulled = true;
    }
  }

  /**
   * Apply a quality tier (quality.js onChange): the pixel-ratio cap, the bloom toggle and the grade
   * toggle. The material tier and the shadow caster are fixed at creation and never change here (no
   * shader compiles mid-fight).
   * @example governor.onChange = (tier) => view.setQualityTier(tier);
   * @param {{pixelRatio:number, bloom?: boolean, grade?: boolean}} tier
   */
  function setQualityTier(tier) {
    ratioCap = Math.min(tier.pixelRatio, MAX_PIXEL_RATIO);
    bloomOn = tier.bloom === true && post !== null;
    if (post) post.setGradeEnabled(tier.grade !== false);
    resize();
  }

  /** Scene draw calls of the last rendered frame (renderer.info; the composer path reports its scene pass). */
  const drawCalls = () => (bloomOn && post ? post.sceneCalls() : renderer.info.render.calls);
  /**
   * Live GPU resources of the renderer (#debug readout, leak checks). Returns renderer.info.memory
   * itself (no allocation).
   * @example const { geometries, textures } = view.memory();
   */
  const memory = () => renderer.info.memory;
  /** Linked shader programs held by the renderer. */
  const programs = () => (renderer.info.programs ? renderer.info.programs.length : 0);
  /** Whether the bloom composer is the active render path (high tier). */
  const bloomActive = () => bloomOn && post !== null;
  /** Whether the grade pass runs this frame (composer path, grade params given, tier allows it). */
  const gradeActive = () => bloomActive() && post.grade !== null && post.grade.enabled === true;
  /** Whether this view renders real-time shadows (fixed at creation). */
  const shadowsActive = () => shadowsOn;

  let disposed = false;
  /**
   * Teardown (the single path for this view): window listeners off, fighters and stage freed
   * (shared stage assets kept), lights released, scene emptied. The renderer is disposed (and its
   * canvas removed) only when this view created it. Call fx.dispose() for its hit FX first.
   * Idempotent.
   * @example fx.dispose(); view.dispose();
   */
  function dispose() {
    if (disposed) return;
    disposed = true;
    window.removeEventListener('resize', resize);
    window.removeEventListener('orientationchange', resize);
    for (const v of views) v.dispose();
    if (post) post.dispose();
    stage.dispose();
    if (shadowRestore) shadowRestore.restore();
    if (ownCaster) {
      scene.remove(ownCaster.target);
      scene.remove(ownCaster);
      ownCaster.dispose();
    }
    lightRig.dispose();
    scene.traverse((o) => { if (o.isLight && typeof o.dispose === 'function') o.dispose(); });
    scene.clear();
    if (ownsRenderer) {
      disposeHeroEnvironment(renderer);
      renderer.dispose();
      renderer.domElement.remove();
    }
  }

  return {
    render, prewarm, setQualityTier, resize, scene, camera, drawCalls, memory, programs, bloomActive, dispose, views, stage,
    bodies: views.map((v) => v.flashMesh), onEvent, finalKo, resetFeel, director, reducedMotion,
    lights: lightRig, setShadowCaster, setShadowReceiver, shadowsActive, gradeActive, post,
  };
}

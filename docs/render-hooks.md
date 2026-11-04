# Render hooks (game-feel audit 2026-11-04)

Hooks added to `@sarkhanrasullu/game-engine/render` so a consumer can deliver camera impulses, a
camera that watches a point, its own light rig and moods, a final colour grade, a real-time shadow
caster and feature-flagged quality tiers. **Every hook is off unless its option is given; with the
options absent the output is pixel-identical to the previous version.** Verified against three r187
(`node_modules/three/src`): `PCFShadowMap` (not the deprecated `PCFSoftShadowMap`), `ShaderPass`,
`EffectComposer` marking the last *enabled* pass `renderToScreen`, `DirectionalLightShadow`'s
orthographic camera.

## 1. Camera impulse / shake / roll (`camera-director.js`, F5)

```js
director.impulse({ dir?: {x, y?, z?}, strength, ms?, hz?, roll? })
director.shake(strength, ms?, hz?)            // = impulse without dir (isotropic noise)
director.impulseNow()                         // live amplitude sum (tests/debug)
```

| option | default | meaning |
|---|---|---|
| `dir` | none → isotropic | world-space hit direction, projected onto the camera plane; along the view axis → sideways kick |
| `strength` | required | peak offset, world units; clamped to `CAMERA_FEEL.impulse.maxAmplitude` (0.3) |
| `ms` | `impulse.ms` 260 | time to silence (quadratic decay `(1-u)^2`) |
| `hz` | `impulse.hz` 10 | dominant frequency: directional = `cos(2π·hz·t)` (peak at impact), isotropic = two-sine noise |
| `roll` | 0 | peak roll in degrees, signed; clamped to `impulse.maxRollDeg` (2.5); rings with the kick |

The offset is added to the camera **and** the look-at, so fighters and stage jolt as one frame; the
director writes `out.roll` (radians) and `createScene` applies `camera.rotateZ(roll)` after `lookAt`
(skipped when 0). Four impulses overlap; a fifth replaces the weakest. No per-frame allocation
(fixed slot pool; `impact()`'s directional kick reuses one options object).

Reduced motion: `strength *= impulse.reducedMotionScale` (default 0 → impulses ignored). A consumer
that wants a faint cue sets `cameraFeel.impulse.reducedMotionScale: 0.25`.

Legacy `impact(kind, shake)` is unchanged by default. Three additive `CAMERA_FEEL.shake` keys opt in:
`coupleLookAt: true` (move the look-at with the old shake), `holdMs` (full amplitude for the first N
ms), `kick` + `kickMs` (an `impact(kind, shake, dirX, dirZ)` call fires a directional impulse of
amplitude × `kick`).

**Wiring.** Per hit, after `view.onEvent(e)`, the game calls
`view.director.impulse({ dir: { x: contact.x - defender.x, z: contact.z - defender.z }, strength: 0.08 * weight, ms: 220, hz: 11, roll: 0.6 })`
or sets `cameraFeel: { ...CAMERA_FEEL, shake: { ...CAMERA_FEEL.shake, kick: 0.6, coupleLookAt: true } }`
in its scene-look and passes `dirX/dirZ` to `impact`. A partial `cameraFeel` without `impulse`/`focus`
falls back to the engine defaults for those two blocks.

## 2. Camera focus (`camera-director.js`, KD-10)

```js
director.focus({ target: {x, y, z}, weight?, ms, lowerBy?, dollyIn?, inMs?, outMs? })
director.release(outMs?)
director.focusLevel()  // 0..1   director.focusActive()
```

| option | default | meaning |
|---|---|---|
| `target` | required | world point (e.g. the loser's root position) |
| `weight` | 1 | 1 centres the point, 0.3 leans toward it |
| `ms` | required | hold at full weight after the blend-in |
| `lowerBy` | 0 | lower camera and look-at by this many world units at full weight |
| `dollyIn` | 0 | push-in fraction, HUD-clamped like every push; 0 under reduced motion |
| `inMs` / `outMs` | `focus.inMs` 160 / `focus.outMs` 420 | blend-in and release |

Envelope: attack → hold → smooth release, then the director returns to framing. A second `focus`
continues from the current level; `release()` starts the release from the current level (no snap);
`reset()` clears it. The blend plays under reduced motion (no oscillation), the dolly does not.

**Wiring.** On the KO event the game calls
`view.director.focus({ target: loserView.root.position, weight: 0.35, ms: 1400, lowerBy: 0.25, dollyIn: 0.12 })`;
for a super cinematic, `focus({ target: attackerPos, weight: 0.5, ms: 400, dollyIn: 0.15 })` then
`release(200)` at the freeze end.

## 3. Light rig factory (`lights.js`, `createScene({ lights })`, LF-F13)

```js
createScene(container, specs, { ...look, lights: (scene, { lighting, tier }) => rig })
rig = { update?(dt, state), setMood?(name), dispose(), ...anything the game wants (key, rim, extra) }
createDefaultLightRig(scene, { lighting })  // the built-in rig: fill (hemisphere), key, front, rim — in that order
view.lights                                 // the rig object
view.render(f1, f2, alpha, fx, dt, state)   // `state` is passed to rig.update unchanged
```

Default: `createDefaultLightRig` (identical lights, order and values to the old inline block). The
rig's `update(dt, state)` runs every frame **before** framing; `dispose()` runs at view teardown
(the engine still disposes any light left in the scene afterwards).

`state` is the consumer's object; the engine never reads it. Suggested shape, one object reused per
frame (allocation-free): `{ t, hitstop: boolean, ko: boolean, koAge: ms, meters: [p1, p2], health: [p1, p2], mood: 'fight'|'ko'|'victory' }`.

**Wiring.** The game's scene-look adds
`lights: (scene, { lighting }) => { const rig = createDefaultLightRig(scene, { lighting }); /* add lava rim, keep targets */ return { ...rig, update(dt, state) { /* KO dim, flicker, mood lerps */ }, dispose() { /* remove extras */ rig.dispose(); } }; }`
and `main.js` fills a `frameState` object each frame and passes it as the 6th argument of `view.render`.

## 4. Colour grade (`pipeline.js`, `createScene({ grade })`, LF-F16)

```js
createHeroComposer(renderer, scene, camera, bloomParams?, grade?)   // grade: GRADE_DEFAULTS-shaped params or null
post.grade            // the ShaderPass, or null
post.setGrade(params) post.setGradeEnabled(on)
createGradePass(params) / applyGrade(pass, params) / GRADE_DEFAULTS
view.gradeActive()
```

| param | default (neutral) | |
|---|---|---|
| `lift` / `gamma` / `gain` | `[0,0,0]` / `[1,1,1]` / `[1,1,1]` | per channel, display (sRGB) space after OutputPass: `pow(gain·(c + lift·(1-c)), 1/gamma)` |
| `saturation` | 1 | luma-preserving mix |
| `vignette` | `{ strength: 0, radius: 0.7, softness: 0.5 }` | radial, UV distance from centre |

One full-screen `ShaderPass` **after** OutputPass, composer (bloom/high) path only, no LUT textures
(one texture read + ~6 ALU per pixel; fill-rate class work, ≤ 0.3 ms at DPR 2 phone resolution is the
budget, measure on the story-010 phone). Omitted → no pass is added, the chain is RenderPass → Bloom →
OutputPass as before. With params given, the pass exists and is **enabled iff `tier.grade !== false`**
(`setQualityTier` toggles it; a disabled last pass hands the screen back to OutputPass). Resolved
tiers carry `grade: false` unless the config says `grade: true`, so a game flags the tiers it wants.

**Wiring.** `scene-look.js`: `grade: { lift: [0.015, 0.008, 0.006], gamma: [1, 1, 1], gain: [1, 1, 1], saturation: 1.05, vignette: { strength: 0.2 } }`;
`quality-config.js`: `tiers` with `grade: true` on `high`. `view.post.setGrade(...)` retunes live.

## 5. Real-time shadow caster (`lights.js`, `createScene({ shadows })`, LF-F17)

```js
createScene(container, specs, { ...look, shadows: { enabled: true, mapSize, bias, normalBias, radius, type, caster, frustum, near, far, follow, offset, ownIntensity } })
view.setShadowCaster(object3d, on = true)    // castShadow on every mesh under it (no-op while shadows are off)
view.setShadowReceiver(object3d, on = true)  // receiveShadow likewise (MeshBasicMaterial never receives)
view.shadowsActive()
configureShadowCaster(renderer, light, scene, cfg) / setShadowFlag(root, flag, on) / SHADOW_DEFAULTS
```

Defaults (`SHADOW_DEFAULTS`): `enabled false, mapSize 1024, bias -0.0005, normalBias 0.02, radius 1,
type 'pcf' ('basic'|'vsm'), caster 'key' ('front'|'rim'|'own'), frustum 4 (half-size of the ortho
box), near 0.5, far 30, follow true, offset [0.6, 10, 1.5], ownIntensity 0`.

Active iff `shadows.enabled === true` **and** `tier.shadows !== false` (resolved tiers say `false`
unless the config flags `shadows: true`). Fixed for the life of the view, like the material tier: a
toggle recompiles every receiving material, so the governor never flips it (ADR-0001 keeps shadows off
by default on every tier; the consumer flags `high` only). `caster: 'own'` (or a named light the
rig lacks) adds a shadow-only `DirectionalLight` at `offset` with `ownIntensity`. With `follow`, the
caster and its target track the fighters' midpoint each frame (allocation-free `position.set`).
The renderer's `shadowMap.enabled/type` are restored at `dispose()` (the renderer is shared).

**Wiring.** `quality-config.js`: `shadows: true` on `high`; `scene-look.js`: `shadows: { enabled: true, caster: 'own', frustum: 3 }`;
after `createScene`: `for (const v of view.views) view.setShadowCaster(v.root); view.setShadowReceiver(catcherDisc)` — the
stage view adds a `ShadowMaterial` catcher (the dais is MeshBasic and cannot receive) — then `view.prewarm(...)`.

## 6. Tier feature flags (`quality-config.js`, `quality.js`, LF-F21)

Tier schema: `{ name, pixelRatio, bloom?, materialTier?, shadows?, grade? }`. `resolveTiers` returns
`ResolvedTier = { name, pixelRatio, bloom: boolean, materialTier, shadows: boolean, grade: boolean }`
(missing flags → `false` / `'physical'`), and now **keeps a tier when its effective pixel ratio drops
OR any flag differs** from the previous kept tier; only tiers identical in effect collapse. On a DPR-1
device the engine defaults therefore resolve to `high → medium → low` (bloom+physical → physical →
standard) instead of a single `high`, so the governor can step down and `?quality=low` renders low.
`QualityGovernor.indexOf(name)` maps a collapsed tier to the kept tier it merged into and a removed
bloom tier (no half-float) to the first kept tier below it.

Backward compatible: the consumer's `QUALITY_CONFIG = { ...ENGINE_QUALITY_CONFIG, storageKey }`
works untouched (engine tiers now carry explicit `shadows: false, grade: false`). Hero-shot captures
at DPR 2/3 with a forced tier are unaffected.

**Wiring.** To light up shadows/grade on high only:
`tiers: ENGINE_QUALITY_CONFIG.tiers.map((t) => t.name === 'high' ? { ...t, shadows: true, grade: true } : t)`.

## Engine-side behaviour notes

- `createHeroComposer(...).dispose()` now also disposes the bloom, output and grade passes
  (`EffectComposer.dispose` frees only its own targets and copy pass) — fixes a GPU-resource leak on
  view rebuilds.
- `view.render` gained a 6th argument (`state`); `pose()` passes it to the rig. Existing 5-argument
  calls are unchanged.
- `view` exposes `lights`, `post`, `setShadowCaster`, `setShadowReceiver`, `shadowsActive`, `gradeActive`.

# Changelog

Semver from 0.1.0. Before 1.0 a minor bump may break the API. Each release is a git tag `vX.Y.Z`.

## 0.5.2 (2026-11-05)

One download lane for everything a game streams (consumer BOOT-NET: slow links). Additive, with one behaviour change, noted last.

- `./assets` `createDownloadLane()`: a priority scheduler, one file at a time, lower number sooner. `add`, `bump`,
  `promote(id, { preempt })`, `yieldToFront`, `current`, `idle`, `snapshot`. A promote may abort a barely-started download.
- `./assets` `createTranscoderWarm({ transcoderPath })`: fetches the basis transcoder early and serves it from memory
  through a `urlModifier`, so the first decode does not wait on it. `start`, `urlModifier`, `dispose`, `TRANSCODER_FILES`.
- `./assets` hero and stage stores: options `lane`, `priority`, `preemptBelow`, `transcoder`; `lite` may be a function, read
  as each file starts. New `HERO_LANE_PRIORITY`, `STAGE_LANE_PRIORITY`, `load(id, o, { preempt })`, `store.lane`, stage
  `promote()`. `fetchBytesWithProgress` takes a third argument, `{ signal }`.
- `./audio` `createSampleBank`: options `lane`, `priority`; new `prefetch({ groups, priority })` downloads without decoding;
  `BANK_LANE_PRIORITY`.
- `tools/audio/render-bank.mjs`: `regroupManifest()` changes clip groups without re-encoding audio.
- **Behaviour change:** a variant that failed to fetch or decode is not retried until `unload()`; `load()` used to retry it.

## 0.5.1 (2026-11-05)

Heroes on demand (consumer UX-2: a premium first minute on a slow connection). Additive; `preload()` /
`whenReady()` / `get()` behave as before.

- `./assets` `createHeroAssetStore`: heroes download ONE AT A TIME through a priority queue.
  `load(fighterId, o)` queues one hero at the front (asking again for a queued hero moves it to the front:
  the hero the player just swiped to is next); `preload(o)` queues every configured fighter in order behind
  it; `whenLoaded(fighterId, ms)` is the bounded per-hero wait; `status(fighterId)` reports `HERO_LOAD`
  (`idle` / `loading` / `ok` / `failed`; `whenLoaded(id)` with no bound subscribes without reordering); the manifest is fetched once and the loader stack (KTX2 workers) is
  released whenever the queue drains. New option `onProgress({ id, loaded, total })`: download bytes as they
  stream (total = Content-Length, else the manifest's `bytes`, else 0).
- `./assets` `createStageAssetStore`: the same `onProgress` option (id = `cfg.id`).
- `./assets` both stores: `preload({ lite: true })` / `load(id, { lite: true })` force the manifest's lite file
  whatever the tier (the consumer's slow-link rule); default unchanged (lite tiers and inline artifacts only).
- `./assets` `fetchBytesWithProgress(url, onBytes)`: the default network fetch, streaming when a progress
  callback is given.
- Tests: `test/assets/hero-asset.test.js` +4 (queue order, bounded per-hero wait, byte progress, manifest
  total fallback). Suite 297 -> 301.
- `./audio` hit-frame cost tools (AUDIO-PERF, `src/audio/node-pool.js`): `createNodePool(ctx, { gain,
  biquad, panner })` — reusable processing nodes a voice borrows and releases (`fill(n)` per quiet frame,
  `release(node, freeAt)` disconnects, cancels automation from `freeAt` and holds the defaults there,
  overflow created fresh and counted in `stats()`); `createWaveWarmer(ctx, waves)` assigns each
  OscillatorNode type once (Chromium builds the PeriodicWave tables lazily at ~1.5 ms per type, 8-11 ms
  at a 6x CPU throttle — the only audio spike of a phone-class fight); `collectOscillatorWaves(tree)`,
  `OSCILLATOR_WAVES`, `POOL_KINDS`. Schema: optional `voices.pool`, `voices.warmup_per_tick`,
  `voices.low_tier { global_cap, max_partials, ring_partials }` validated by `buildSfxData`.
  Tests: `test/audio/node-pool.test.js` (7), `sfx-schema.test.js` +1.
- `./sim` `MatchFlow.abort()` (ENGINE-SMALL): the quit path — parks the flow in IDLE from any state,
  emits no match-end work, clears `result` / `lastRound`, keeps `settings` for a restart; no-op in IDLE.
  Tests: `test/sim/match-flow.test.js` +2.
- `./tools/check-bundle-size.mjs`: "main" is now the eager TOTAL of every `dist/assets/*.js` chunk no
  `lazy` regex matches (new `limits.lazy: RegExp | RegExp[]`; the old `lazyLoader`-only shape still
  works), with a per-chunk eager / lazy breakdown in `lines` and `chunks` — a chunk the bundler hoists out
  of the entry (the consumer's 269 KB `BufferGeometryUtils` after a top-level await) can no longer hide
  from the gate. Tests +2.
- `./tools/hero-lite.mjs`: `--ids` scopes to sets declared `kind: 'heroes'` (`applyIdsOverride`,
  `AssetSet.kind`); a stage set keeps its ids. Test +1.

## 0.5.0 (2026-11-05)

The CPU pilot learns footsies. Behaviour changes for every consumer that uses `CpuPilot`, which is why
this is a minor bump; the API is additive and old difficulty/personality files stay valid.

- `./ai` CpuPilot: kit preferred range (`spec.ai.rangeBias`; behaviour keys `rangeBias`, `rangeBand`,
  `tipPatience`, `jumpWeight`), tip pokes thrown on a step-in instead of blind heavy spam, Light
  strings on hit confirm (from the move's `cancel` data), a frame-advantage read after contact
  (`frameAdvantage`: hold guard at minus frames, press at plus — tick throw on a blocker, jab, or
  close in), armoured counters derived from `armor` windows, retreat and jump defences, the
  `antiAir` move role, crouch-heavy and back-special whiff punishes, and meter discipline
  (`spendable`: a costed special is not spent within one cost of a full meter). Fairness unchanged:
  input snapshot only, reaction delay, public state.
- `./ai` matchups: `buildMatchups(json, difficulties, personalities)` and `CpuPilot({ matchups })`
  apply a per-pairing plan at the kit re-tune, weighted by the level's `matchupSkill`;
  `applyPersonality(p, d, b, weight)`.
- `./ai` difficulty: eight optional level keys with derived defaults — `stringConfirmChance`,
  `pressureChance`, `disadvantageRespect`, `antiAirChance`, `counterChance`, `retreatChance`,
  `jumpChance`, `matchupSkill` (locked for personalities). `ActionMix` gains `jump`, `string`,
  `counter`, `antiAir`; new `REASON`s and `PLAN.JUMP`.
- `./sim` moves: `aiRole` accepts `antiAir`; `cancel`, `armor` and `travel` are read as intent.
- Tests: `test/ai/intent.test.js` (19). Suite 278 -> 297.

## 0.4.0 (2026-11-05)

Stage hazards, meter-costed moves and the audio kernel the consumer's third fighter needed. Additive:
rulesets without `hazards` or `meterCost` behave as before.

- `./sim` stage hazards (`src/sim/hazards.js`): a `hazards` ruleset section — telegraphed lane zones
  (`zone {x0,x1[,y0,y1]}`, `cycle {telegraph_ms >= 500, active_ms, period_ms, phase_ms, jitter_ms}`,
  `effect {damage, knockback, hitstun_frames, launch, ignores_guard, armor_breaks, guard_scale,
  hitstop, shake, flash, fx}`, `schedule periodic|random|scripted`), validated by `buildHazards`;
  `stepDuel` emits `hazard_telegraph { id, zone, in_frames }`, `hazard_active`, `hazard_hit { target,
  damage, knockback, blocked, armor, ... }`, `hazard_end`, one strike per fighter per activation,
  i-frames honoured, paused by hitstop and super freeze. `createDuel(rs, { hazards, seed })`,
  `setHazardsEnabled`, `setDuelHazards` (per-stage swap), `sim.koBy`, `KO_BY`. Event pool 8 -> 12.
- `./sim` match flow: `ROUND_REASON.HAZARD`, `isKoReason(reason)`, `MatchFlow#update(dt, hp0, hp1,
  koReason)`.
- `./sim` moves schema: optional `meterCost` (integer >= 0) on any move — spent from the meter on
  the move's frame 1 (clamped at 0); a move the fighter cannot pay for does not start (a Heavy that
  would resolve to such a special falls back to `heavy`, any other id is refused and the press stays
  buffered). New `canAfford(f, move)` export. Tests: `test/sim/meter-cost.test.js`.
- `./ai`: `CpuPilot#sample(out, self, opp, hazards)` steps out of telegraphed zones with a
  difficulty-scaled `hazardEvadeChance` (optional level key, default `1 - mistakeRate`, locked for
  personalities); `observeHazards` perception; the pilot never picks unaffordable specials or punishes.
- `./tools/audio/dsp.mjs`: `springTone` kernel (coil twang partial) for the renderer.
- Tests: `test/sim/hazards.test.js` (13), `test/ai/hazard-perception.test.js` (5), meter cost (6),
  render-bank (+1). Suite 253 -> 277.

## 0.3.0 (2026-11-05)

The extraction is complete (ADR-0004 ENG-07d) and the engine gains the hooks a premium fight needs:
render feel, light moods, grading, shadows, tier flags, and a sample-bank audio layer with an offline
renderer. Nothing in this release changes a consumer's output until it opts in.

- `./blender/*` (new): the headless Blender asset pipeline — `run.mjs`, `setup.sh`, `build.py`,
  `compress.mjs`, `source-hash.mjs`, `glb-contract.mjs`, `rig-contract.mjs`, `lib/` (scene, bake,
  material, hardsurface, pbr, armature, export, turntable) and three `smoke/` assets. A consumer
  supplies `blender.config.mjs` (`root`, `kinds`, `scriptsDir`, `buildDir`, `evidenceDir`, `venv`,
  `python`, `niceness`, `generator`, `proportions`, `proportionsFor`) via `run.mjs --config`. No
  consumer data in the lib: `armature.fighter_entry` takes a fighter id, `hardsurface` material names
  come from a `materials=` dict (the fastener helper is now `fasteners`), `pbr.compose` requires `presets=`
  (`pbr.preset`). Source hashing covers both trees under the logical name `tools/blender/<path>`
  (A7.7); encoders resolve from the consumer root (the engine keeps zero runtime deps); `setup.sh`
  env is neutral (`ASSET_PIPELINE_VENV/_PYTHON/_BPY_VERSION/_ROOT`), bpy version from
  `requirements.txt`. Tests: `test/blender/` (rig contract on a synthetic fixture, source-hash,
  config); the boundary scan covers `blender/`.
- `./render`: `createCameraDirector` gains `impulse()` / `shake()` (whole-frame damped oscillation,
  per-call Hz, optional roll, 4-slot pool, reduced-motion scale) and `focus()` / `release()` (blend
  the look-at toward a point, lower, dolly, release); `update()` writes `out.roll`, applied by
  `createScene`. `createScene` accepts a `lights` rig factory (`createDefaultLightRig` exported as
  the extendable built-in), a `shadows` caster config with `view.setShadowCaster/setShadowReceiver`,
  a `grade` option for the composer path, and a 6th `render()` argument `state` passed to the rig
  each frame. `createHeroComposer` takes an optional colour grade (`createGradePass`: lift / gamma /
  gain, saturation, vignette; no LUT) after OutputPass, toggled per tier; its `dispose()` now also
  frees the bloom / output / grade passes (previously leaked on view rebuild). The tier schema gains
  `shadows` and `grade` flags; `resolveTiers` keeps tiers that differ by any flag, not only by pixel
  ratio, so DPR-1 devices keep three steps and forced tiers pin correctly; `QualityGovernor.indexOf`
  maps collapsed tiers by config order. Additive `CAMERA_FEEL.shake` keys `holdMs`, `coupleLookAt`,
  `kick` / `kickMs` and new `impulse` / `focus` blocks; all defaults preserve the previous output
  (verified pixel-identical by the consumer's hero-shot harness). `docs/render-hooks.md` records every
  hook's options, defaults and consumer wiring.
- `./audio`: `sample` layer type in the SFX schema (bank clip, pitch / gain jitter, start offset,
  filter, reverb send, synthesis `fallback`), optional `ambience` bus, validated `mix.reverb` /
  `bass_enhance` / `combat_comp` sections. `createSampleBank` — lazy, cached, per-clip
  failure-contained bank loader with allocation-free round-robin `pick()`. `makeImpulseResponse`,
  `createAcousticSpace`, `createSend`, `createHarmonicLift` — one-convolver shared space with bus /
  event sends and the phone-speaker bass guard. `createHaptics({ backend })` with `vibrateBackend` /
  `impactBackend`. Generic `test/fixtures/fake-audio.js`.
- `./tools/audio/dsp.mjs` + `render-bank.mjs` (new): deterministic offline DSP kernels and bank
  renderer (AAC via ffmpeg, manifest with recipe + seed, AAC-safe loop rolls).
- Suite 186 -> 253 (rc.1 -> 0.3.0 before the audio tests; see `npm test`).

## 0.3.0-rc.1 (2026-11-05)

Runtime asset and build-tool extraction (ADR-0004 ENG-07b/c). Layout change: the consumer links the
engine as the sibling folder `file:../game-engine` (no GitHub pin, no submodule); it dedupes `three`
and runs both suites from its root. Still rc: the Blender pipeline (ENG-07d) lands in 0.3.0.

- `./assets` (new): hero manifest (`HERO_MANIFEST_SCHEMA`, `parseHeroManifest`, `lodForTier`,
  `heroFileForTier`), stage manifest (`stageEntry`, `stageChoice`), skinned glTF hero loading
  (`loadHeroAsset`, `HERO_JOINTS`, `assignRoles`, `toBindSpace`), `createInlineSource`,
  `createHeroAssetStore` / `createStageAssetStore` (config and loaders injected; `cfg` required),
  `loadStageAsset` (Draco/KTX2 rejection, LOD map, `draws`/`tris`/`dispose`; node pattern, LOD
  groups, material names and the material factory are injected).
- `./assets/gltf-loader` (new, dynamic-import only): `createHeroGltfLoader` / `createGltfLoader`,
  the KTX2 + meshopt loader stack as its own lazy chunk (`gltf-loader-stack-*.js`). Not re-exported
  from `./assets` on purpose.
- `./render` gains `createRig`, the skinned toy builders (`createSkinnedBuilder`, `createToyMaterial(s)`,
  `createRimUniforms`, `mergeParts`, `boxAt`, `ballAt`, `segment`, `attach`), the procedural geometry
  helpers (`plate`, `chamferRect`, `trapezoid`, `slab`, `frustum`, `band`, `lathe`, `mirrorPts`) and
  `bakeStageEnvironment` (PMREM bake from a stage mesh; config injected).
- `./tools/*` (new): `check-bundle-size.mjs` (pure `checkBundleSizes(files, limits)`, `loadLimits`,
  `runBundleCheck`, CLI `<distDir> <limits.mjs>`), `hero-lite.mjs` (lite GLB/KTX2 variants and inline
  payload; asset sets injected, `--config`), `vite-hero-assets.mjs` (Vite asset plugin; `sets`,
  `basisDir`, `liteMax`, `emit` injected).
- Tests: `test/assets/*` (20), `test/tools/*` (11), fixtures `gltf-fixture.js` (in-memory skinned GLB
  builder with KHR_texture_basisu maps) and `stage-fixtures.js`. Suite 155 -> 186.
- Boundary: no consumer names in `src/` or `tools/`; the engine never imports the consumer.

## 0.2.0 (2026-11-04)

Render, audio and storage batch (ADR-0004 ENG-04), moved from the first consumer.

- `./render` (new; peer `three`): `QUALITY_CONFIG` defaults with a generic `storageKey: 'quality.tier'`
  (a game injects its own key through `QualityGovernor({ config })`), `QualityGovernor`, `resolveTiers`,
  `materialTierFor`, `canReachBloom`, `supportsHalfFloatTargets`, the hero pipeline (`ENV_PANELS`,
  `createEnvScene`, `getHeroEnvironment(renderer, panels?)`, `disposeHeroEnvironment`, `createHeroComposer`),
  `FRAMING_CONFIG` / `computeFraming`, `CAMERA_FEEL` / `createCameraDirector`, `createRenderer`, `createScene`.
  `createScene` options gain optional `bloomParams`, `cameraFeel`, `framing` and `envPanels` (engine
  defaults when omitted, so existing calls behave the same).
- `./audio` (new): `buildSfxData(json, requiredEvents)`, `validateLayer`, `dbToGain`, `LAYER_TYPES`,
  `createHaptics`. Error messages are prefixed `sfx data` instead of a game file name.
- `./storage` (new): `createSettingsStorage`, `createSave` / `loadSave` (versioned JSON save core).
- `three` 0.187.0 added as a dev dependency for the render tests (still a peer for consumers).
- Tests for every new module; the boundary lexicon gains one more consumer stage name.

## 0.1.0 (2026-11-04)

First extraction (moved unchanged from the first consumer, behind its re-export layer).

- `./core`: `deepFreeze`, `numberTable`, `SeededRng`, `FixedStepLoop`, `Hitstop`, cylinder collision.
- `./sim`: `createRuleset`, rule/movement/move/round/meter builders and validators, state machine,
  combatant, movement, hurtboxes, code-keyed poses, `createDuel` / `stepDuel`, frame data, `MatchFlow`.
- `./ai`: `CpuPilot`, perception, `buildDifficultySet`, `buildPersonalities`, `ActionMix`.
- `./input`: input snapshot, `InputState`, `DoubleTapDetector`, touch stick and buttons,
  `attachKeyboard`, handedness helpers.
- Unit tests with frozen tuning fixtures, and the boundary test (no game names, no imports outside
  the package, no JSON imports in `src/`).

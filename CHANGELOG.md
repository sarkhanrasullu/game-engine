# Changelog

Semver from 0.1.0. Before 1.0 a minor bump may break the API. Each release is a git tag `vX.Y.Z`.

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

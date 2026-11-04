# Changelog

Semver from 0.1.0. Before 1.0 a minor bump may break the API. Each release is a git tag `vX.Y.Z`.

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

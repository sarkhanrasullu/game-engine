# Changelog

Semver from 0.1.0. Before 1.0 a minor bump may break the API. Each release is a git tag `vX.Y.Z`.

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

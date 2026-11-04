# game-engine

`@sarkhanrasullu/game-engine` is a small, data-driven engine for 3D one-on-one fighting games on
the web. It provides a fixed-step loop, a deterministic two-fighter duel sim, a CPU pilot that
plays through the same input snapshot as a human, and a keyboard/touch input layer.

The engine holds no game data. A game builds a **ruleset** from its own tuning (JSON or anything
else) and injects it into every factory. No module reads a config singleton, imports JSON, or names
a game. The boundary test (`test/boundary.test.js`) enforces this.

It ships as raw ES modules with JSDoc and has no build step. Your bundler (Vite, Rollup, esbuild)
or Node >= 22.12 consumes `src/` directly.

## Install

Pin an exact tag. The lockfile records the resolved commit:

```sh
npm install github:sarkhanrasullu/game-engine#v0.1.0
```

`three` (`>=0.187.0 <0.188.0`) is a peer dependency, reserved for the upcoming `./render` subpath.
None of the current subpaths import it.

## Usage

Import by subpath:

```js
import { createRuleset, createDuel, stepDuel } from '@sarkhanrasullu/game-engine/sim';
import { FixedStepLoop } from '@sarkhanrasullu/game-engine/core';
import { InputState, createSnapshot, attachKeyboard } from '@sarkhanrasullu/game-engine/input';
import { CpuPilot, buildDifficultySet } from '@sarkhanrasullu/game-engine/ai';
import tuning from './data/combat_tuning.json' with { type: 'json' };
import aiTuning from './data/ai_difficulty.json' with { type: 'json' };

// 1. Validate and freeze the game's tuning once. This throws on a missing or unknown key.
const ruleset = createRuleset({
  rules: tuning.rules, movement: tuning.movement, moves: tuning.moves,
  round: tuning.round, meter: tuning.meter,
});

// 2. Player 1 uses the keyboard. Player 2 is the CPU, which reads the same snapshot shape.
const input = new InputState(myInputConfig, { KeyA: 'left', KeyD: 'right', KeyJ: 'light' /* ... */ });
attachKeyboard(window, input);
const ai = buildDifficultySet(aiTuning, ['easy', 'normal', 'hard']);
const cpu = new CpuPilot({ difficulty: ai.levels.normal, behaviour: ai.behaviour, rules: ruleset.rules, seed: 7 });

// 3. Step the sim at a fixed 60 Hz and render at the display rate.
const sim = createDuel(ruleset);
const p1 = createSnapshot();
const p2 = createSnapshot();
const loop = new FixedStepLoop({
  step: (dt) => {
    input.sample(p1, performance.now());
    cpu.sample(p2, sim.fighters[1], sim.fighters[0]);
    stepDuel(sim, p1, p2, dt);
  },
  render: (alpha) => { /* draw sim.fighters, interpolating with alpha */ },
});
requestAnimationFrame(function tick(t) { loop.frame(t); requestAnimationFrame(tick); });
```

Every public function has a JSDoc `@example`. Read `src/<subpath>/index.js` for the list.

## Modules

| Subpath | Contents |
|---|---|
| `./core` | `deepFreeze` and `numberTable` (data-boundary helpers), `SeededRng`, `FixedStepLoop`, `Hitstop`, cylinder collision |
| `./sim` | `createRuleset`, the rule, movement, move, round and meter builders and validators, the fighter state machine, combatant, movement, hurtboxes, code-keyed poses, `createDuel` / `stepDuel` (hit, block, throw, armour and meter resolution), frame data, `MatchFlow` (best-of-N rounds) |
| `./ai` | `CpuPilot` (input-snapshot fairness model), delayed perception, `buildDifficultySet`, `buildPersonalities`, `ActionMix` |
| `./input` | input snapshot, `InputState`, `DoubleTapDetector`, touch stick and buttons, `attachKeyboard`, handedness helpers. Tuning and key bindings are injected |

Inside the package, dependencies point one way: `ai -> sim -> core`, and `sim -> input` for the
snapshot type only. The planned subpaths are `./render` (three.js), `./audio`, `./storage`, and a
Blender asset pipeline.

## Development

```sh
npm test            # node --test "test/**/*.test.js"; no install needed
```

`test/fixtures/` holds frozen copies of a reference tuning set and a default-bound layer
(`test/fixtures/bound/`). These are used only by the tests and are not shipped (see `files` in
`package.json`).

## Versioning

Versions follow semver, starting at 0.1.0. Each release is a git tag `vX.Y.Z` with a
`CHANGELOG.md` entry. Before 1.0, a minor bump may break the API.

## License

[MIT](LICENSE) © 2026 sarkhanrasullu

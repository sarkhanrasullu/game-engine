# Graph Report - game-engine  (2026-11-05)

## Corpus Check
- 109 files · ~60,006 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 3 file(s) not represented in the graph (top: (none) 3)

## Summary
- 657 nodes · 1440 edges · 19 communities
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 30 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `ce9504ad`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- scene.js
- hero-asset.test.js
- ref_node_assert
- cpu-controller.js
- sim/duel-sim.js
- state-machine.test.js
- ai-support.test.js
- MatchFlow
- package.json
- poses.js
- InputState
- sfx-schema.js
- steps
- storage.test.js
- hero-lite.test.js
- rig.js
- geo.js
- core/index.js
- skin.js

## God Nodes (most connected - your core abstractions)
1. `MatchFlow` - 18 edges
2. `createScene()` - 17 edges
3. `three` - 16 edges
4. `CpuPilot` - 15 edges
5. `exports` - 12 edges
6. `InputState` - 12 edges
7. `numberTable()` - 12 edges
8. `stepDuel()` - 11 edges
9. `validateMoveTable()` - 11 edges
10. `createCameraDirector()` - 10 edges

## Surprising Connections (you probably didn't know these)
- `make()` --calls--> `FixedStepLoop`  [EXTRACTED]
  test/core/loop.test.js → src/core/loop.js
- `frame()` --calls--> `computeFraming()`  [EXTRACTED]
  test/render/camera-director.test.js → src/render/framing.js
- `duelAt()` --calls--> `createSnapshot()`  [EXTRACTED]
  test/sim/duel-helpers.js → src/input/input-snapshot.js
- `tick()` --calls--> `stepDuel()`  [EXTRACTED]
  test/sim/duel-helpers.js → src/sim/duel-sim.js
- `sampleAt()` --calls--> `createSnapshot()`  [EXTRACTED]
  test/input/input-snapshot.test.js → src/input/input-snapshot.js

## Import Cycles
- None detected.

## Communities (19 total, 0 thin omitted)

### Community 0 - "scene.js"
Cohesion: 0.05
Nodes (45): CAMERA_FEEL, clampPush(), createCameraDirector(), impact(), update(), orbitProgress(), pushEnvelope(), accentPanel() (+37 more)

### Community 1 - "hero-asset.test.js"
Cohesion: 0.06
Nodes (50): three, createGltfLoader, ADR-0003, assignRoles(), HERO_JOINTS, ADR-0001, ADR-0003, loadHeroAsset() (+42 more)

### Community 2 - "ref_node_assert"
Cohesion: 0.10
Nodes (21): createHaptics(), HANDEDNESS, resolveHandedness(), stickZoneSide(), createSnapshot(), attachTouchStick(), clampStickOrigin(), readSafeInsets() (+13 more)

### Community 3 - "cpu-controller.js"
Cohesion: 0.07
Nodes (27): ActionMix, actionOf(), ACTIONS, AI_ROLE, bestPokeReach(), bodyRadiusOf(), CAN_SIDESTEP, clearSnapshot() (+19 more)

### Community 4 - "sim/duel-sim.js"
Cohesion: 0.07
Nodes (40): createCylinder(), cylindersOverlap(), Hitstop, applyConnect(), armorAbsorbs(), connectResult(), createDuel(), createEvent() (+32 more)

### Community 5 - "state-machine.test.js"
Cohesion: 0.06
Nodes (50): deepFreeze(), numberTable(), ../fighters/duel-sim.js, CONNECT, CUE, EVENT, resetMeters(), buildMeter() (+42 more)

### Community 6 - "ai-support.test.js"
Cohesion: 0.14
Nodes (23): BEHAVIOUR_KEYS, buildBehaviour(), buildDifficulty(), buildDifficultySet(), DIFFICULTY_KEYS, difficultyFromQuery(), POKEABLE_KEYS, UNIT_KEYS (+15 more)

### Community 7 - "MatchFlow"
Cohesion: 0.12
Nodes (12): ROUND_KEYS, MATCH_EVENT, MATCH_STATE, MatchFlow, ROUND_REASON, roundWinner(), ROUND_RULES, MatchFlow (+4 more)

### Community 8 - "package.json"
Cohesion: 0.06
Nodes (31): author, description, devDependencies, three@0.187.0, engines, node, exports, ./ai (+23 more)

### Community 9 - "poses.js"
Cohesion: 0.16
Nodes (21): updateHurtbox(), tip, updateHurtboxes(), addPose(), attackPose(), computePose(), copyPose(), createPose() (+13 more)

### Community 10 - "InputState"
Cohesion: 0.15
Nodes (6): DoubleTapDetector, InputState, attachThrowButton(), attachTouchButtons(), bindPointer(), noop()

### Community 11 - "sfx-schema.js"
Cohesion: 0.18
Nodes (16): ADR-0005, buildSfxData(), BUSES, camel(), dbToGain(), FILTERS, fin(), ID_MAPS (+8 more)

### Community 12 - "steps"
Cohesion: 0.13
Nodes (14): jobs, test, name, on, pull_request, push, branches, tags (+6 more)

### Community 13 - "storage.test.js"
Cohesion: 0.24
Nodes (4): createSettingsStorage(), createSave(), ADR-0004, loadSave()

### Community 14 - "hero-lite.test.js"
Cohesion: 0.07
Nodes (37): ALLOWED_BARE, GAME_LEXICON, ADR-0004, ROOT, SRC, walk(), L, align() (+29 more)

### Community 15 - "rig.js"
Cohesion: 0.18
Nodes (5): createRig(), createRimUniforms(), createToyMaterial(), createToyMaterials(), ADR-0001

### Community 16 - "geo.js"
Cohesion: 0.24
Nodes (4): chamferRect(), ADR-0001, plate(), slab()

### Community 17 - "core/index.js"
Cohesion: 0.28
Nodes (3): FixedStepLoop, SIM_HZ, make()

### Community 18 - "skin.js"
Cohesion: 0.33
Nodes (3): createSkinnedBuilder(), ADR-0001, LAYOUT

## Knowledge Gaps
- **32 isolated node(s):** `ADR-0003`, `ADR-0003`, `ADR-0003`, `ADR-0001`, `ADR-0003` (+27 more)
  These have ≤1 connection - possible missing edges. (Counts symbols only; 191 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `three` connect `hero-asset.test.js` to `scene.js`, `package.json`, `rig.js`, `geo.js`, `skin.js`?**
  _High betweenness centrality (0.163) - this node is a cross-community bridge._
- **Are the 8 inferred relationships involving `createScene()` (e.g. with `dispose()` and `finalKo()`) actually correct?**
  _`createScene()` has 8 INFERRED edges - model-reasoned connections that need verification._
- **What connects `ADR-0003`, `ADR-0003`, `ADR-0003` to the rest of the system?**
  _32 weakly-connected nodes found - possible missing edges._
- **Should `scene.js` be split into smaller, more focused modules?**
  _Cohesion score 0.05213089802130898 - nodes in this community are weakly interconnected._
- **Why does `STATE` connect `state-machine.test.js` to `poses.js`, `cpu-controller.js`, `sim/duel-sim.js`?**
  _High betweenness centrality (0.037) - this node is a cross-community bridge._
- **Should `hero-asset.test.js` be split into smaller, more focused modules?**
  _Cohesion score 0.06317907444668008 - nodes in this community are weakly interconnected._
- **Should `ref_node_assert` be split into smaller, more focused modules?**
  _Cohesion score 0.0975609756097561 - nodes in this community are weakly interconnected._
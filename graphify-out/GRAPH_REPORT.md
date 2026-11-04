# Graph Report - game-engine  (2026-11-05)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 505 nodes · 1118 edges · 14 communities
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 26 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `c6a5377a`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- Community 0
- Community 1
- Community 2
- Community 3
- Community 4
- Community 5
- Community 6
- Community 7
- Community 8
- Community 9
- Community 10
- Community 11
- Community 12
- Community 13

## God Nodes (most connected - your core abstractions)
1. `MatchFlow` - 18 edges
2. `createScene()` - 17 edges
3. `CpuPilot` - 15 edges
4. `InputState` - 12 edges
5. `numberTable()` - 12 edges
6. `stepDuel()` - 11 edges
7. `validateMoveTable()` - 11 edges
8. `createCameraDirector()` - 10 edges
9. `attackPhase()` - 10 edges
10. `setState()` - 10 edges

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

## Communities (14 total, 0 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.06
Nodes (42): three, CAMERA_FEEL, clampPush(), createCameraDirector(), impact(), update(), orbitProgress(), pushEnvelope() (+34 more)

### Community 1 - "Community 1"
Cohesion: 0.07
Nodes (37): observe(), ../fighters/duel-sim.js, BUFFER, frameAdvantage(), FrameDataTracker, isStun(), OUTCOME, ACTIONABLE (+29 more)

### Community 2 - "Community 2"
Cohesion: 0.07
Nodes (29): FixedStepLoop, SIM_HZ, HANDEDNESS, resolveHandedness(), stickZoneSide(), createSnapshot(), attachTouchStick(), clampStickOrigin() (+21 more)

### Community 3 - "Community 3"
Cohesion: 0.08
Nodes (24): ActionMix, actionOf(), ACTIONS, AI_ROLE, bestPokeReach(), bodyRadiusOf(), CAN_SIDESTEP, clearSnapshot() (+16 more)

### Community 4 - "Community 4"
Cohesion: 0.09
Nodes (30): createCylinder(), cylindersOverlap(), Hitstop, applyConnect(), armorAbsorbs(), CONNECT, connectResult(), createDuel() (+22 more)

### Community 5 - "Community 5"
Cohesion: 0.12
Nodes (28): deepFreeze(), numberTable(), buildMeter(), buildRules(), METER_KEYS, RULE_KEYS, buildRoundRules(), ROUND_KEYS (+20 more)

### Community 6 - "Community 6"
Cohesion: 0.14
Nodes (23): BEHAVIOUR_KEYS, buildBehaviour(), buildDifficulty(), buildDifficultySet(), DIFFICULTY_KEYS, difficultyFromQuery(), POKEABLE_KEYS, UNIT_KEYS (+15 more)

### Community 7 - "Community 7"
Cohesion: 0.14
Nodes (11): MATCH_EVENT, MATCH_STATE, MatchFlow, ROUND_REASON, roundWinner(), ROUND_RULES, MatchFlow, koRound() (+3 more)

### Community 8 - "Community 8"
Cohesion: 0.07
Nodes (28): author, description, devDependencies, three@0.187.0, engines, node, exports, ./ai (+20 more)

### Community 9 - "Community 9"
Cohesion: 0.17
Nodes (20): updateHurtbox(), tip, updateHurtboxes(), addPose(), attackPose(), computePose(), copyPose(), createPose() (+12 more)

### Community 10 - "Community 10"
Cohesion: 0.15
Nodes (6): DoubleTapDetector, InputState, attachThrowButton(), attachTouchButtons(), bindPointer(), noop()

### Community 11 - "Community 11"
Cohesion: 0.15
Nodes (14): createHaptics(), buildSfxData(), BUSES, camel(), dbToGain(), FILTERS, fin(), ID_MAPS (+6 more)

### Community 12 - "Community 12"
Cohesion: 0.13
Nodes (14): jobs, test, name, on, pull_request, push, branches, tags (+6 more)

### Community 13 - "Community 13"
Cohesion: 0.24
Nodes (4): createSettingsStorage(), createSave(), ADR-0004, loadSave()

## Knowledge Gaps
- **10 isolated node(s):** `ADR-0001`, `ADR-0001`, `ADR-0001`, `ADR-0001`, `ADR-0001` (+5 more)
  These have ≤1 connection - possible missing edges. (Counts symbols only; 134 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `three` connect `Community 0` to `Community 8`?**
  _High betweenness centrality (0.105) - this node is a cross-community bridge._
- **Are the 8 inferred relationships involving `createScene()` (e.g. with `dispose()` and `finalKo()`) actually correct?**
  _`createScene()` has 8 INFERRED edges - model-reasoned connections that need verification._
- **What connects `ADR-0001`, `ADR-0001`, `ADR-0001` to the rest of the system?**
  _10 weakly-connected nodes found - possible missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.05583972719522592 - nodes in this community are weakly interconnected._
- **Why does `STATE` connect `Community 1` to `Community 9`, `Community 3`, `Community 4`?**
  _High betweenness centrality (0.040) - this node is a cross-community bridge._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.07049180327868852 - nodes in this community are weakly interconnected._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.06531986531986532 - nodes in this community are weakly interconnected._
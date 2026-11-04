# Graph Report - game-engine  (2026-11-05)

## Corpus Check
- 145 files · ~99,160 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 3 file(s) not represented in the graph (top: (none) 3)

## Summary
- 1145 nodes · 2420 edges · 55 communities (51 shown, 4 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 44 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `e12ab8e0`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- quality.test.js
- hero-asset.test.js
- ref_node_assert
- cpu-controller.js
- sim/duel-sim.js
- ref_node_assert
- bake.py
- MatchFlow
- package.json
- poses.js
- dsp.mjs
- sfx-schema.js
- steps
- storage.test.js
- hero-lite.test.js
- rig-contract.test.js
- geo.js
- Hitstop
- skin.js
- ref_node_assert
- hardsurface.py
- smoke_plate.py
- sim/index.js
- build.py
- createCameraDirector
- armature.py
- smoke_cube.py
- compress.mjs
- source-hash.test.js
- FakeAudioContext
- smoke_rig.py
- MatchFlow
- FakeParam
- scene-hooks.test.js
- source-hash.mjs
- bpy
- hardsurface.py
- three
- sim/moves.js
- createScene
- run.mjs
- acoustic-space.test.js
- _set_axes
- render-bank.mjs
- ref_node_path
- sample-bank.test.js
- pbr.py
- haptics.test.js
- frame-data.js
- boundary.test.js
- bound/fighter.js
- bind_world_three
- environment.js
- computeFraming
- setup.sh

## God Nodes (most connected - your core abstractions)
1. `three` - 22 edges
2. `FakeAudioContext` - 22 edges
3. `createScene()` - 21 edges
4. `MatchFlow` - 18 edges
5. `createCameraDirector()` - 16 edges
6. `FakeParam` - 15 edges
7. `FakeNode` - 15 edges
8. `sec()` - 15 edges
9. `CpuPilot` - 15 edges
10. `build()` - 14 edges

## Surprising Connections (you probably didn't know these)
- `frame()` --calls--> `computeFraming()`  [EXTRACTED]
  test/render/camera-director.test.js → src/render/framing.js
- `MatchFlow` --inherits--> `MatchFlow`  [EXTRACTED]
  test/fixtures/bound/match-flow.js → src/sim/match-flow.js
- `make()` --calls--> `FixedStepLoop`  [EXTRACTED]
  test/core/loop.test.js → src/core/loop.js
- `measure()` --calls--> `FrameDataTracker`  [EXTRACTED]
  test/sim/frame-data.test.js → src/sim/frame-data.js
- `cyl()` --calls--> `createCylinder()`  [EXTRACTED]
  test/core/collision.test.js → src/core/collision.js

## Import Cycles
- None detected.

## Communities (55 total, 4 thin omitted)

### Community 0 - "quality.test.js"
Cohesion: 0.13
Nodes (10): ADR-0001, canReachBloom(), ADR-0001, QUALITY_CONFIG, ADR-0001, materialTierFor(), QualityGovernor, resolveTiers() (+2 more)

### Community 1 - "hero-asset.test.js"
Cohesion: 0.06
Nodes (49): createGltfLoader, ADR-0003, assignRoles(), HERO_JOINTS, ADR-0001, ADR-0003, loadHeroAsset(), createHeroAssetStore() (+41 more)

### Community 2 - "ref_node_assert"
Cohesion: 0.08
Nodes (22): HANDEDNESS, resolveHandedness(), stickZoneSide(), createSnapshot(), DoubleTapDetector, InputState, attachThrowButton(), attachTouchButtons() (+14 more)

### Community 3 - "cpu-controller.js"
Cohesion: 0.05
Nodes (48): ActionMix, actionOf(), ACTIONS, AI_ROLE, bestPokeReach(), bodyRadiusOf(), CAN_SIDESTEP, clearSnapshot() (+40 more)

### Community 4 - "sim/duel-sim.js"
Cohesion: 0.11
Nodes (35): applyConnect(), armorAbsorbs(), CONNECT, connectResult(), CUE, cue(), emit(), EVENT_NUM_FIELDS (+27 more)

### Community 5 - "ref_node_assert"
Cohesion: 0.14
Nodes (15): canTransition(), PHASE, STATE, TRANSITIONS, FIGHTER_RULES, MOVES, dist(), DT (+7 more)

### Community 6 - "bake.py"
Cohesion: 0.11
Nodes (14): bake(), bake_attribute(), bake_chain(), bake_curvature(), wire(), _bake_emit_with(), _bake_target_node(), _clear_bake_target() (+6 more)

### Community 7 - "MatchFlow"
Cohesion: 0.25
Nodes (10): MATCH_EVENT, MATCH_STATE, ROUND_REASON, roundWinner(), ROUND_RULES, MatchFlow, koRound(), make() (+2 more)

### Community 8 - "package.json"
Cohesion: 0.06
Nodes (32): author, description, devDependencies, three@0.187.0, engines, node, exports, ./ai (+24 more)

### Community 9 - "poses.js"
Cohesion: 0.17
Nodes (20): updateHurtbox(), tip, updateHurtboxes(), addPose(), attackPose(), computePose(), copyPose(), createPose() (+12 more)

### Community 10 - "dsp.mjs"
Cohesion: 0.11
Nodes (29): biquad(), bubbles(), contactPulse(), crackle(), dbToGain(), env(), fadeEdges(), fft() (+21 more)

### Community 11 - "sfx-schema.js"
Cohesion: 0.17
Nodes (17): buildSfxData(), BUSES, camel(), dbToGain(), FILTERS, fin(), ID_MAPS, ADR-0004 (+9 more)

### Community 12 - "steps"
Cohesion: 0.13
Nodes (14): jobs, test, name, on, pull_request, push, branches, tags (+6 more)

### Community 13 - "storage.test.js"
Cohesion: 0.24
Nodes (4): createSettingsStorage(), createSave(), ADR-0004, loadSave()

### Community 14 - "hero-lite.test.js"
Cohesion: 0.13
Nodes (24): align(), fakeGlb(), fakeKtx2(), KTX2_ID, levelBytes(), fixture(), imagelessGlb(), align() (+16 more)

### Community 15 - "rig-contract.test.js"
Cohesion: 0.09
Nodes (22): fmt(), glbSkinViolations(), JOINT_NAME, ADR-0001, ADR-0003, near(), rigViolations(), createRig() (+14 more)

### Community 16 - "geo.js"
Cohesion: 0.24
Nodes (4): chamferRect(), ADR-0001, plate(), slab()

### Community 17 - "Hitstop"
Cohesion: 0.13
Nodes (6): Hitstop, FixedStepLoop, SIM_HZ, createDuel(), createEvent(), make()

### Community 18 - "skin.js"
Cohesion: 0.33
Nodes (3): createSkinnedBuilder(), ADR-0001, LAYOUT

### Community 19 - "ref_node_assert"
Cohesion: 0.24
Nodes (8): createCylinder(), cylindersOverlap(), createCombatant(), createFighter(), cyl(), stepFighter(), run(), setup()

### Community 20 - "hardsurface.py"
Cohesion: 0.20
Nodes (10): brushed(), depth(), _displace_along_normals(), edge_wear(), hammered(), depth(), feature(), _value_noise() (+2 more)

### Community 21 - "smoke_plate.py"
Cohesion: 0.11
Nodes (13): chamfer_outline(), densify(), mirror_half(), quilt(), remesh(), row(), snap_to_surface(), activate() (+5 more)

### Community 22 - "sim/index.js"
Cohesion: 0.18
Nodes (16): numberTable(), buildMeter(), buildRules(), METER_KEYS, RULE_KEYS, buildRoundRules(), ROUND_KEYS, buildMovement() (+8 more)

### Community 23 - "build.py"
Cohesion: 0.14
Nodes (9): build_one(), clean_dir(), discover(), load_config(), load_script(), main(), node(), node_exe() (+1 more)

### Community 24 - "createCameraDirector"
Cohesion: 0.16
Nodes (14): CAMERA_FEEL, clampPush(), createCameraDirector(), focus(), focusLevel(), impact(), impulse(), release() (+6 more)

### Community 25 - "armature.py"
Cohesion: 0.14
Nodes (11): bind_blend(), bind_rigid(), _ensure_modifier(), fighter_entry(), find_armature(), fix_weights(), _group(), joint_matrix() (+3 more)

### Community 26 - "smoke_cube.py"
Cohesion: 0.12
Nodes (13): save_png(), mirror_copy(), apply_modifiers(), delete(), duplicate(), rng(), triangle_count(), build() (+5 more)

### Community 27 - "compress.mjs"
Cohesion: 0.19
Nodes (16): encodeTextures(), generatorString(), KTX2_PROFILES, loadEncoders(), main(), ADR-0003, profileFor(), quietly() (+8 more)

### Community 28 - "source-hash.test.js"
Cohesion: 0.18
Nodes (14): absPath(), ENCODER_PACKAGES, GLTF_TRANSFORM_VERSION, LOGICAL_PREFIX, ADR-0004, pinnedBpyVersion(), resolveConfig(), ADR-0003 (+6 more)

### Community 30 - "smoke_rig.py"
Cohesion: 0.19
Nodes (8): join(), joint_head(), _armour(), _ball(), build(), _flat_material(), _limb(), _mannequin()

### Community 33 - "scene-hooks.test.js"
Cohesion: 0.20
Nodes (9): FAKE_LOOK, fakeContainer(), fakeFighters(), fakeFighterView(), fakeRenderer(), fakeStage(), installFakeWindow(), build() (+1 more)

### Community 34 - "source-hash.mjs"
Cohesion: 0.23
Nodes (13): proportionsTextFor(), assetInputFiles(), encoderVersions(), hashableBytes(), listAssetScripts(), listPipelineFiles(), ADR-0003, ADR-0004 (+5 more)

### Community 35 - "bpy"
Cohesion: 0.12
Nodes (6): export_glb(), _sort_faces(), _triangulate_all(), _gltf_output_group(), pbr_material(), render_turntable()

### Community 36 - "hardsurface.py"
Cohesion: 0.10
Nodes (16): assign_material_id(), _attr(), bezier_profile(), ensure_masks(), _faces_front(), fasteners(), mark_seam(), _mat_id() (+8 more)

### Community 37 - "three"
Cohesion: 0.24
Nodes (11): applyGrade(), createEnvScene(), createGradePass(), createHeroComposer(), disposeScene(), ENV_CACHE, getHeroEnvironment(), GRADE_DEFAULTS (+3 more)

### Community 38 - "sim/moves.js"
Cohesion: 0.25
Nodes (12): deepFreeze(), AI_ROLES, ARMOR_LEVELS, buildMoves(), chainLength(), GUARD_TABLE, MOVE_FIELDS, MOVE_INPUTS (+4 more)

### Community 39 - "createScene"
Cohesion: 0.14
Nodes (22): three, configureShadowCaster(), createDefaultLightRig(), ADR-0001, setShadowFlag(), SHADOW_DEFAULTS, SHADOW_TYPES, disposeHeroEnvironment() (+14 more)

### Community 40 - "run.mjs"
Cohesion: 0.14
Nodes (11): ENGINE_BLENDER_DIR, build, cmd, { configPath, setupOnly, rest }, env, [exe, ...args], ADR-0003, ADR-0004 (+3 more)

### Community 41 - "acoustic-space.test.js"
Cohesion: 0.24
Nodes (9): createAcousticSpace(), createHarmonicLift(), createSend(), ADR-0005, lcg(), makeImpulseResponse(), makeTanhCurve(), ADR-0005 (+1 more)

### Community 42 - "_set_axes"
Cohesion: 0.20
Nodes (6): build_armature(), _contract(), contract_manifest(), _heat_tails(), _set_axes(), write_manifest()

### Community 43 - "render-bank.mjs"
Cohesion: 0.24
Nodes (7): ADR-0005, aacEncoder(), encode(), ADR-0005, renderBank(), RENDERER_VERSION, renderVariant()

### Community 44 - "ref_node_path"
Cohesion: 0.29
Nodes (7): L, checkBundleSizes(), isMain, listDistJs(), loadLimits(), ADR-0004, runBundleCheck()

### Community 45 - "sample-bank.test.js"
Cohesion: 0.27
Nodes (9): createSampleBank(), fin(), ADR-0005, parseBankManifest(), FILES, ADR-0005, manifest(), setup() (+1 more)

### Community 46 - "pbr.py"
Cohesion: 0.20
Nodes (9): compose(), decode_ids(), _grid(), _linear_to_srgb(), preset(), _smooth(), _validate(), value_noise() (+1 more)

### Community 47 - "haptics.test.js"
Cohesion: 0.27
Nodes (6): createHaptics(), impactBackend(), ADR-0005, vibrateBackend(), ADR-0005, fakeNavigator()

### Community 48 - "frame-data.js"
Cohesion: 0.24
Nodes (7): ../fighters/duel-sim.js, EVENT, frameAdvantage(), FrameDataTracker, isStun(), OUTCOME, moveTotal()

### Community 49 - "boundary.test.js"
Cohesion: 0.22
Nodes (6): ALLOWED_BARE, GAME_LEXICON, ADR-0004, ROOT, SRC, walk()

### Community 51 - "bind_world_three"
Cohesion: 0.33
Nodes (3): bind_world_three(), rest_offsets(), three_euler_matrix()

### Community 52 - "environment.js"
Cohesion: 0.40
Nodes (5): accentPanel(), bakeStageEnvironment(), ADR-0001, ADR-0003, ENV_PANELS

### Community 54 - "computeFraming"
Cohesion: 0.60
Nodes (3): computeFraming(), FRAMING_CONFIG, frame()

### Community 55 - "setup.sh"
Cohesion: 0.83
Nodes (3): abs_path(), setup.sh script, verify()

## Knowledge Gaps
- **59 isolated node(s):** `ADR-0003`, `ADR-0004`, `ADR-0003`, `ADR-0001`, `ADR-0003` (+54 more)
  These have ≤1 connection - possible missing edges. (Counts symbols only; 379 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **4 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `three` connect `createScene` to `hero-asset.test.js`, `scene-hooks.test.js`, `three`, `package.json`, `rig-contract.test.js`, `geo.js`, `skin.js`, `environment.js`?**
  _High betweenness centrality (0.080) - this node is a cross-community bridge._
- **Are the 10 inferred relationships involving `createScene()` (e.g. with `dispose()` and `finalKo()`) actually correct?**
  _`createScene()` has 10 INFERRED edges - model-reasoned connections that need verification._
- **What connects `ADR-0003`, `ADR-0004`, `ADR-0003` to the rest of the system?**
  _59 weakly-connected nodes found - possible missing edges._
- **Should `quality.test.js` be split into smaller, more focused modules?**
  _Cohesion score 0.13043478260869565 - nodes in this community are weakly interconnected._
- **Why does `FakeAudioContext` connect `FakeAudioContext` to `FakeParam`, `acoustic-space.test.js`, `sample-bank.test.js`, `haptics.test.js`?**
  _High betweenness centrality (0.026) - this node is a cross-community bridge._
- **Should `hero-asset.test.js` be split into smaller, more focused modules?**
  _Cohesion score 0.062111801242236024 - nodes in this community are weakly interconnected._
- **Should `ref_node_assert` be split into smaller, more focused modules?**
  _Cohesion score 0.0782312925170068 - nodes in this community are weakly interconnected._
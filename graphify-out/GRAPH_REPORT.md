# Graph Report - game-engine  (2026-11-05)

## Corpus Check
- 152 files · ~119,926 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 3 file(s) not represented in the graph (top: (none) 3)

## Summary
- 1303 nodes · 2783 edges · 60 communities (54 shown, 6 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 54 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `a840e9d3`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- quality.test.js
- hero-asset.test.js
- ref_node_assert
- ai-support.test.js
- sim/duel-sim.js
- MatchFlow
- bake.py
- CpuPilot
- package.json
- poses.js
- dsp.mjs
- sfx-schema.js
- steps
- storage.test.js
- hero-lite.test.js
- rig-contract.test.js
- geo.js
- intent.test.js
- hazards.js
- cpu-controller.js
- hardsurface.py
- smoke_plate.py
- sim/state-machine.js
- build.py
- createCameraDirector
- armature.py
- scene.py
- compress.mjs
- source-hash.test.js
- FakeAudioContext
- smoke_rig.py
- state-machine.test.js
- FakeParam
- scene-hooks.test.js
- hazard-perception.test.js
- bpy
- hardsurface.py
- three
- vite-hero-assets.test.js
- createScene
- run.mjs
- acoustic-space.test.js
- sim/index.js
- render-bank.mjs
- ref_node_path
- sample-bank.test.js
- pbr.py
- haptics.test.js
- node-pool.test.js
- boundary.test.js
- frame-data.js
- _set_axes
- meter-cost.test.js
- bind_world_three
- computeFraming
- setup.sh
- ActionMix
- ref_node_assert
- ai-data.js
- gpu-caps.js

## God Nodes (most connected - your core abstractions)
1. `CpuPilot` - 25 edges
2. `FakeAudioContext` - 23 edges
3. `three` - 22 edges
4. `createScene()` - 21 edges
5. `MatchFlow` - 20 edges
6. `sec()` - 16 edges
7. `createCameraDirector()` - 16 edges
8. `stepDuel()` - 16 edges
9. `FakeNode` - 15 edges
10. `FakeParam` - 15 edges

## Surprising Connections (you probably didn't know these)
- `make()` --calls--> `FixedStepLoop`  [EXTRACTED]
  test/core/loop.test.js → src/core/loop.js
- `imagelessGlb()` --calls--> `writeGlb()`  [EXTRACTED]
  test/tools/vite-hero-assets.test.js → tools/hero-lite.mjs
- `arena()` --calls--> `createDuel()`  [EXTRACTED]
  test/sim/hazards.test.js → src/sim/duel-sim.js
- `rulesetWith()` --calls--> `createRuleset()`  [EXTRACTED]
  test/sim/hazards.test.js → src/sim/ruleset.js
- `tick()` --calls--> `stepDuel()`  [EXTRACTED]
  test/sim/hazards.test.js → src/sim/duel-sim.js

## Import Cycles
- None detected.

## Communities (60 total, 6 thin omitted)

### Community 0 - "quality.test.js"
Cohesion: 0.15
Nodes (10): canReachBloom(), ADR-0001, QUALITY_CONFIG, ADR-0001, materialTierFor(), QualityGovernor, resolveTiers(), TIER_FLAGS (+2 more)

### Community 1 - "hero-asset.test.js"
Cohesion: 0.05
Nodes (62): three, createGltfLoader, ADR-0003, assignRoles(), HERO_JOINTS, ADR-0001, ADR-0003, loadHeroAsset() (+54 more)

### Community 2 - "ref_node_assert"
Cohesion: 0.08
Nodes (22): HANDEDNESS, resolveHandedness(), stickZoneSide(), createSnapshot(), DoubleTapDetector, InputState, attachThrowButton(), attachTouchButtons() (+14 more)

### Community 3 - "ai-support.test.js"
Cohesion: 0.13
Nodes (26): BEHAVIOUR_DEFAULTS, BEHAVIOUR_KEYS, buildBehaviour(), buildDifficulty(), buildDifficultySet(), DIFFICULTY_DEFAULTS, DIFFICULTY_KEYS, difficultyFromQuery() (+18 more)

### Community 4 - "sim/duel-sim.js"
Cohesion: 0.12
Nodes (30): createCylinder(), cylindersOverlap(), applyConnect(), armorAbsorbs(), connectResult(), createDuel(), createEvent(), cue() (+22 more)

### Community 5 - "MatchFlow"
Cohesion: 0.09
Nodes (12): isKoReason(), MATCH_EVENT, MATCH_STATE, MatchFlow, ROUND_REASON, roundWinner(), ROUND_RULES, MatchFlow (+4 more)

### Community 6 - "bake.py"
Cohesion: 0.11
Nodes (14): bake(), bake_attribute(), bake_chain(), bake_curvature(), wire(), _bake_emit_with(), _bake_target_node(), _clear_bake_target() (+6 more)

### Community 7 - "CpuPilot"
Cohesion: 0.17
Nodes (11): bestPokeReach(), bodyRadiusOf(), CpuPilot, frameAdvantage(), keyMove(), keyReach(), moveReach(), pressMove() (+3 more)

### Community 8 - "package.json"
Cohesion: 0.06
Nodes (32): author, description, devDependencies, three@0.187.0, engines, node, exports, ./ai (+24 more)

### Community 9 - "poses.js"
Cohesion: 0.16
Nodes (21): updateHurtbox(), tip, updateHurtboxes(), addPose(), attackPose(), computePose(), copyPose(), createPose() (+13 more)

### Community 10 - "dsp.mjs"
Cohesion: 0.11
Nodes (30): biquad(), bubbles(), contactPulse(), crackle(), dbToGain(), env(), fadeEdges(), fft() (+22 more)

### Community 11 - "sfx-schema.js"
Cohesion: 0.15
Nodes (20): ADR-0004, buildSfxData(), BUSES, camel(), dbToGain(), FILTERS, fin(), ID_MAPS (+12 more)

### Community 12 - "steps"
Cohesion: 0.13
Nodes (14): jobs, test, name, on, pull_request, push, branches, tags (+6 more)

### Community 13 - "storage.test.js"
Cohesion: 0.13
Nodes (4): Hitstop, createSave(), ADR-0004, loadSave()

### Community 14 - "hero-lite.test.js"
Cohesion: 0.21
Nodes (17): align(), fakeGlb(), fakeKtx2(), KTX2_ID, levelBytes(), align(), applyIdsOverride(), buildInlinePayload() (+9 more)

### Community 15 - "rig-contract.test.js"
Cohesion: 0.09
Nodes (22): fmt(), glbSkinViolations(), JOINT_NAME, ADR-0001, ADR-0003, near(), rigViolations(), createRig() (+14 more)

### Community 16 - "geo.js"
Cohesion: 0.24
Nodes (4): chamferRect(), ADR-0001, plate(), slab()

### Community 17 - "intent.test.js"
Cohesion: 0.08
Nodes (10): duel(), KIT, OFFENSIVE, PASSIVE, passive(), RULESET, SET, sharp() (+2 more)

### Community 18 - "hazards.js"
Cohesion: 0.08
Nodes (37): buildHazards(), buildOne(), camel(), CYCLE_KEYS, EFFECT_RULES, emitHazard(), fighterInZone(), ge0() (+29 more)

### Community 19 - "cpu-controller.js"
Cohesion: 0.11
Nodes (19): ACTIONS, AI_ROLE, CAN_SIDESTEP, clearSnapshot(), COUNTER_KEYS, CROUCH_KEYS, NO_TABLE, PLAN (+11 more)

### Community 20 - "hardsurface.py"
Cohesion: 0.20
Nodes (10): brushed(), depth(), _displace_along_normals(), edge_wear(), hammered(), depth(), feature(), _value_noise() (+2 more)

### Community 21 - "smoke_plate.py"
Cohesion: 0.11
Nodes (13): chamfer_outline(), densify(), mirror_half(), quilt(), remesh(), row(), snap_to_surface(), activate() (+5 more)

### Community 22 - "sim/state-machine.js"
Cohesion: 0.14
Nodes (16): ACTIONABLE, advanceFighter(), beginMove(), bufferedMoveId(), canAfford(), canTransition(), chainAttack(), chainMoveId() (+8 more)

### Community 23 - "build.py"
Cohesion: 0.14
Nodes (9): build_one(), clean_dir(), discover(), load_config(), load_script(), main(), node(), node_exe() (+1 more)

### Community 24 - "createCameraDirector"
Cohesion: 0.16
Nodes (14): CAMERA_FEEL, clampPush(), createCameraDirector(), focus(), focusLevel(), impact(), impulse(), release() (+6 more)

### Community 25 - "armature.py"
Cohesion: 0.14
Nodes (11): bind_blend(), bind_rigid(), _ensure_modifier(), fighter_entry(), find_armature(), fix_weights(), _group(), joint_matrix() (+3 more)

### Community 26 - "scene.py"
Cohesion: 0.12
Nodes (13): save_png(), mirror_copy(), apply_modifiers(), delete(), duplicate(), rng(), triangle_count(), build() (+5 more)

### Community 27 - "compress.mjs"
Cohesion: 0.20
Nodes (15): encodeTextures(), generatorString(), KTX2_PROFILES, loadEncoders(), main(), ADR-0003, profileFor(), quietly() (+7 more)

### Community 28 - "source-hash.test.js"
Cohesion: 0.11
Nodes (29): absPath(), ENCODER_PACKAGES, ENGINE_BLENDER_DIR, GLTF_TRANSFORM_VERSION, loadConfig(), LOGICAL_PREFIX, ADR-0004, pinnedBpyVersion() (+21 more)

### Community 30 - "smoke_rig.py"
Cohesion: 0.19
Nodes (8): join(), joint_head(), _armour(), _ball(), build(), _flat_material(), _limb(), _mannequin()

### Community 31 - "state-machine.test.js"
Cohesion: 0.13
Nodes (17): CONNECT, CUE, EVENT, resetMeters(), BUFFER, PHASE, TRANSITIONS, createDuel() (+9 more)

### Community 33 - "scene-hooks.test.js"
Cohesion: 0.20
Nodes (9): FAKE_LOOK, fakeContainer(), fakeFighters(), fakeFighterView(), fakeRenderer(), fakeStage(), installFakeWindow(), build() (+1 more)

### Community 34 - "hazard-perception.test.js"
Cohesion: 0.15
Nodes (5): PASSIVE, PHASE, RULESET, TEL, VENT

### Community 35 - "bpy"
Cohesion: 0.12
Nodes (6): export_glb(), _sort_faces(), _triangulate_all(), _gltf_output_group(), pbr_material(), render_turntable()

### Community 36 - "hardsurface.py"
Cohesion: 0.10
Nodes (16): assign_material_id(), _attr(), bezier_profile(), ensure_masks(), _faces_front(), fasteners(), mark_seam(), _mat_id() (+8 more)

### Community 37 - "three"
Cohesion: 0.16
Nodes (16): accentPanel(), bakeStageEnvironment(), ADR-0001, ADR-0003, applyGrade(), createEnvScene(), createGradePass(), createHeroComposer() (+8 more)

### Community 38 - "vite-hero-assets.test.js"
Cohesion: 0.23
Nodes (8): fixture(), imagelessGlb(), addLiteSet(), escapeRe(), heroAssetFiles(), heroAssetsPlugin(), MIME, ADR-0004

### Community 39 - "createScene"
Cohesion: 0.13
Nodes (21): configureShadowCaster(), createDefaultLightRig(), ADR-0001, setShadowFlag(), SHADOW_DEFAULTS, SHADOW_TYPES, disposeHeroEnvironment(), createRenderer() (+13 more)

### Community 40 - "run.mjs"
Cohesion: 0.14
Nodes (10): build, cmd, { configPath, setupOnly, rest }, env, [exe, ...args], ADR-0003, ADR-0004, python (+2 more)

### Community 41 - "acoustic-space.test.js"
Cohesion: 0.24
Nodes (9): createAcousticSpace(), createHarmonicLift(), createSend(), ADR-0005, lcg(), makeImpulseResponse(), makeTanhCurve(), ADR-0005 (+1 more)

### Community 42 - "sim/index.js"
Cohesion: 0.10
Nodes (32): deepFreeze(), numberTable(), buildMeter(), buildRules(), METER_KEYS, RULE_KEYS, buildRoundRules(), ROUND_KEYS (+24 more)

### Community 43 - "render-bank.mjs"
Cohesion: 0.29
Nodes (7): ADR-0005, aacEncoder(), encode(), ADR-0005, renderBank(), RENDERER_VERSION, renderVariant()

### Community 44 - "ref_node_path"
Cohesion: 0.29
Nodes (8): L, checkBundleSizes(), isMain, lazyPatterns(), listDistJs(), loadLimits(), ADR-0004, runBundleCheck()

### Community 45 - "sample-bank.test.js"
Cohesion: 0.27
Nodes (9): createSampleBank(), fin(), ADR-0005, parseBankManifest(), FILES, ADR-0005, manifest(), setup() (+1 more)

### Community 46 - "pbr.py"
Cohesion: 0.20
Nodes (9): compose(), decode_ids(), _grid(), _linear_to_srgb(), preset(), _smooth(), _validate(), value_noise() (+1 more)

### Community 47 - "haptics.test.js"
Cohesion: 0.27
Nodes (6): createHaptics(), impactBackend(), ADR-0005, vibrateBackend(), ADR-0005, fakeNavigator()

### Community 48 - "node-pool.test.js"
Cohesion: 0.22
Nodes (7): collectOscillatorWaves(), createNodePool(), createWaveWarmer(), KINDS, OSCILLATOR_WAVES, POOL_KINDS, SIZES

### Community 49 - "boundary.test.js"
Cohesion: 0.22
Nodes (6): ALLOWED_BARE, GAME_LEXICON, ADR-0004, ROOT, SRC, walk()

### Community 50 - "frame-data.js"
Cohesion: 0.23
Nodes (9): ../fighters/duel-sim.js, frameAdvantage(), FrameDataTracker, isStun(), OUTCOME, STATE, duelAt(), measure() (+1 more)

### Community 51 - "_set_axes"
Cohesion: 0.20
Nodes (6): build_armature(), _contract(), contract_manifest(), _heat_tails(), _set_axes(), write_manifest()

### Community 53 - "bind_world_three"
Cohesion: 0.33
Nodes (3): bind_world_three(), rest_offsets(), three_euler_matrix()

### Community 54 - "computeFraming"
Cohesion: 0.60
Nodes (3): computeFraming(), FRAMING_CONFIG, frame()

### Community 55 - "setup.sh"
Cohesion: 0.83
Nodes (3): abs_path(), setup.sh script, verify()

### Community 57 - "ref_node_assert"
Cohesion: 0.20
Nodes (4): FixedStepLoop, SIM_HZ, SeededRng, make()

## Knowledge Gaps
- **60 isolated node(s):** `ADR-0003`, `ADR-0003`, `ADR-0001`, `ADR-0001`, `ADR-0003` (+55 more)
  These have ≤1 connection - possible missing edges. (Counts symbols only; 448 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **6 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `three` connect `hero-asset.test.js` to `scene-hooks.test.js`, `three`, `createScene`, `package.json`, `rig-contract.test.js`, `geo.js`?**
  _High betweenness centrality (0.102) - this node is a cross-community bridge._
- **What connects `ADR-0003`, `ADR-0003`, `ADR-0001` to the rest of the system?**
  _60 weakly-connected nodes found - possible missing edges._
- **Should `quality.test.js` be split into smaller, more focused modules?**
  _Cohesion score 0.1471861471861472 - nodes in this community are weakly interconnected._
- **Why does `MatchFlow` connect `MatchFlow` to `hazards.js`?**
  _High betweenness centrality (0.018) - this node is a cross-community bridge._
- **Should `hero-asset.test.js` be split into smaller, more focused modules?**
  _Cohesion score 0.051061388410786 - nodes in this community are weakly interconnected._
- **Why does `STATE` connect `frame-data.js` to `hazard-perception.test.js`, `sim/duel-sim.js`, `poses.js`, `hazards.js`, `cpu-controller.js`, `sim/state-machine.js`, `state-machine.test.js`?**
  _High betweenness centrality (0.017) - this node is a cross-community bridge._
- **Should `ref_node_assert` be split into smaller, more focused modules?**
  _Cohesion score 0.0782312925170068 - nodes in this community are weakly interconnected._
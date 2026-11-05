# Graph Report - game-engine  (2026-11-05)

## Corpus Check
- 156 files · ~126,961 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 3 file(s) not represented in the graph (top: (none) 3)

## Summary
- 1329 nodes · 2835 edges · 72 communities (69 shown, 3 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 54 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `f9419b75`
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
- ref_node_assert
- dsp.mjs
- sfx-schema.js
- steps
- hazards.test.js
- hero-lite.test.js
- rig-contract.test.js
- geo.js
- intent.test.js
- hazards.js
- cpu-controller.js
- scene.py
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
- stage-fixtures.js
- scene-hooks.test.js
- hazard-perception.test.js
- turntable.py
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
- scene.js
- bind_world_three
- export.py
- setup.sh
- sim/fighter.js
- keyReach
- brushed
- render/index.js
- createDownloadLane
- sim/moves.js
- perception.js
- stage-asset-store.js
- gltf-loader-stack.js
- storage.test.js
- meter-cost.test.js
- hero-asset-store.js
- createHeroAssetStore
- computeFraming
- sharp
- find_armature

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
- `store()` --calls--> `createStageAssetStore()`  [EXTRACTED]
  test/assets/stage-asset-store.test.js → src/assets/stage-asset-store.js
- `make()` --calls--> `FixedStepLoop`  [EXTRACTED]
  test/core/loop.test.js → src/core/loop.js
- `arena()` --calls--> `createDuel()`  [EXTRACTED]
  test/sim/hazards.test.js → src/sim/duel-sim.js
- `rulesetWith()` --calls--> `createRuleset()`  [EXTRACTED]
  test/sim/hazards.test.js → src/sim/ruleset.js
- `tick()` --calls--> `stepDuel()`  [EXTRACTED]
  test/sim/hazards.test.js → src/sim/duel-sim.js

## Import Cycles
- None detected.

## Communities (72 total, 3 thin omitted)

### Community 0 - "quality.test.js"
Cohesion: 0.16
Nodes (9): canReachBloom(), ADR-0001, QUALITY_CONFIG, ADR-0001, materialTierFor(), QualityGovernor, resolveTiers(), TIER_FLAGS (+1 more)

### Community 1 - "hero-asset.test.js"
Cohesion: 0.16
Nodes (19): assignRoles(), HERO_JOINTS, ADR-0001, ADR-0003, loadHeroAsset(), toBindSpace(), lodForTier(), abortableFiles() (+11 more)

### Community 2 - "ref_node_assert"
Cohesion: 0.08
Nodes (22): HANDEDNESS, resolveHandedness(), stickZoneSide(), createSnapshot(), DoubleTapDetector, InputState, attachThrowButton(), attachTouchButtons() (+14 more)

### Community 3 - "ai-support.test.js"
Cohesion: 0.12
Nodes (28): BEHAVIOUR_DEFAULTS, BEHAVIOUR_KEYS, buildBehaviour(), buildDifficulty(), buildDifficultySet(), DIFFICULTY_DEFAULTS, DIFFICULTY_KEYS, difficultyFromQuery() (+20 more)

### Community 4 - "sim/duel-sim.js"
Cohesion: 0.12
Nodes (29): applyConnect(), armorAbsorbs(), CONNECT, createDuel(), createEvent(), CUE, cue(), emit() (+21 more)

### Community 5 - "MatchFlow"
Cohesion: 0.09
Nodes (12): isKoReason(), MATCH_EVENT, MATCH_STATE, MatchFlow, ROUND_REASON, roundWinner(), ROUND_RULES, MatchFlow (+4 more)

### Community 6 - "bake.py"
Cohesion: 0.13
Nodes (12): bake(), bake_attribute(), bake_chain(), bake_curvature(), wire(), _bake_emit_with(), _bake_target_node(), _clear_bake_target() (+4 more)

### Community 7 - "CpuPilot"
Cohesion: 0.24
Nodes (6): bodyRadiusOf(), CpuPilot, keyMove(), moveReach(), pressMove(), spendable()

### Community 8 - "package.json"
Cohesion: 0.06
Nodes (32): author, description, devDependencies, three@0.187.0, engines, node, exports, ./ai (+24 more)

### Community 9 - "ref_node_assert"
Cohesion: 0.14
Nodes (4): Hitstop, FixedStepLoop, SIM_HZ, make()

### Community 10 - "dsp.mjs"
Cohesion: 0.11
Nodes (30): biquad(), bubbles(), contactPulse(), crackle(), dbToGain(), env(), fadeEdges(), fft() (+22 more)

### Community 11 - "sfx-schema.js"
Cohesion: 0.15
Nodes (20): buildSfxData(), BUSES, camel(), dbToGain(), FILTERS, fin(), ID_MAPS, ADR-0004 (+12 more)

### Community 12 - "steps"
Cohesion: 0.13
Nodes (14): jobs, test, name, on, pull_request, push, branches, tags (+6 more)

### Community 13 - "hazards.test.js"
Cohesion: 0.15
Nodes (12): HAZARD_PHASE, isHazardEvent(), KO_BY, ACT, arena(), PERIOD, PHASE, rulesetWith() (+4 more)

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
Nodes (7): KIT, OFFENSIVE, PASSIVE, RULESET, SET, SPEC_A, SPEC_B

### Community 18 - "hazards.js"
Cohesion: 0.07
Nodes (43): updateHurtbox(), buildOne(), camel(), CYCLE_KEYS, EFFECT_RULES, emitHazard(), fighterInZone(), ge0() (+35 more)

### Community 19 - "cpu-controller.js"
Cohesion: 0.12
Nodes (14): ActionMix, actionOf(), ACTIONS, AI_ROLE, CAN_SIDESTEP, clearSnapshot(), COUNTER_KEYS, CROUCH_KEYS (+6 more)

### Community 20 - "scene.py"
Cohesion: 0.20
Nodes (4): mirror_copy(), duplicate(), rng(), triangle_count()

### Community 21 - "smoke_plate.py"
Cohesion: 0.13
Nodes (12): chamfer_outline(), densify(), remesh(), row(), snap_to_surface(), activate(), apply_transform(), build() (+4 more)

### Community 22 - "sim/state-machine.js"
Cohesion: 0.14
Nodes (18): ACTIONABLE, advanceFighter(), beginMove(), bufferedMoveId(), canAfford(), canTransition(), chainAttack(), chainMoveId() (+10 more)

### Community 23 - "build.py"
Cohesion: 0.13
Nodes (10): build_one(), clean_dir(), discover(), load_config(), load_script(), main(), node(), node_exe() (+2 more)

### Community 24 - "createCameraDirector"
Cohesion: 0.16
Nodes (14): CAMERA_FEEL, clampPush(), createCameraDirector(), focus(), focusLevel(), impact(), impulse(), release() (+6 more)

### Community 25 - "armature.py"
Cohesion: 0.15
Nodes (11): bind_blend(), bind_rigid(), _ensure_modifier(), fighter_entry(), fix_weights(), _group(), joint_head(), joint_matrix() (+3 more)

### Community 26 - "scene.py"
Cohesion: 0.14
Nodes (11): save_png(), set_pixels(), mirror_half(), apply_modifiers(), delete(), build(), _cube(), _fill_base_color() (+3 more)

### Community 27 - "compress.mjs"
Cohesion: 0.20
Nodes (15): encodeTextures(), generatorString(), KTX2_PROFILES, loadEncoders(), main(), ADR-0003, profileFor(), quietly() (+7 more)

### Community 28 - "source-hash.test.js"
Cohesion: 0.11
Nodes (29): absPath(), ENCODER_PACKAGES, ENGINE_BLENDER_DIR, GLTF_TRANSFORM_VERSION, loadConfig(), LOGICAL_PREFIX, ADR-0004, pinnedBpyVersion() (+21 more)

### Community 29 - "FakeAudioContext"
Cohesion: 0.11
Nodes (4): FakeAudioContext, FakeNode, FakeParam, FakeSource

### Community 30 - "smoke_rig.py"
Cohesion: 0.22
Nodes (7): join(), _armour(), _ball(), build(), _flat_material(), _limb(), _mannequin()

### Community 31 - "state-machine.test.js"
Cohesion: 0.19
Nodes (12): connectResult(), updateHitbox(), attackPhase(), createCombatant(), MOVES, dist(), DT, duelAt() (+4 more)

### Community 32 - "stage-fixtures.js"
Cohesion: 0.21
Nodes (12): ADR-0003, loadStageAsset(), ADR-0003, load(), ARENA_CONTRACT, ARENA_MATS, fakeLoader(), fakeStageGltf() (+4 more)

### Community 33 - "scene-hooks.test.js"
Cohesion: 0.20
Nodes (9): FAKE_LOOK, fakeContainer(), fakeFighters(), fakeFighterView(), fakeRenderer(), fakeStage(), installFakeWindow(), build() (+1 more)

### Community 34 - "hazard-perception.test.js"
Cohesion: 0.15
Nodes (6): HAZARD_EVENT, PASSIVE, PHASE, RULESET, TEL, VENT

### Community 36 - "hardsurface.py"
Cohesion: 0.10
Nodes (17): assign_material_id(), _attr(), bezier_profile(), ensure_masks(), _faces_front(), fasteners(), mark_seam(), _mat_id() (+9 more)

### Community 37 - "three"
Cohesion: 0.24
Nodes (11): applyGrade(), createEnvScene(), createGradePass(), createHeroComposer(), disposeScene(), ENV_CACHE, getHeroEnvironment(), GRADE_DEFAULTS (+3 more)

### Community 38 - "vite-hero-assets.test.js"
Cohesion: 0.26
Nodes (8): fixture(), imagelessGlb(), addLiteSet(), escapeRe(), heroAssetFiles(), heroAssetsPlugin(), MIME, ADR-0004

### Community 39 - "createScene"
Cohesion: 0.18
Nodes (14): setShadowFlag(), disposeHeroEnvironment(), createRenderer(), createScene(), dispose(), onEvent(), pose(), prewarm() (+6 more)

### Community 40 - "run.mjs"
Cohesion: 0.15
Nodes (10): build, cmd, { configPath, setupOnly, rest }, env, [exe, ...args], ADR-0003, ADR-0004, python (+2 more)

### Community 41 - "acoustic-space.test.js"
Cohesion: 0.31
Nodes (8): createAcousticSpace(), createHarmonicLift(), createSend(), ADR-0005, lcg(), makeImpulseResponse(), makeTanhCurve(), ADR-0005

### Community 42 - "sim/index.js"
Cohesion: 0.19
Nodes (17): numberTable(), buildMeter(), buildRules(), METER_KEYS, RULE_KEYS, buildHazards(), buildRoundRules(), ROUND_KEYS (+9 more)

### Community 43 - "render-bank.mjs"
Cohesion: 0.20
Nodes (7): ADR-0005, aacEncoder(), encode(), ADR-0005, renderBank(), RENDERER_VERSION, renderVariant()

### Community 44 - "ref_node_path"
Cohesion: 0.27
Nodes (8): L, checkBundleSizes(), isMain, lazyPatterns(), listDistJs(), loadLimits(), ADR-0004, runBundleCheck()

### Community 45 - "sample-bank.test.js"
Cohesion: 0.15
Nodes (13): ADR-0005, BANK_LANE_PRIORITY, createSampleBank(), fetchVariant(), loadClip(), fin(), ADR-0005, parseBankManifest() (+5 more)

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
Cohesion: 0.25
Nodes (6): ALLOWED_BARE, GAME_LEXICON, ADR-0004, ROOT, SRC, walk()

### Community 50 - "frame-data.js"
Cohesion: 0.23
Nodes (9): ../fighters/duel-sim.js, frameAdvantage(), FrameDataTracker, isStun(), OUTCOME, moveTotal(), STATE, measure() (+1 more)

### Community 51 - "_set_axes"
Cohesion: 0.22
Nodes (5): build_armature(), _contract(), contract_manifest(), _heat_tails(), _set_axes()

### Community 52 - "scene.js"
Cohesion: 0.33
Nodes (8): three, configureShadowCaster(), createDefaultLightRig(), ADR-0001, SHADOW_DEFAULTS, SHADOW_TYPES, ADR-0001, ADR-0004

### Community 53 - "bind_world_three"
Cohesion: 0.33
Nodes (3): bind_world_three(), rest_offsets(), three_euler_matrix()

### Community 54 - "export.py"
Cohesion: 0.18
Nodes (5): export_glb(), _sort_faces(), _triangulate_all(), _gltf_output_group(), pbr_material()

### Community 55 - "setup.sh"
Cohesion: 0.83
Nodes (3): abs_path(), setup.sh script, verify()

### Community 56 - "sim/fighter.js"
Cohesion: 0.21
Nodes (10): createCylinder(), cylindersOverlap(), BUFFER, createCombatant(), createFighter(), cyl(), MOVEMENT_CONFIG, stepFighter() (+2 more)

### Community 57 - "keyReach"
Cohesion: 0.24
Nodes (4): bestPokeReach(), frameAdvantage(), keyReach(), SeededRng

### Community 58 - "brushed"
Cohesion: 0.20
Nodes (10): brushed(), depth(), _displace_along_normals(), edge_wear(), hammered(), depth(), feature(), _value_noise() (+2 more)

### Community 59 - "render/index.js"
Cohesion: 0.13
Nodes (9): accentPanel(), bakeStageEnvironment(), ADR-0001, ADR-0003, ADR-0001, ENV_PANELS, createSkinnedBuilder(), ADR-0001 (+1 more)

### Community 60 - "createDownloadLane"
Cohesion: 0.21
Nodes (8): createDownloadLane(), insert(), preemptCurrent(), remove(), work(), enc(), store(), stageManifestJson()

### Community 61 - "sim/moves.js"
Cohesion: 0.25
Nodes (12): deepFreeze(), AI_ROLES, ARMOR_LEVELS, buildMoves(), chainLength(), GUARD_TABLE, MOVE_FIELDS, MOVE_INPUTS (+4 more)

### Community 62 - "perception.js"
Cohesion: 0.23
Nodes (7): createHazardObservation(), createObservation(), DelayedView, observe(), observeHazards(), ../fighters/moves.js, hazardTimeToActive()

### Community 63 - "stage-asset-store.js"
Cohesion: 0.29
Nodes (10): createInlineSource(), heroFileForTier(), createStageAssetStore(), enqueue(), load(), STAGE_LANE_PRIORITY, ADR-0003, stageChoice() (+2 more)

### Community 64 - "gltf-loader-stack.js"
Cohesion: 0.20
Nodes (4): createGltfLoader, ADR-0003, createTranscoderWarm(), TRANSCODER_FILES

### Community 65 - "storage.test.js"
Cohesion: 0.24
Nodes (4): createSettingsStorage(), createSave(), ADR-0004, loadSave()

### Community 67 - "hero-asset-store.js"
Cohesion: 0.22
Nodes (8): fetchBytesWithProgress(), HERO_LANE_PRIORITY, HERO_LOAD, ADR-0003, HERO_MANIFEST_SCHEMA, isNum(), ADR-0003, parseHeroManifest()

### Community 68 - "createHeroAssetStore"
Cohesion: 0.46
Nodes (8): createHeroAssetStore(), enqueue(), ensureStack(), load(), loadOne(), manifest(), releaseStackIfIdle(), schedule()

### Community 69 - "computeFraming"
Cohesion: 0.60
Nodes (3): computeFraming(), FRAMING_CONFIG, frame()

### Community 70 - "sharp"
Cohesion: 0.67
Nodes (3): duel(), passive(), sharp()

## Knowledge Gaps
- **59 isolated node(s):** `ADR-0003`, `ADR-0005`, `ADR-0003`, `ADR-0005`, `ADR-0005` (+54 more)
  These have ≤1 connection - possible missing edges. (Counts symbols only; 458 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **3 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `three` connect `scene.js` to `gltf-loader-stack.js`, `hero-asset.test.js`, `scene-hooks.test.js`, `hero-asset-store.js`, `stage-fixtures.js`, `three`, `package.json`, `rig-contract.test.js`, `geo.js`, `render/index.js`, `stage-asset-store.js`?**
  _High betweenness centrality (0.067) - this node is a cross-community bridge._
- **What connects `ADR-0003`, `ADR-0005`, `ADR-0003` to the rest of the system?**
  _59 weakly-connected nodes found - possible missing edges._
- **Should `ref_node_assert` be split into smaller, more focused modules?**
  _Cohesion score 0.0782312925170068 - nodes in this community are weakly interconnected._
- **Why does `FakeAudioContext` connect `FakeAudioContext` to `node-pool.test.js`, `acoustic-space.test.js`, `sample-bank.test.js`, `haptics.test.js`?**
  _High betweenness centrality (0.033) - this node is a cross-community bridge._
- **Should `ai-support.test.js` be split into smaller, more focused modules?**
  _Cohesion score 0.11587301587301588 - nodes in this community are weakly interconnected._
- **Why does `STATE` connect `frame-data.js` to `hazard-perception.test.js`, `sim/duel-sim.js`, `hazards.test.js`, `hazards.js`, `cpu-controller.js`, `sim/state-machine.js`, `state-machine.test.js`?**
  _High betweenness centrality (0.025) - this node is a cross-community bridge._
- **Should `sim/duel-sim.js` be split into smaller, more focused modules?**
  _Cohesion score 0.11742424242424243 - nodes in this community are weakly interconnected._
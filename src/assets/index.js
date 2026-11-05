// @sarkhanrasullu/game-engine/assets (peer: three 0.187.x): runtime glTF asset pipeline — manifest
// readers (hero and stage), the skinned hero asset loader (bind-space LODs over the createRig joints),
// the stage asset core (injected node pattern and material contract) and the never-rejecting session
// stores. The meshopt + KTX2 loader stack is NOT re-exported here: import it lazily from
// `@sarkhanrasullu/game-engine/assets/gltf-loader` so it stays its own chunk.
export * from './download-lane.js';
export * from './transcoder-warm.js';
export * from './manifest.js';
export * from './stage-manifest.js';
export * from './hero-asset.js';
export * from './hero-asset-store.js';
export * from './stage-asset.js';
export * from './stage-asset-store.js';

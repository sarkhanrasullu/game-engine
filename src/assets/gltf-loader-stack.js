// The glTF loader stack for runtime heroes (ADR-0003 §Pipeline 2, story PRO-2), in its own module so
// Vite splits it into a lazy chunk (the title/select screen does not wait for it). Decoders are local:
// the meshopt decoder ships inside its module (embedded wasm); the basis transcoder (js + wasm) is
// served from `transcoderPath` next to index.html (tools/vite-hero-assets.mjs copies it from
// node_modules/three/examples/jsm/libs/basis) or from blob: URLs in the single-file artifact.
// Verified against node_modules/three (r187): KTX2Loader(manager).setTranscoderPath (L191),
// .detectSupport(renderer) (L239, reads renderer.extensions), .dispose(); GLTFLoader(manager)
// .setKTX2Loader (L372) / .setMeshoptDecoder (L386) / .parseAsync (L573); MeshoptDecoder (libs).
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

/**
 * Create a GLTFLoader that reads meshopt geometry and KTX2 (BasisU) maps.
 * @param {{renderer: import('three').WebGLRenderer, transcoderPath: string, manager?: import('three').LoadingManager, workerLimit?: number}} opts
 * @returns {{loader: GLTFLoader, dispose: () => void}}
 * @example const { loader, dispose } = createHeroGltfLoader({ renderer, transcoderPath: 'basis/' });
 *   const gltf = await loader.parseAsync(bytes, ''); dispose();
 */
export function createHeroGltfLoader({ renderer, transcoderPath, manager, workerLimit = 2 }) {
  const ktx2 = new KTX2Loader(manager).setTranscoderPath(transcoderPath).setWorkerLimit(workerLimit).detectSupport(renderer);
  const loader = new GLTFLoader(manager).setKTX2Loader(ktx2).setMeshoptDecoder(MeshoptDecoder);
  return { loader, dispose: () => ktx2.dispose() };
}

/**
 * Generic alias of createHeroGltfLoader: the same stack serves stages and any other meshopt + KTX2 glTF.
 * Load this module lazily through the `./assets/gltf-loader` subpath so it stays its own chunk.
 * @example const { loader, dispose } = createGltfLoader({ renderer, transcoderPath: 'basis/' }); // from the lazy subpath module
 */
export const createGltfLoader = createHeroGltfLoader;

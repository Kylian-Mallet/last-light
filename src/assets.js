import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

// Character models ship compressed (Draco geometry, WebP textures; built from the original
// exports in assets/models/ by `pnpm models`), so every load goes through one glTF loader
// that can decode Draco.

/** URL of a model file by name (e.g. 'penguin.glb'). */
export function modelUrl(name) { return 'models/' + name; }

let loader = null;

/** One shared glTF loader, able to read Draco geometry. */
export function gltfLoader() {
  if (loader) return loader;
  // three's own Draco decoder, bundled (and hashed) by Vite from three/examples/jsm/libs
  const draco = new DRACOLoader().setDecoderConfig({ type: 'wasm' });
  loader = new GLTFLoader();
  loader.setDRACOLoader(draco);
  return loader;
}

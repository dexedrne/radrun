// Draco decoding without gstatic. react-three-game points its Draco loader at gstatic's unversioned decoder
// ("https://www.gstatic.com/draco/v1/decoders/"), and that decoder changed under three's loader: its new wrapper ignores
// the wasm binary three hands it and fetches "draco_decoder.wasm" itself, which cannot resolve inside the decoder's blob
// worker ("Failed to parse URL from draco_decoder.wasm" ... "Aborted"), so every Radbro, George and the clip packs failed
// to load ("failed to load /models/radbro652.glb"; Chromium 153, 2026-10-17). Every Draco loader now uses three's own
// glTF decoder, which the build ships next to the code (DRACO_GLTF_CONFIG: Vite emits its two files into assets/), so the
// game no longer depends on that URL. Imported first by main.tsx (before react-three-game makes its loader); the
// _initDecoder guard catches a loader made earlier anyway.
import { DRACOLoader, DRACO_GLTF_CONFIG } from "three/examples/jsm/loaders/DRACOLoader.js";

const GSTATIC = /^https?:\/\/www\.gstatic\.com\/draco\//;
type Paths = { decoderPaths: { js: string; wasm: string; dep_js: string | null } };
const proto = DRACOLoader.prototype as unknown as { setDecoderPath(p: string | { js: string; wasm: string }): DRACOLoader; _initDecoder(): Promise<unknown> };

const setPath = proto.setDecoderPath;
proto.setDecoderPath = function (this: DRACOLoader, p) {
  return setPath.call(this, typeof p === "string" && GSTATIC.test(p) ? DRACO_GLTF_CONFIG : p);
};
const init = proto._initDecoder;
proto._initDecoder = function (this: DRACOLoader & Paths) {
  if (GSTATIC.test(this.decoderPaths.js)) setPath.call(this, DRACO_GLTF_CONFIG);
  return init.call(this);
};

export const DRACO_SHIPPED = DRACO_GLTF_CONFIG;

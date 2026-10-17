// Draco decoding without gstatic (src/app/draco.ts): every loader uses three's own glTF decoder, shipped in the build.
import { test } from "node:test";
import assert from "node:assert/strict";

test("Draco: a gstatic decoder path becomes three's own shipped glTF decoder; other paths are left alone", async () => {
  await import("../src/app/draco.ts");
  const { DRACOLoader, DRACO_GLTF_CONFIG } = await import("three/examples/jsm/loaders/DRACOLoader.js");
  const l = new DRACOLoader().setDecoderPath("https://www.gstatic.com/draco/v1/decoders/") as unknown as { decoderPaths: { js: string; wasm: string; dep_js: string | null } };
  assert.equal(l.decoderPaths.js, DRACO_GLTF_CONFIG.js);
  assert.equal(l.decoderPaths.wasm, DRACO_GLTF_CONFIG.wasm);
  assert.match(l.decoderPaths.wasm, /libs\/draco\/gltf\/draco_decoder\.wasm$/);
  const own = new DRACOLoader().setDecoderPath("/my/decoders/") as unknown as { decoderPaths: { js: string } };
  assert.equal(own.decoderPaths.js, "/my/decoders/draco_wasm_wrapper.js");
});

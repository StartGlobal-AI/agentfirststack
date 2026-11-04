// The bundled browser runtimes (dist/runtime.txt and dist/runtime-ext.txt, built by
// scripts/build-runtime.mjs via wrangler's build.command and imported as Text modules).
import RUNTIME from "../dist/runtime.txt";
import RUNTIME_EXT from "../dist/runtime-ext.txt";

export { RUNTIME_EXT };
export default RUNTIME;

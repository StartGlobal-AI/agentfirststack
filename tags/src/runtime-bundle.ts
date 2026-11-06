// The bundled browser scripts (dist/runtime.txt, dist/runtime-ext.txt and the consent banner UI
// dist/consent-ui.txt, built by scripts/build-runtime.mjs via wrangler's build.command and
// imported as Text modules).
import RUNTIME from "../dist/runtime.txt";
import RUNTIME_EXT from "../dist/runtime-ext.txt";
import CONSENT_UI from "../dist/consent-ui.txt";

export { CONSENT_UI, RUNTIME_EXT };
export default RUNTIME;

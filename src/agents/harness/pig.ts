/**
 * harness/pig.ts — the pig harness: a pi-compatible binary behind the pane's
 * `pi`.
 *
 * pig is a drop-in reimplementation of pi (https://github.com/MichaelKinsy/PiG),
 * so it takes pi's `[harness]` section and argv unchanged. Only its binary name
 * differs from pi, which the pi-compatible factory reconciles by pointing the
 * pane's `pi` at `pig`.
 */

import { createPiCompatibleHarness } from "./pi-compatible.js";

export const pigHarness = createPiCompatibleHarness({
  id: "pig",
  binary: "pig",
  signature: "PIG_LAUNCHER_8f9a2b",
  readyMarker: "PIG_VERIFIED",
});

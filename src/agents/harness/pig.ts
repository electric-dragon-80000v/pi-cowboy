/**
 * harness/pig.ts — the pig harness: a pi-compatible binary behind the pane's
 * `pi`.
 *
 * pig is a drop-in reimplementation of pi (https://github.com/MichaelKinsy/PiG),
 * so it takes pi's `[harness]` and `[harness.pi]` sections and argv unchanged.
 * Only its binary name and its session store differ from pi, which the
 * pi-compatible factory reconciles by pointing the pane's `pi` at `pig` and by
 * attaching the handover export its store answers (see pig-store.ts).
 */

import { createPiCompatibleHarness } from "./pi-compatible.js";
import { pigStore } from "./pig-store.js";

export const pigHarness = createPiCompatibleHarness({
  binary: "pig",
  signature: "PIG_LAUNCHER_8f9a2b",
  readyMarker: "PIG_VERIFIED",
  store: pigStore,
});

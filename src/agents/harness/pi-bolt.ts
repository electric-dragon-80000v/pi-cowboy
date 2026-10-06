/**
 * harness/pi-bolt.ts — the pi-bolt harness: a pi-compatible binary behind the
 * pane's `pi`.
 *
 * Like pig, pi-bolt takes pi's `[harness]` section and argv unchanged; only its
 * binary name differs from pi, which the pi-compatible factory reconciles by
 * pointing the pane's `pi` at `pi-bolt`.
 */

import { createPiCompatibleHarness } from "./pi-compatible.js";

export const piBoltHarness = createPiCompatibleHarness({
  id: "pi-bolt",
  binary: "pi-bolt",
  signature: "PI_BOLT_LAUNCHER_5e1c7a",
  readyMarker: "PI_BOLT_VERIFIED",
});

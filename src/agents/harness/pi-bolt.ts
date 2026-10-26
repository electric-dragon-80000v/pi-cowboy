/**
 * harness/pi-bolt.ts — the pi-bolt harness: a pi-compatible binary behind the
 * pane's `pi`.
 *
 * Like pig, pi-bolt takes pi's `[harness]` and `[harness.pi]` sections and argv
 * unchanged; only its binary name differs from pi, which the pi-compatible
 * factory reconciles by pointing the pane's `pi` at `pi-bolt`. Its sessions are
 * pi's as well — same root, same overrides — so it runs pi's store, not one of
 * its own.
 */

import { createPiCompatibleHarness } from "./pi-compatible.js";
import { piStore } from "./pi-store.js";

export const piBoltHarness = createPiCompatibleHarness({
  binary: "pi-bolt",
  signature: "PI_BOLT_LAUNCHER_5e1c7a",
  readyMarker: "PI_BOLT_VERIFIED",
  store: piStore,
});

/**
 * harness/registry.ts — the one module that knows every harness.
 *
 * It owns the id → implementation lookup, so a caller that holds a
 * `harness_type` resolves it to the harness that launches it.
 */

import type { Harness, HarnessId } from "../harness.js";
import { buildPiLaunchArgs } from "./pi-compatible.js";
import { pigHarness } from "./pig.js";
import { piBoltHarness } from "./pi-bolt.js";

/**
 * Real pi is already the pane shell's `pi`: it is always launchable, and there
 * is nothing to prepare or tear down. Its argv is the family's shared
 * assembly — pi is the family's namesake.
 */
const piHarness: Harness = {
  id: "pi",
  available: () => true,
  prepare: async () => {},
  buildArgs: buildPiLaunchArgs,
  teardown: async () => {},
};

/** Keyed by id, so a harness added to `HARNESS_IDS` without an implementation fails to compile. */
const HARNESSES: Record<HarnessId, Harness> = {
  pi: piHarness,
  pig: pigHarness,
  "pi-bolt": piBoltHarness,
};

/** The implementation for one harness id. */
export function harnessFor(id: HarnessId): Harness {
  return HARNESSES[id];
}

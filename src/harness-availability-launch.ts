/**
 * harness-availability-launch.ts — ask PATH, once at launch, which harnesses this
 * machine can launch, and let the shell answer for every later reader; then
 * warm the slow model lists through each harness's own hook.
 *
 * The scan is synchronous, so the answer is in the shell before the first menu can
 * open and there is no claim to defend: unlike the volume probe, this verdict
 * cannot land out of order. Warming is fire-and-forget for the same reason a
 * probe is never awaited: a launch must not block on a CLI. Where a warmed
 * fetch lives is each harness's own business — this module names no harness
 * beyond iterating the runnable ones, and holds no model state itself.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  HARNESS_IDS,
  runnableHarnessIds,
  type HarnessId,
} from "./agents/harness.js";
import { harnessFor } from "./agents/harness/registry.js";
import { probed, type Availability } from "./availability.js";
import { getHarnessAvailability, setHarnessAvailability } from "./shell.js";

/**
 * What this machine can launch: each id its own harness reports as launchable.
 * Iterating the vocabulary, not a hand-written list, so a harness added to
 * `HARNESS_IDS` is judged by the same rule rather than silently dropped.
 */
export function detectHarnessAvailability(): Availability<HarnessId> {
  return probed(HARNESS_IDS.filter((id) => harnessFor(id).available()));
}

export function startHarnessAvailabilityProbe(): void {
  setHarnessAvailability(detectHarnessAvailability());
}

/**
 * Warm every runnable harness's slow model list, without naming any harness.
 * A harness without an expensive list no-ops its hook; a harness with one
 * memoizes the fetch every later `listModels` joins.
 */
export function prefetchHarnessModels(pi: ExtensionAPI): void {
  const availability = getHarnessAvailability();
  for (const id of runnableHarnessIds(availability)) {
    harnessFor(id).prefetchModels(pi);
  }
}

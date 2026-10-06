/**
 * harness-availability-launch.ts — ask PATH, once at launch, which harnesses this
 * machine can launch, and let the shell answer for every later reader.
 *
 * The scan is synchronous, so the answer is in the shell before the first menu can
 * open and there is no claim to defend: unlike the volume probe, this verdict
 * cannot land out of order.
 */

import { HARNESS_IDS, type HarnessId } from "./agents/harness.js";
import { harnessFor } from "./agents/harness/registry.js";
import { probed, type Availability } from "./availability.js";
import { setHarnessAvailability } from "./shell.js";

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

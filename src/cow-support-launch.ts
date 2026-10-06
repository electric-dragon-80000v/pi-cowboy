/**
 * cow-support-launch.ts — ask the worktree volume, once per session, which
 * materializations it can honor, and let the shell answer for every later reader.
 *
 * Kicked off at launch and never awaited: a spawn that arrives before the probe
 * lands resolves the way it always did, and the setting narrows itself once the
 * answer is in. Never awaited because a probe shells out and a launch must not
 * block on it; each probe carries a claim, so a slow one cannot overwrite the
 * answer of a newer probe about a different volume.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ExecLike } from "./infrastructure/git/cow-clone.js";
import { detectCowAvailability, probeTargetFor } from "./spawn/cow-support.js";
import { probed, unprobed } from "./availability.js";
import {
  beginCowAvailabilityProbe,
  getStore,
  setCowAvailability,
  type CowAvailabilityClaim,
} from "./shell.js";

/** `pi.exec` as the cloner's seam: the same one place shells out of the extension. */
function execOf(pi: ExtensionAPI): ExecLike {
  return (command, args, options) => pi.exec(command, args, options);
}

export function startCowSupportProbe(pi: ExtensionAPI): void {
  probe(pi, beginCowAvailabilityProbe());
}

/**
 * Ask again, because the worktree root can move to another volume. The answer
 * goes back to unknown first so no reader sees the previous volume's verdict
 * while the new probe runs.
 */
export function refreshCowSupportProbe(pi: ExtensionAPI): void {
  const claim = beginCowAvailabilityProbe();
  setCowAvailability(claim, unprobed());
  probe(pi, claim);
}

/**
 * Run one probe and record its verdict under the claim it was opened with. An
 * older probe that answers later describes a volume nobody asked about any
 * more, so its claim is stale and the shell discards the verdict.
 */
function probe(pi: ExtensionAPI, claim: CowAvailabilityClaim): void {
  const target = probeTargetFor(getStore().agent.worktreeRoot);
  void detectCowAvailability(execOf(pi), target).then(
    (availability) => {
      setCowAvailability(claim, availability);
    },
    () => {
      setCowAvailability(claim, probed(["checkout"]));
    },
  );
}

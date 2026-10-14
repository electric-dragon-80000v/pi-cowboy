/**
 * harness-availability-launch.ts — ask each harness what this machine can do
 * with it, once at launch, and let the shell answer for every later reader;
 * then warm the slow model lists through each harness's own hook.
 *
 * The scan is synchronous, so the answer is in the shell before the first menu can
 * open and there is no claim to defend: unlike the volume probe, this verdict
 * cannot land out of order. Warming is fire-and-forget for the same reason a
 * probe is never awaited: a launch must not block on a CLI. Where a warmed
 * fetch lives is each harness's own business — this module names no harness
 * beyond iterating the runnable ones, and holds no model state itself.
 *
 * A harness whose binary is installed but cannot be launched answers with a line
 * for the human. That line is shown once the UI exists, so the pass over the
 * vocabulary happens here — once — and its notices are carried to the session
 * that can display them.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  HARNESS_IDS,
  runnableHarnessIds,
  type HarnessId,
} from "./agents/harness.js";
import { harnessFor } from "./agents/harness/registry.js";
import { probed, type Availability } from "./availability.js";
import { getHarnessAvailability, setHarnessAvailability } from "./shell.js";

/** One pass over the vocabulary: the verdicts, and the lines those verdicts carry. */
export interface HarnessProbe {
  readonly availability: Availability<HarnessId>;
  readonly notices: readonly string[];
}

/**
 * What this machine can do with each harness, in the vocabulary's own order. One
 * question per harness, so a verdict and the line explaining it can never come
 * from two different reads of the same binary.
 */
export function probeHarnessAvailability(): HarnessProbe {
  const available: HarnessId[] = [];
  const notices: string[] = [];
  for (const id of HARNESS_IDS) {
    const answer = harnessFor(id).availability();
    if (answer.status === "available") available.push(id);
    else if (answer.notice !== undefined) notices.push(answer.notice);
  }
  return { availability: probed(available), notices };
}

/** Record the probe's answer for every later reader, and queue what it has to say. */
export function startHarnessAvailabilityProbe(pi: ExtensionAPI): void {
  const { availability, notices } = probeHarnessAvailability();
  setHarnessAvailability(availability);
  reportNotices(pi, notices);
}

/**
 * Show each line once the UI exists. The entry point has no context, so the
 * session event is the first moment there is somewhere to put it; a run without
 * a UI has nowhere to show a notice and drops it.
 */
function reportNotices(pi: ExtensionAPI, notices: readonly string[]): void {
  if (notices.length === 0) return;
  pi.on("session_start", (_event: unknown, ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    for (const notice of notices) ctx.ui.notify(notice, "warning");
  });
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

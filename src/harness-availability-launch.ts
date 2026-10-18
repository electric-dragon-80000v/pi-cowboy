/**
 * harness-availability-launch.ts — ask each harness what this machine can do
 * with it, once per session once plugins have registered, and let the shell
 * answer for every later reader; then warm the slow model lists through each
 * harness's own hook.
 *
 * The scan is synchronous, so the answer is in the shell before the first menu can
 * open and there is no claim to defend: unlike the volume probe, this verdict
 * cannot land out of order. Warming is fire-and-forget for the same reason a
 * probe is never awaited: a launch must not block on a CLI. Where a warmed
 * fetch lives is each harness's own business — this module names no harness
 * beyond iterating the registered ones, and holds no model state itself.
 *
 * A harness whose binary is installed but cannot be launched answers with a line
 * for the human. That line is returned to the caller, which alone holds the
 * session's UI to show it on — a run without a UI has nowhere to put it and
 * drops it.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  harnessFor,
  harnessIds,
  runnableHarnessIds,
} from "./agents/harness/registry.js";
import type { AnyHarnessId, HarnessAvailability } from "./agents/harness.js";
import { probed, type Availability } from "./availability.js";
import { getHarnessAvailability, setHarnessAvailability } from "./shell.js";
import { errorMessage } from "./utils.js";

/** One pass over the vocabulary: the verdicts, and the lines those verdicts carry. */
export interface HarnessProbe {
  readonly availability: Availability<AnyHarnessId>;
  readonly notices: readonly string[];
}

/**
 * What this machine can do with each harness, in the registry's own order. One
 * question per harness, so a verdict and the line explaining it can never come
 * from two different reads of the same binary. Read after plugins register, so a
 * plugin harness is probed like a built-in.
 */
export function probeHarnessAvailability(): HarnessProbe {
  const available: AnyHarnessId[] = [];
  const notices: string[] = [];
  for (const id of harnessIds()) {
    const answer = askAvailability(id);
    if (answer.status === "available") available.push(id);
    else if (answer.notice !== undefined) notices.push(answer.notice);
  }
  return { availability: probed(available), notices };
}

/**
 * One harness's verdict. A hook that throws is a verdict too — the harness
 * cannot be offered here — so it is answered as unavailable with a line naming
 * the harness. A plugin that throws in `availability` therefore costs only its
 * own harness, never the session.
 */
function askAvailability(id: AnyHarnessId): HarnessAvailability {
  try {
    return harnessFor(id).availability();
  } catch (error) {
    return {
      status: "unavailable",
      notice: `[cowboy] the "${id}" harness could not answer for itself and is not offered: ${errorMessage(error)}`,
    };
  }
}

/**
 * Probe and record the answer for every later reader, returning the probe so
 * the caller — which alone has a UI to show them on — can carry the notices.
 * Called once per session, after plugins have registered their harnesses.
 */
export function startHarnessAvailabilityProbe(): HarnessProbe {
  const probe = probeHarnessAvailability();
  setHarnessAvailability(probe.availability);
  return probe;
}

/**
 * Warm every runnable harness's slow model list, without naming any harness.
 * A harness without an expensive list no-ops its hook; a harness with one
 * memoizes the fetch every later `listModels` joins. A hook that throws is a
 * cold list, not a broken session: warming is an optimization, so the throw is
 * swallowed and every other harness still warms.
 */
export function prefetchHarnessModels(pi: ExtensionAPI): void {
  const availability = getHarnessAvailability();
  for (const id of runnableHarnessIds(availability)) {
    try {
      harnessFor(id).prefetchModels(pi);
    } catch {
      // Cold, not fatal — see above.
    }
  }
}

/**
 * agent-environment.ts — transitions for one spawn's execution placement and
 * run history.
 */

import type { AgentExecutionState, EndedRun } from "../types.js";
import type { AgentHostRef } from "./agent-host.js";
import type { AnyHarnessId } from "./harness.js";

/** Record the pane a launch adopted or created. */
export function placeExecution(
  execution: AgentExecutionState,
  host: AgentHostRef,
): void {
  execution.host = host;
}

/** Record the harness engaging the placed pane. */
export function engageExecution(
  execution: AgentExecutionState,
  harness: AnyHarnessId,
): void {
  execution.harness = harness;
}

/** Archive an ended run and release its placement and harness. */
export function endExecutionRun(
  execution: AgentExecutionState,
  run: EndedRun,
): void {
  execution.history.push(run);
  execution.host = undefined;
  execution.harness = undefined;
}

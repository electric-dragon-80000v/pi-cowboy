/**
 * agent-environment.ts — the container in which one spawn's runs execute.
 * AgentEnvironment: the placement, the run occupying it, the runs that ended
 * before it, and the two writes a launch makes.
 * environmentOf: the only reader of AgentExecutionState's placement fields.
 * Higher layers address this container: a handover replaces the run
 * inside an environment, so callers ask the environment which harness is
 * active instead of tracking one directly.
 */

import type { AgentExecutionState, EndedRun } from "../types.js";
import type { AgentHostRef } from "./agent-host.js";
import type { AnyHarnessId } from "./harness.js";

/**
 * The environment: the pane that a spawn's runs occupy in turn, the currently
 * active run, and the runs that ended before it. `host` outlives `harness` — a
 * placement exists from the moment a launch (or the spawn wizard) makes one,
 * while a harness engages it only when a run prepares it.
 */
export interface AgentEnvironment {
  /** The pane the environment occupies now; absent before a launch places one. */
  readonly host: AgentHostRef | undefined;
  /** The harness occupying that pane; absent until a run engages it. */
  readonly harness: AnyHarnessId | undefined;
  /** Every run the environment hosted before the active one, oldest first. */
  readonly ended: readonly EndedRun[];
  /** Record the pane a launch adopted or created. */
  place(host: AgentHostRef): void;
  /** Record the harness engaging the placed pane. */
  engage(harness: AnyHarnessId): void;
}

/** Read a spawn's execution state as an environment. */
export function environmentOf(
  execution: AgentExecutionState,
): AgentEnvironment {
  return {
    host: execution.host,
    harness: execution.harness,
    ended: execution.history,
    place: (host) => {
      execution.host = host;
    },
    engage: (harness) => {
      execution.harness = harness;
    },
  };
}

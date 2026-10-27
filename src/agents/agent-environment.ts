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
import type { AnyHarnessId, RunSessionIdentity } from "./harness.js";

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
  /**
   * The session the active run is in, as that run's harness identified it: the
   * id to read or resume it by, or the statement that no id was learned.
   */
  readonly session: RunSessionIdentity;
  /** Every run the environment hosted before the active one, oldest first. */
  readonly ended: readonly EndedRun[];
  /** Record the pane a launch adopted or created. */
  place(host: AgentHostRef): void;
  /** Record the harness engaging the placed pane. */
  engage(harness: AnyHarnessId): void;
  /**
   * Archive the active run into the history and give up the placement, the
   * harness, and the session that harness identified: a handover ends one run
   * before the next engages an address of its own. The environment addresses
   * nothing, and identifies no session, until that run places one.
   */
  end(run: EndedRun): void;
}

/** Read a spawn's execution state as an environment. */
export function environmentOf(
  execution: AgentExecutionState,
): AgentEnvironment {
  return {
    host: execution.host,
    harness: execution.harness,
    session: execution.session,
    ended: execution.history,
    place: (host) => {
      execution.host = host;
    },
    engage: (harness) => {
      execution.harness = harness;
    },
    end: (run) => {
      execution.history.push(run);
      execution.host = undefined;
      execution.harness = undefined;
      execution.session = { kind: "unidentified" };
    },
  };
}

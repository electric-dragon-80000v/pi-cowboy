/**
 * run-state.ts — One subagent run's state, and the spawn projections derived from it.
 *
 * The value holds two statuses with plain names. `process` is how far the
 * subagent run itself got; `shell` is what the parent session still does for
 * it. A run that has taken its terminal outcome carries it in `terminal`
 * (the settlement: completed, stopped, or failed). Timestamps ride in as
 * arguments, so this module does no I/O.
 */

import type {
  AgentLaunchState,
  AgentLifecycleState,
  StopInitiator,
  WorktreeRetentionReason,
} from "../types.js";

/** The settled arm's shape: a started run, whatever ended it. */
type SettledLifecycleState = Extract<AgentLifecycleState, { phase: "settled" }>;

/** The never-started arm's shape: a run that ended without ever launching. */
type NeverStartedLifecycleState = Extract<
  AgentLifecycleState,
  { phase: "never-started" }
>;

/** Exact projection for a queued session forgotten during parent disposal. */
export const DISPOSE_QUEUED_MESSAGE =
  "Agent manager disposed before the queued agent could start.";

/** How a run ended: a report, an explicit stop, or a launch/start failure. */
type RunTerminal =
  | { kind: "completed"; result: string }
  | { kind: "stopped"; initiator: StopInitiator }
  | { kind: "failed"; error: string };

/** Terminals reachable without the run ever starting: no report can exist. */
type RunNeverStartedTerminal =
  | { kind: "stopped"; initiator: StopInitiator }
  | { kind: "failed"; error: string };

/** How far the subagent run itself got. */
type ProcessStatus =
  | { kind: "queued"; queuedAt: number }
  | { kind: "launching"; queuedAt: number; startedAt: number }
  | { kind: "active"; queuedAt: number; startedAt: number }
  | {
      kind: "settling";
      queuedAt: number;
      startedAt: number;
      terminal: RunTerminal;
      completedAt: number;
    }
  | {
      kind: "settled";
      queuedAt: number;
      started: false;
      terminal: RunNeverStartedTerminal;
      completedAt: number;
    }
  | {
      kind: "settled";
      queuedAt: number;
      startedAt: number;
      started: true;
      terminal: RunTerminal;
      completedAt: number;
    };

/** Process statuses with a live process behind them. */
type LiveProcessStatus = Extract<
  ProcessStatus,
  { kind: "launching" | "active" }
>;

/**
 * What the parent session still does for the run. `held` is normal tracking
 * next to any process. `disposed` is a discarded parent (gate opened, poll
 * abandoned, pane left alive) next to a still-live process only. `dropped`
 * is a discarded session holding the frozen lifecycle, so dropping never
 * rewrites it — a drop mid-settle cannot move a settled lifecycle backwards.
 */
export type RunState =
  | { process: ProcessStatus; shell: "held" }
  | { process: LiveProcessStatus; shell: "disposed" }
  | { shell: "dropped"; lifecycle: AgentLifecycleState };

/** A no-op transition returns its input, so callers can tell it did nothing. */
function unchanged(state: RunState): RunState {
  return state;
}

/** The initial state for a spawn queued at the given time. */
export function createRun(queuedAt: number): RunState {
  return {
    process: { kind: "queued", queuedAt },
    shell: "held",
  };
}

/** queued -> launching. Anything else is already underway or over. */
export function startRun(state: RunState, startedAt: number): RunState {
  if (state.shell !== "held" || state.process.kind !== "queued")
    return unchanged(state);
  return {
    process: {
      kind: "launching",
      queuedAt: state.process.queuedAt,
      startedAt,
    },
    shell: state.shell,
  };
}

/**
 * launching -> active. A disposal in flight stays a disposal: the process
 * moves but the gate stays open and the poll stays abandoned.
 */
export function activateRun(state: RunState): RunState {
  if (state.shell === "dropped") return unchanged(state);
  if (state.process.kind !== "launching") return unchanged(state);
  return {
    process: {
      kind: "active",
      queuedAt: state.process.queuedAt,
      startedAt: state.process.startedAt,
    },
    shell: state.shell,
  };
}

/** queued -> settled stopped, never started: the queue entry is cancelled. */
export function abortQueuedRun(
  state: RunState,
  initiator: StopInitiator,
  completedAt: number,
): RunState {
  if (state.shell !== "held" || state.process.kind !== "queued")
    return unchanged(state);
  return {
    process: {
      kind: "settled",
      queuedAt: state.process.queuedAt,
      started: false,
      terminal: { kind: "stopped", initiator },
      completedAt,
    },
    shell: state.shell,
  };
}

/**
 * A start that never became a run. Queued stays never-started; launching keeps
 * its start time, since the slot was taken and the launch was attempted.
 */
export function failStart(
  state: RunState,
  error: string,
  completedAt: number,
): RunState {
  if (state.shell !== "held") return unchanged(state);
  if (state.process.kind === "queued")
    return {
      process: {
        kind: "settled",
        queuedAt: state.process.queuedAt,
        started: false,
        terminal: { kind: "failed", error },
        completedAt,
      },
      shell: state.shell,
    };
  if (state.process.kind === "launching")
    return {
      process: {
        kind: "settled",
        queuedAt: state.process.queuedAt,
        startedAt: state.process.startedAt,
        started: true,
        terminal: { kind: "failed", error },
        completedAt,
      },
      shell: state.shell,
    };
  return unchanged(state);
}

/**
 * A live process takes its terminal and enters the settle pass. The outcome
 * ends a disposal: shell returns to held so the settlement reports normally.
 */
export function enterSettling(
  state: RunState,
  terminal: RunTerminal,
  completedAt: number,
): RunState {
  if (state.shell === "dropped") return unchanged(state);
  if (state.process.kind !== "launching" && state.process.kind !== "active")
    return unchanged(state);
  return {
    process: {
      kind: "settling",
      queuedAt: state.process.queuedAt,
      startedAt: state.process.startedAt,
      terminal,
      completedAt,
    },
    shell: "held",
  };
}

/** The settle pass ran its effects; the terminal it carried is the outcome. */
export function finishSettling(state: RunState): RunState {
  if (state.shell !== "held" || state.process.kind !== "settling")
    return unchanged(state);
  return {
    process: {
      kind: "settled",
      queuedAt: state.process.queuedAt,
      startedAt: state.process.startedAt,
      started: true,
      terminal: state.process.terminal,
      completedAt: state.process.completedAt,
    },
    shell: state.shell,
  };
}

/**
 * A delivered steer returns a settling or settled run to active with a fresh
 * start time. The terminal — decided or carried — does not survive: the
 * revived run settles again on its own report. Settling revives too, since a
 * steer can land while the settle pass still awaits its probes.
 */
export function reviveRun(state: RunState, startedAt: number): RunState {
  if (state.shell !== "held") return unchanged(state);
  if (state.process.kind !== "settling" && state.process.kind !== "settled")
    return unchanged(state);
  return {
    process: {
      kind: "active",
      queuedAt: state.process.queuedAt,
      startedAt,
    },
    shell: state.shell,
  };
}

/** A queued run the parent discarded never started; its error says so. */
export function disposeQueuedRun(
  state: RunState,
  completedAt: number,
): RunState {
  if (state.shell !== "held" || state.process.kind !== "queued")
    return unchanged(state);
  return {
    process: {
      kind: "settled",
      queuedAt: state.process.queuedAt,
      started: false,
      terminal: { kind: "failed", error: DISPOSE_QUEUED_MESSAGE },
      completedAt,
    },
    shell: state.shell,
  };
}

/**
 * A live run the parent discarded keeps running under a disposal: the gate is
 * open and the poll is abandoned, but the pane and process survive.
 */
export function disposeLiveRun(state: RunState): RunState {
  if (state.shell !== "held") return unchanged(state);
  if (state.process.kind !== "launching" && state.process.kind !== "active")
    return unchanged(state);
  return {
    process: state.process,
    shell: "disposed",
  };
}

/**
 * A discarded session keeps the lifecycle it had: dropping snapshots the
 * projection instead of deriving a new one.
 */
export function dropRun(state: RunState, artifacts: RunArtifacts): RunState {
  if (state.shell === "dropped") return unchanged(state);
  return { shell: "dropped", lifecycle: projectLifecycle(state, artifacts) };
}

/**
 * What the session holds for the run and the projection reads: the launch the
 * run produced, and why its owned worktree was kept. Both outlive the process
 * (a revive resumes the launch) so they ride the lifecycle rather than a
 * second projection that would have to be kept in step with it.
 */
export interface RunArtifacts {
  launch?: AgentLaunchState;
  retention?: WorktreeRetentionReason;
}

/** A launched run's settled projection: its terminal, plus what the launch and the settle pass left behind. */
function settledStartedOutcome(
  startedAt: number,
  terminal: RunTerminal,
  completedAt: number,
  { launch, retention }: RunArtifacts,
): SettledLifecycleState {
  const shared = {
    phase: "settled" as const,
    startedAt,
    ...(launch === undefined ? {} : { launch }),
    ...(retention === undefined ? {} : { worktreeRetentionReason: retention }),
  };
  switch (terminal.kind) {
    case "completed":
      return {
        ...shared,
        status: "completed",
        result: terminal.result,
        completedAt,
      };
    case "failed":
      return { ...shared, status: "error", error: terminal.error, completedAt };
    case "stopped":
      return {
        ...shared,
        status: "stopped",
        completedAt,
        stop: { initiator: terminal.initiator },
      };
  }
}

/** A run that ended before launching: its terminal, and the queue time it never left. A never-launched run holds no launch. */
function settledNeverStartedOutcome(
  queuedAt: number,
  terminal: RunNeverStartedTerminal,
  completedAt: number,
  { retention }: RunArtifacts,
): NeverStartedLifecycleState {
  const shared = {
    phase: "never-started" as const,
    queuedAt,
    ...(retention === undefined ? {} : { worktreeRetentionReason: retention }),
  };
  switch (terminal.kind) {
    case "failed":
      return { ...shared, status: "error", error: terminal.error, completedAt };
    case "stopped":
      return {
        ...shared,
        status: "stopped",
        completedAt,
        stop: { initiator: terminal.initiator },
      };
  }
}

function projectProcess(
  process: ProcessStatus,
  artifacts: RunArtifacts,
): AgentLifecycleState {
  switch (process.kind) {
    case "queued":
      return { phase: "queued", queuedAt: process.queuedAt };
    case "launching":
    case "active":
      return {
        phase: "spawned",
        startedAt: process.startedAt,
        ...(artifacts.launch === undefined ? {} : { launch: artifacts.launch }),
      };
    case "settling":
      return settledStartedOutcome(
        process.startedAt,
        process.terminal,
        process.completedAt,
        artifacts,
      );
    case "settled":
      return process.started
        ? settledStartedOutcome(
            process.startedAt,
            process.terminal,
            process.completedAt,
            artifacts,
          )
        : settledNeverStartedOutcome(
            process.queuedAt,
            process.terminal,
            process.completedAt,
            artifacts,
          );
  }
}

/**
 * The one derivation of the spawn's lifecycle from the run. A settling process
 * already projects settled — the run is not settled until the pass ends, but
 * its outcome is decided. A disposal projects its live process; a drop returns
 * the frozen lifecycle it stored.
 */
export function projectLifecycle(
  state: RunState,
  artifacts: RunArtifacts,
): AgentLifecycleState {
  if (state.shell === "dropped") return state.lifecycle;
  return projectProcess(state.process, artifacts);
}

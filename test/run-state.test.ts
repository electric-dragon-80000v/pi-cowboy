/**
 * run-state.test.ts — The run's pure transitions and its one projection.
 * No fakes, no timers: every timestamp is a literal, and every no-op
 * transition returns its input by identity.
 */

import { describe, expect, it } from "vitest";
import {
  DISPOSE_QUEUED_MESSAGE,
  abortQueuedRun,
  activateRun,
  createRun,
  disposeLiveRun,
  disposeQueuedRun,
  dropRun,
  enterSettling,
  failStart,
  finishSettling,
  projectLifecycle,
  reviveRun,
  startRun,
  type RunArtifacts,
  type RunState,
} from "../src/agents/run-state.js";
import type { AgentLaunchState, AgentLifecycleState } from "../src/types.js";

const QUEUED_AT = 1_700_000_000_000;
const STARTED_AT = 1_700_000_001_000;
const COMPLETED_AT = 1_700_000_002_000;

/** Nothing beyond the run's own state: the launch and retention the session would hold. */
const NO_ARTIFACTS: RunArtifacts = {};

/** The projection with no session-held artifacts, which is all a purely run-state case derives. */
function lifecycleOf(state: RunState): AgentLifecycleState {
  return projectLifecycle(state, NO_ARTIFACTS);
}

const HELD = "held" as const;
const DISPOSED = "disposed" as const;

function queued(): RunState {
  return createRun(QUEUED_AT);
}

function launching(): RunState {
  return startRun(queued(), STARTED_AT);
}

function active(): RunState {
  return activateRun(launching());
}

function settlingCompleted(): RunState {
  return enterSettling(
    active(),
    { kind: "completed", result: "the final answer" },
    COMPLETED_AT,
  );
}

describe("run-state start", () => {
  it("births a held queued process", () => {
    expect(queued()).toEqual({
      process: { kind: "queued", queuedAt: QUEUED_AT },
      shell: HELD,
    });
  });

  it("moves queued to launching with the given start time", () => {
    expect(startRun(queued(), STARTED_AT)).toEqual({
      process: {
        kind: "launching",
        queuedAt: QUEUED_AT,
        startedAt: STARTED_AT,
      },
      shell: HELD,
    });
  });

  it.each([
    ["launching", launching()],
    ["active", active()],
    ["settling", settlingCompleted()],
    ["settled", finishSettling(settlingCompleted())],
  ])("leaves a %s process untouched", (_name, state) => {
    expect(startRun(state, STARTED_AT)).toBe(state);
  });

  it("activates a launching process and nothing else", () => {
    expect(activateRun(launching())).toEqual({
      process: { kind: "active", queuedAt: QUEUED_AT, startedAt: STARTED_AT },
      shell: HELD,
    });
    const settled = finishSettling(settlingCompleted());
    const stillQueued = queued();
    expect(activateRun(stillQueued)).toBe(stillQueued);
    const stillActive = active();
    expect(activateRun(stillActive)).toBe(stillActive);
    expect(activateRun(settled)).toBe(settled);
  });
});

describe("run-state abort and start failure", () => {
  it("settles a queued abort as never-started stopped", () => {
    expect(abortQueuedRun(queued(), "user", COMPLETED_AT)).toEqual({
      process: {
        kind: "settled",
        queuedAt: QUEUED_AT,
        started: false,
        terminal: { kind: "stopped", initiator: "user" },
        completedAt: COMPLETED_AT,
      },
      shell: HELD,
    });
  });

  it("ignores a queued abort once the process left queued", () => {
    const run = active();
    expect(abortQueuedRun(run, "user", COMPLETED_AT)).toBe(run);
  });

  it("fails a queued start as never-started and a launching start as started", () => {
    expect(failStart(queued(), "boom", COMPLETED_AT)).toEqual({
      process: {
        kind: "settled",
        queuedAt: QUEUED_AT,
        started: false,
        terminal: { kind: "failed", error: "boom" },
        completedAt: COMPLETED_AT,
      },
      shell: HELD,
    });
    expect(failStart(launching(), "boom", COMPLETED_AT)).toEqual({
      process: {
        kind: "settled",
        queuedAt: QUEUED_AT,
        startedAt: STARTED_AT,
        started: true,
        terminal: { kind: "failed", error: "boom" },
        completedAt: COMPLETED_AT,
      },
      shell: HELD,
    });
  });

  it("ignores a start failure once the process is live or over", () => {
    const run = active();
    expect(failStart(run, "boom", COMPLETED_AT)).toBe(run);
    const settled = finishSettling(settlingCompleted());
    expect(failStart(settled, "boom", COMPLETED_AT)).toBe(settled);
  });
});

describe("run-state settling", () => {
  it("enters settling from launching and active with the terminal", () => {
    expect(
      enterSettling(
        launching(),
        { kind: "stopped", initiator: "agent" },
        COMPLETED_AT,
      ),
    ).toEqual({
      process: {
        kind: "settling",
        queuedAt: QUEUED_AT,
        startedAt: STARTED_AT,
        terminal: { kind: "stopped", initiator: "agent" },
        completedAt: COMPLETED_AT,
      },
      shell: HELD,
    });
    expect(
      enterSettling(
        active(),
        { kind: "completed", result: "done" },
        COMPLETED_AT,
      ),
    ).toMatchObject({
      process: { kind: "settling", startedAt: STARTED_AT },
      shell: HELD,
    });
  });

  it("refuses to settle a process with no terminal yet, or one already over", () => {
    const run = queued();
    expect(
      enterSettling(run, { kind: "completed", result: "done" }, COMPLETED_AT),
    ).toBe(run);
    const settled = finishSettling(settlingCompleted());
    expect(
      enterSettling(
        settled,
        { kind: "completed", result: "done" },
        COMPLETED_AT,
      ),
    ).toBe(settled);
  });

  it("finishes settling into the carried terminal, exactly once", () => {
    const settling = enterSettling(
      active(),
      { kind: "stopped", initiator: "user" },
      COMPLETED_AT,
    );
    expect(finishSettling(settling)).toEqual({
      process: {
        kind: "settled",
        queuedAt: QUEUED_AT,
        startedAt: STARTED_AT,
        started: true,
        terminal: { kind: "stopped", initiator: "user" },
        completedAt: COMPLETED_AT,
      },
      shell: HELD,
    });
    const settled = finishSettling(settling);
    expect(finishSettling(settled)).toBe(settled);
    const run = active();
    expect(finishSettling(run)).toBe(run);
  });
});

describe("run-state revive", () => {
  it("returns a settled process to active with a fresh start time", () => {
    const settledStarted = finishSettling(settlingCompleted());
    const revived = reviveRun(settledStarted, STARTED_AT + 5_000);
    expect(revived).toEqual({
      process: {
        kind: "active",
        queuedAt: QUEUED_AT,
        startedAt: STARTED_AT + 5_000,
      },
      shell: HELD,
    });
    // The settled outcome does not survive: the revived run settles again.
    expect(revived).not.toHaveProperty("terminal");
  });

  it("revives a never-started settlement too, dropping its terminal", () => {
    const settled = abortQueuedRun(queued(), "agent", COMPLETED_AT);
    expect(reviveRun(settled, STARTED_AT)).toEqual({
      process: { kind: "active", queuedAt: QUEUED_AT, startedAt: STARTED_AT },
      shell: HELD,
    });
  });

  it("ignores revive while the process is still live", () => {
    const run = active();
    expect(reviveRun(run, STARTED_AT)).toBe(run);
    const stillQueued = queued();
    expect(reviveRun(stillQueued, STARTED_AT)).toBe(stillQueued);
  });
});

describe("run-state disposal", () => {
  it("projects a queued disposal as the never-started error", () => {
    expect(disposeQueuedRun(queued(), COMPLETED_AT)).toEqual({
      process: {
        kind: "settled",
        queuedAt: QUEUED_AT,
        started: false,
        terminal: { kind: "failed", error: DISPOSE_QUEUED_MESSAGE },
        completedAt: COMPLETED_AT,
      },
      shell: HELD,
    });
  });

  it("ignores a queued disposal once the process left queued", () => {
    const run = active();
    expect(disposeQueuedRun(run, COMPLETED_AT)).toBe(run);
  });

  it("holds a live disposal next to its process, ending nothing", () => {
    expect(disposeLiveRun(launching())).toEqual({
      process: {
        kind: "launching",
        queuedAt: QUEUED_AT,
        startedAt: STARTED_AT,
      },
      shell: DISPOSED,
    });
    expect(disposeLiveRun(active())).toEqual({
      process: {
        kind: "active",
        queuedAt: QUEUED_AT,
        startedAt: STARTED_AT,
      },
      shell: DISPOSED,
    });
  });

  it("a disposal in flight follows its process into active", () => {
    const disposed = disposeLiveRun(launching());
    expect(activateRun(disposed)).toEqual({
      process: {
        kind: "active",
        queuedAt: QUEUED_AT,
        startedAt: STARTED_AT,
      },
      shell: DISPOSED,
    });
  });

  it("a terminal outcome ends the disposal: settlement reports normally", () => {
    const disposed = disposeLiveRun(active());
    const settling = enterSettling(
      disposed,
      { kind: "completed", result: "late report" },
      COMPLETED_AT,
    );
    expect(settling).toEqual({
      process: {
        kind: "settling",
        queuedAt: QUEUED_AT,
        startedAt: STARTED_AT,
        terminal: { kind: "completed", result: "late report" },
        completedAt: COMPLETED_AT,
      },
      shell: HELD,
    });
  });

  it("ignores a live disposal once the process is no longer live", () => {
    const run = queued();
    expect(disposeLiveRun(run)).toBe(run);
    const settled = finishSettling(settlingCompleted());
    expect(disposeLiveRun(settled)).toBe(settled);
    const disposed = disposeLiveRun(active());
    expect(disposeLiveRun(disposed)).toBe(disposed);
  });
});

describe("run-state drop", () => {
  it.each([
    ["queued", queued()],
    ["launching", launching()],
    ["active", active()],
    ["settling", settlingCompleted()],
    ["settled", finishSettling(settlingCompleted())],
    ["queued-aborted", abortQueuedRun(queued(), "user", COMPLETED_AT)],
    ["queued-disposed", disposeQueuedRun(queued(), COMPLETED_AT)],
    ["live-disposed", disposeLiveRun(active())],
  ])(
    "keeps the %s lifecycle a discarded session leaves behind",
    (_name, state) => {
      const dropped = dropRun(state, NO_ARTIFACTS);
      expect(dropped.shell).toBe("dropped");
      // Snapshotted, not re-derived: a drop mid-settle cannot move backwards.
      expect(lifecycleOf(dropped)).toEqual(lifecycleOf(state));
    },
  );

  it("dropping a drop is a no-op", () => {
    const dropped = dropRun(active(), NO_ARTIFACTS);
    expect(dropRun(dropped, NO_ARTIFACTS)).toBe(dropped);
  });
});

describe("projectLifecycle", () => {
  it("births queued processes never started", () => {
    expect(lifecycleOf(queued())).toEqual({
      phase: "queued",
      queuedAt: QUEUED_AT,
    });
  });

  it("spawns launching and active processes as started", () => {
    expect(lifecycleOf(launching())).toEqual({
      phase: "spawned",
      startedAt: STARTED_AT,
    });
    expect(lifecycleOf(active())).toEqual({
      phase: "spawned",
      startedAt: STARTED_AT,
    });
  });

  it("derives never-started outcomes from the queued time, not a start", () => {
    expect(
      lifecycleOf(abortQueuedRun(queued(), "agent", COMPLETED_AT)),
    ).toEqual({
      phase: "never-started",
      queuedAt: QUEUED_AT,
      status: "stopped",
      completedAt: COMPLETED_AT,
      stop: { initiator: "agent" },
    });
    expect(
      lifecycleOf(failStart(queued(), "boom", COMPLETED_AT)),
    ).toMatchObject({
      phase: "never-started",
      queuedAt: QUEUED_AT,
      status: "error",
      error: "boom",
    });
    expect(lifecycleOf(disposeQueuedRun(queued(), COMPLETED_AT))).toMatchObject(
      {
        phase: "never-started",
        queuedAt: QUEUED_AT,
        status: "error",
        error: DISPOSE_QUEUED_MESSAGE,
      },
    );
  });

  it("derives started outcomes from the process's own start time", () => {
    expect(lifecycleOf(failStart(launching(), "boom", COMPLETED_AT))).toEqual({
      phase: "settled",
      startedAt: STARTED_AT,
      status: "error",
      error: "boom",
      completedAt: COMPLETED_AT,
    });
    expect(
      lifecycleOf(
        enterSettling(
          active(),
          { kind: "stopped", initiator: "user" },
          COMPLETED_AT,
        ),
      ),
    ).toEqual({
      phase: "settled",
      startedAt: STARTED_AT,
      status: "stopped",
      completedAt: COMPLETED_AT,
      stop: { initiator: "user" },
    });
    expect(lifecycleOf(finishSettling(settlingCompleted()))).toEqual({
      phase: "settled",
      startedAt: STARTED_AT,
      status: "completed",
      result: "the final answer",
      completedAt: COMPLETED_AT,
    });
  });

  it("projects a settling process as settled: the outcome is decided, the pass is not over", () => {
    const settling = settlingCompleted();
    expect(settling).toMatchObject({
      process: { kind: "settling" },
      shell: HELD,
    });
    expect(lifecycleOf(settling)).toMatchObject({
      phase: "settled",
      status: "completed",
      result: "the final answer",
    });
  });

  it("keeps a disposed shell on its live process projection", () => {
    expect(lifecycleOf(disposeLiveRun(launching()))).toEqual({
      phase: "spawned",
      startedAt: STARTED_AT,
    });
    expect(lifecycleOf(disposeLiveRun(active()))).toEqual({
      phase: "spawned",
      startedAt: STARTED_AT,
    });
  });
});

const LAUNCH: AgentLaunchState = {
  resultFile: "/tmp/pi-cowboy/01234567/result.md",
};

describe("projectLifecycle artifacts", () => {
  it("carries the launch into a spawned run and the retention reason into a settled one", () => {
    expect(projectLifecycle(active(), { launch: LAUNCH })).toEqual({
      phase: "spawned",
      startedAt: STARTED_AT,
      launch: LAUNCH,
    });

    expect(
      projectLifecycle(settlingCompleted(), {
        launch: LAUNCH,
        retention: { kind: "dirty" },
      }),
    ).toEqual({
      phase: "settled",
      startedAt: STARTED_AT,
      launch: LAUNCH,
      worktreeRetentionReason: { kind: "dirty" },
      status: "completed",
      result: "the final answer",
      completedAt: COMPLETED_AT,
    });
  });

  it("never carries the run's execution: it belongs to the spawn, not to a phase", () => {
    const projected = projectLifecycle(active(), { launch: LAUNCH });
    expect(projected).not.toHaveProperty("promise");
    expect(projected).not.toHaveProperty("abortController");
    expect(projected).not.toHaveProperty("host");
    expect(projected).not.toHaveProperty("spawnCtx");
  });

  it("keeps the launch out of a run that never launched", () => {
    const queuedLifecycle = projectLifecycle(queued(), { launch: LAUNCH });
    expect(queuedLifecycle).toEqual({ phase: "queued", queuedAt: QUEUED_AT });
    expect(queuedLifecycle).not.toHaveProperty("launch");

    const failed = projectLifecycle(failStart(queued(), "boom", COMPLETED_AT), {
      launch: LAUNCH,
      retention: { kind: "dirty" },
    });
    expect(failed).toMatchObject({
      phase: "never-started",
      queuedAt: QUEUED_AT,
    });
    expect(failed).not.toHaveProperty("launch");
  });

  it("drops the retention reason on revive while the launch survives", () => {
    const revived = projectLifecycle(
      reviveRun(settlingCompleted(), STARTED_AT),
      { launch: LAUNCH },
    );

    expect(revived).toMatchObject({ phase: "spawned", launch: LAUNCH });
    expect(revived).not.toHaveProperty("worktreeRetentionReason");
  });
});

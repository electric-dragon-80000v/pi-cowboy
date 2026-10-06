/**
 * orchestrator-context.test.ts — Per-cue context builders and their derived
 * variable-name sets. Pins the two template rules: an inapplicable fact is
 * ABSENT (never "" / false / undefined-valued), and usable names derive from
 * the context type rather than being written out twice.
 */

import { describe, expect, it } from "vitest";
import {
  cueVariables,
  queuedCueContext,
  queuedCueVariables,
  settledCueContext,
  settledCueVariables,
  spawnCueContext,
  spawnedCueVariables,
  type CueContextFor,
  type QueuedCueContext,
  type SettledCueContext,
  type SpawnedCueContext,
} from "../src/orchestrators/context.js";

const PATH = "/wt/cow-fix-login-abc";
const BRANCH = "cow-fix-login-abc";
const AGENT_ID = "abcd1234-dead-beef";
const WORKTREE = { path: PATH, branch: BRANCH };

describe("spawnCueContext", () => {
  it("carries the agent id and the worktree facts together", () => {
    expect(spawnCueContext({ agentId: AGENT_ID, worktree: WORKTREE })).toEqual({
      agent_id: AGENT_ID,
      has_worktree: true,
      worktree_path: PATH,
      worktree_branch: BRANCH,
    });
  });

  it("omits every worktree fact when there is no worktree", () => {
    const context = spawnCueContext({ agentId: AGENT_ID });

    expect(context).toEqual({ agent_id: AGENT_ID });
    expect("has_worktree" in context).toBe(false);
    expect("worktree_path" in context).toBe(false);
    expect("worktree_branch" in context).toBe(false);
  });

  it("does not mutate its input", () => {
    const worktree = { ...WORKTREE };
    spawnCueContext({ agentId: AGENT_ID, worktree });

    expect(worktree).toEqual(WORKTREE);
  });
});

describe("queuedCueContext", () => {
  it("extends the spawn context with the queue depth", () => {
    expect(
      queuedCueContext({
        agentId: AGENT_ID,
        worktree: WORKTREE,
        queueRunning: 3,
      }),
    ).toEqual({
      agent_id: AGENT_ID,
      has_worktree: true,
      worktree_path: PATH,
      worktree_branch: BRANCH,
      queue_running: 3,
      queue_running_label: "agents",
    });
  });

  it("omits the worktree facts when there is no worktree", () => {
    const context = queuedCueContext({ agentId: AGENT_ID, queueRunning: 2 });

    expect(context).toEqual({
      agent_id: AGENT_ID,
      queue_running: 2,
      queue_running_label: "agents",
    });
    expect("has_worktree" in context).toBe(false);
  });

  it("labels the queue singular only at exactly one spawned agent", () => {
    const label = (queueRunning: number) =>
      queuedCueContext({ agentId: AGENT_ID, queueRunning }).queue_running_label;

    expect(label(0)).toBe("agents");
    expect(label(1)).toBe("agent");
    expect(label(2)).toBe("agents");
    expect(label(9)).toBe("agents");
  });
});

describe("settledCueContext", () => {
  it("carries a completed outcome and status note when they apply", () => {
    expect(
      settledCueContext({
        outcome: { kind: "completed", result: "All done." },
        statusNote: " (STOPPED BY YOU)",
      }),
    ).toEqual({
      result: "All done.",
      status_note: " (STOPPED BY YOU)",
    });
  });

  it("carries a failed outcome", () => {
    expect(
      settledCueContext({
        outcome: { kind: "failed", error: "boom" },
        statusNote: " (STOPPED BY YOU)",
      }),
    ).toEqual({
      error: "boom",
      status_note: " (STOPPED BY YOU)",
    });
  });

  it("refuses a result alongside an error at compile time", () => {
    expect(() =>
      settledCueContext({
        // @ts-expect-error — a settle ends in exactly one outcome.
        outcome: { kind: "completed", result: "r", error: "boom" },
      }),
    ).not.toThrow();
  });

  it("omits an empty result — never empty-string filler", () => {
    const context = settledCueContext({
      outcome: { kind: "completed", result: "" },
    });

    expect(context).toEqual({});
    expect("result" in context).toBe(false);
  });

  it("omits outcome facts that do not apply", () => {
    const context = settledCueContext({
      outcome: { kind: "completed", result: "All done." },
    });

    expect(context).toEqual({ result: "All done." });
    expect("error" in context).toBe(false);
    expect("status_note" in context).toBe(false);
    expect("retention" in context).toBe(false);
    expect("process_alive" in context).toBe(false);
    expect(settledCueContext({ outcome: { kind: "stopped" } })).toEqual({});
  });

  it("keeps the status note's own leading space verbatim", () => {
    expect(
      settledCueContext({
        outcome: { kind: "stopped" },
        statusNote:
          " (STOPPED BY THE USER before completion — output is partial; the task was NOT finished)",
      }).status_note,
    ).toBe(
      " (STOPPED BY THE USER before completion — output is partial; the task was NOT finished)",
    );
  });

  it("treats an empty status note as not applying", () => {
    expect(
      "status_note" in
        settledCueContext({
          outcome: { kind: "stopped" },
          statusNote: "",
        }),
    ).toBe(false);
  });

  it("carries the worktree facts, retention and liveness", () => {
    expect(
      settledCueContext({
        outcome: { kind: "completed", result: "Partial." },
        worktree: {
          path: PATH,
          branch: BRANCH,
          retention: "has uncommitted changes",
          processAlive: true,
        },
      }),
    ).toEqual({
      result: "Partial.",
      has_worktree: true,
      worktree_path: PATH,
      worktree_branch: BRANCH,
      retention: "has uncommitted changes",
      process_alive: true,
    });
  });

  it("omits retention and process_alive for a clean, dead settle", () => {
    const context = settledCueContext({
      outcome: { kind: "completed", result: "Partial." },
      worktree: { path: PATH, branch: BRANCH, processAlive: false },
    });

    expect(context).toEqual({
      result: "Partial.",
      has_worktree: true,
      worktree_path: PATH,
      worktree_branch: BRANCH,
    });
    expect("retention" in context).toBe(false);
    expect("process_alive" in context).toBe(false);
  });

  it("never emits liveness or retention without a worktree", () => {
    const context = settledCueContext({
      outcome: { kind: "stopped" },
      statusNote: " (n)",
    });

    expect("process_alive" in context).toBe(false);
    expect("retention" in context).toBe(false);
    expect("has_worktree" in context).toBe(false);
  });
});

/* ── Derived variable-name sets ─────────────────────────────────────────── */

describe("per-cue variable-name sets", () => {
  /** Every variable the builders can emit: both settled outcomes (a settle ends in exactly one). */
  const fullContexts: {
    spawned: SpawnedCueContext;
    queued: QueuedCueContext;
    settled: SettledCueContext[];
  } = {
    spawned: spawnCueContext({ agentId: AGENT_ID, worktree: WORKTREE }),
    queued: queuedCueContext({
      agentId: AGENT_ID,
      worktree: WORKTREE,
      queueRunning: 1,
    }),
    settled: [
      settledCueContext({
        outcome: { kind: "completed", result: "r" },
        statusNote: " (n)",
        worktree: {
          path: PATH,
          branch: BRANCH,
          retention: "dirty",
          processAlive: true,
        },
      }),
      settledCueContext({
        outcome: { kind: "failed", error: "e" },
        statusNote: " (n)",
        worktree: {
          path: PATH,
          branch: BRANCH,
          retention: "dirty",
          processAlive: true,
        },
      }),
    ],
  };

  it("lists exactly the printed context keys of each cue — no more, no less", () => {
    expect([...spawnedCueVariables].sort()).toEqual(
      Object.keys(fullContexts.spawned).sort(),
    );
    expect([...queuedCueVariables].sort()).toEqual(
      Object.keys(fullContexts.queued).sort(),
    );
    // The settled names span both outcomes; neither outcome carries both.
    const settledKeys = new Set([
      ...Object.keys(fullContexts.settled[0]!),
      ...Object.keys(fullContexts.settled[1]!),
    ]);
    expect([...settledCueVariables].sort()).toEqual([...settledKeys].sort());
    expect(
      Object.keys(fullContexts.settled[0]!).every((key) =>
        settledKeys.has(key),
      ),
    ).toBe(true);
    expect(
      Object.keys(fullContexts.settled[1]!).every((key) =>
        settledKeys.has(key),
      ),
    ).toBe(true);
  });

  it("keeps each cue's set its own — no cue inherits another's names", () => {
    expect([...spawnedCueVariables].sort()).toEqual([
      "agent_id",
      "has_worktree",
      "worktree_branch",
      "worktree_path",
    ]);
    expect([...queuedCueVariables].sort()).toEqual([
      "agent_id",
      "has_worktree",
      "queue_running",
      "queue_running_label",
      "worktree_branch",
      "worktree_path",
    ]);
    expect([...settledCueVariables].sort()).toEqual([
      "error",
      "has_worktree",
      "process_alive",
      "result",
      "retention",
      "status_note",
      "worktree_branch",
      "worktree_path",
    ]);
    expect(spawnedCueVariables).not.toContain("result");
    expect(settledCueVariables).not.toContain("queue_running");
  });

  it("routes each event to its own set", () => {
    expect(cueVariables("spawned")).toBe(spawnedCueVariables);
    expect(cueVariables("queued")).toBe(queuedCueVariables);
    expect(cueVariables("settled")).toBe(settledCueVariables);
  });

  it("has no set for an event that does not exist at runtime", () => {
    // The guard is for callers reaching the function across the untyped template boundary.
    expect(cueVariables("nope" as keyof CueContextFor)).toBeUndefined();
  });
});

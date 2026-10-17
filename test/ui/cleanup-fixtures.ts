/**
 * cleanup-fixtures.ts — CleanupReport builders shared by the status-menu and
 * cleanup-flow tests, so a report's shape is written once.
 */
import type {
  CleanupReport,
  WorktreeKeptReason,
} from "../../src/agents/cleanup-policy.js";

export const WT_PATH = "/repo/.worktrees/fix-login";
export const BRANCH = "cow-fix-login-abcd1234";

/** A teardown that closed the pane, removed the tree and deleted the branch. */
export function fullTeardown(id: string): CleanupReport {
  return {
    agentId: id,
    source: "tracked",
    outcome: { kind: "torn-down" },
    settlement: { kind: "recorded", phase: "settled" },
    pane: { kind: "closed", paneId: "pane-1" },
    worktree: { kind: "removed", path: WT_PATH },
    branch: { kind: "deleted" },
    branchName: BRANCH,
  };
}

/** A dirty-tree refusal: the forceable kind force exists to override. */
export function dirtyRefusal(id: string): CleanupReport {
  return {
    ...fullTeardown(id),
    outcome: { kind: "refused", reason: { kind: "dirty" }, forceable: true },
    worktree: { kind: "kept", path: WT_PATH },
  };
}

/** The teardown a forced pass produces: the same run, marked overridden. */
export function forcedTeardown(
  id: string,
  reason: WorktreeKeptReason = { kind: "dirty" },
): CleanupReport {
  return {
    ...fullTeardown(id),
    outcome: { kind: "torn-down", forced: { reason } },
  };
}

/** A refusal force cannot change: no worktree path or repo cwd to act on. */
export function unlocatableRefusal(id: string): CleanupReport {
  return {
    ...fullTeardown(id),
    outcome: {
      kind: "refused",
      reason: {
        kind: "unverifiable",
        detail: "missing worktree path or repo cwd",
      },
      forceable: false,
    },
    worktree: { kind: "kept", path: WT_PATH },
  };
}

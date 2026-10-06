/**
 * cleanup-report.test.ts — the one-line cleanup summary the menus notify and
 * the "needs attention" verdict that picks its notification kind. The tool's
 * multi-line report is pinned by tool-cleanup.test.ts.
 */

import { describe, expect, it } from "vitest";
import type { CleanupReport } from "../src/agents/cleanup-policy.js";
import {
  cleanupNeedsAttention,
  summarizeCleanupReport,
} from "../src/agents/cleanup-report.js";

const ID = "a1b2c3d4";
const BRANCH = `cow-fix-login-${ID}`;
const WT_PATH = `/worktrees/${BRANCH}`;

function report(overrides: Partial<CleanupReport> = {}): CleanupReport {
  return {
    agentId: ID,
    source: "tracked",
    outcome: { kind: "torn-down" },
    settlement: { kind: "recorded", phase: "settled" },
    pane: { kind: "closed", paneId: "w1:p1" },
    worktree: { kind: "removed", path: WT_PATH },
    branch: { kind: "deleted" },
    branchName: BRANCH,
    ...overrides,
  };
}

describe("summarizeCleanupReport", () => {
  it("names what happened to each artifact", () => {
    expect(summarizeCleanupReport(report())).toBe(
      `Cleaned up agent ${ID}: pane closed, worktree removed (${WT_PATH}), branch deleted (${BRANCH})`,
    );
  });

  it("reports a refused run with its reason", () => {
    expect(
      summarizeCleanupReport(
        report({
          outcome: {
            kind: "refused",
            reason: { kind: "dirty" },
          },
          worktree: { kind: "kept", path: WT_PATH },
          branch: { kind: "kept", reason: "unmerged" },
        }),
      ),
    ).toBe(`Did not clean up agent ${ID}: has uncommitted changes pane closed`);
  });

  it("reports an unverifiable refusal with no worktree to name", () => {
    expect(
      summarizeCleanupReport(
        report({
          outcome: {
            kind: "refused",
            reason: { kind: "unverifiable", detail: "git status failed" },
          },
          worktree: { kind: "kept", path: null },
        }),
      ),
    ).toBe(
      "Did not clean up agent a1b2c3d4: state could not be verified (git status failed) pane closed",
    );
  });

  it("reports a run that never had a pane or a worktree", () => {
    expect(
      summarizeCleanupReport(
        report({
          pane: { kind: "none" },
          worktree: { kind: "none" },
          branch: { kind: "not-applicable" },
          branchName: undefined,
        }),
      ),
    ).toBe(
      `Cleaned up agent ${ID}: no pane, worktree none (agent ran without a worktree), branch not applicable`,
    );
  });

  it("reports a checkout that was already gone, and a pane that is too", () => {
    expect(
      summarizeCleanupReport(
        report({
          pane: { kind: "gone", paneId: "w1:p1" },
          worktree: { kind: "absent", path: WT_PATH },
          branch: { kind: "not-applicable" },
        }),
      ),
    ).toBe(
      `Cleaned up agent ${ID}: pane already gone, worktree already gone (${WT_PATH}), branch not applicable (${BRANCH})`,
    );
  });

  it("reports a pane whose state was never read", () => {
    expect(
      summarizeCleanupReport(
        report({
          pane: { kind: "unknown", paneId: "w1:p1" },
          worktree: { kind: "absent", path: WT_PATH },
          branch: { kind: "not-applicable" },
        }),
      ),
    ).toBe(
      `Cleaned up agent ${ID}: pane state unknown, worktree already gone (${WT_PATH}), branch not applicable (${BRANCH})`,
    );
  });

  it("names a pane and a branch left behind", () => {
    expect(
      summarizeCleanupReport(
        report({
          pane: { kind: "open", paneId: "w1:p1" },
          worktree: {
            kind: "removal-failed",
            path: WT_PATH,
            detail: "in use",
          },
          branch: { kind: "delete-failed", detail: "checked out" },
        }),
      ),
    ).toBe(
      `Cleaned up agent ${ID}: pane left open, worktree NOT removed — in use (${WT_PATH}), branch NOT deleted — checked out (${BRANCH})`,
    );
  });
});

describe("cleanupNeedsAttention", () => {
  it("passes a teardown that left nothing behind", () => {
    expect(cleanupNeedsAttention(report())).toBe(false);
    expect(
      cleanupNeedsAttention(
        report({
          pane: { kind: "gone", paneId: "w1:p1" },
          worktree: { kind: "absent", path: WT_PATH },
          branch: { kind: "not-applicable" },
        }),
      ),
    ).toBe(false);
    expect(
      cleanupNeedsAttention(
        report({ branch: { kind: "kept", reason: "unmerged" } }),
      ),
    ).toBe(false);
  });

  it.each<[string, Partial<CleanupReport>]>([
    ["a kept worktree", { worktree: { kind: "kept", path: null } }],
    [
      "a refused run",
      { outcome: { kind: "refused", reason: { kind: "dirty" } } },
    ],
    [
      "a worktree removal that failed",
      { worktree: { kind: "removal-failed", path: WT_PATH, detail: "in use" } },
    ],
    [
      "a branch delete that failed",
      { branch: { kind: "delete-failed", detail: "checked out" } },
    ],
  ])("flags %s", (_label, override) => {
    expect(cleanupNeedsAttention(report(override))).toBe(true);
  });
});

/**
 * herdr-launcher.test.ts — the git-side rollback rules that are pure policy:
 * which artifacts a failed `worktree add` prunes. The mechanics of git run in
 * herdr-launcher.integration.test.ts; here the git seam is canned so each
 * branch-ownership case is exact.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  deleteCreatedBranchMock,
  gitRunMock,
  materializeWorktreeMock,
  removeGitWorktreeMock,
} = vi.hoisted(() => ({
  deleteCreatedBranchMock: vi.fn(),
  gitRunMock: vi.fn(),
  materializeWorktreeMock: vi.fn(),
  removeGitWorktreeMock: vi.fn(),
}));

vi.mock("../src/infrastructure/git-client.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../src/infrastructure/git-client.js")
  >()),
  deleteCreatedBranch: deleteCreatedBranchMock,
  gitRun: gitRunMock,
  materializeWorktree: materializeWorktreeMock,
  removeGitWorktree: removeGitWorktreeMock,
  resolveMainCheckout: async () => "/repo",
}));

const { createWorktreeCheckout } =
  await import("../src/spawn/herdr-launcher.js");

const pi = {} as ExtensionAPI;

/** A failed add: the probe says the branch is absent, the add then fails. */
function cannedAddFailure(branchExisted: boolean): void {
  gitRunMock.mockImplementation(
    async (_pi: ExtensionAPI, args: readonly string[]) => {
      if (args[0] === "rev-parse") {
        return {
          code: branchExisted ? 0 : 1,
          stdout: branchExisted ? "abc" : "",
          stderr: "",
        };
      }
      return { code: 128, stdout: "", stderr: "fatal: already exists" };
    },
  );
}

describe("createWorktreeCheckout when the add fails", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    deleteCreatedBranchMock.mockResolvedValue({ kind: "deleted" });
  });

  it("prunes a branch this call created, so a half-made add leaves no ref", async () => {
    cannedAddFailure(false);

    await expect(
      createWorktreeCheckout(pi, {
        repoCwd: "/repo",
        path: "/wt",
        branch: "cow-feature",
      }),
    ).rejects.toThrow(/worktree removed/);

    expect(removeGitWorktreeMock).toHaveBeenCalledWith(pi, "/repo", "/wt");
    // By name: the branch is whatever the caller asked for, `cow-` or not.
    expect(deleteCreatedBranchMock).toHaveBeenCalledWith(
      pi,
      "cow-feature",
      "/repo",
    );
  });

  it("leaves a pre-existing branch alone when the add collides with it", async () => {
    cannedAddFailure(true);

    await expect(
      createWorktreeCheckout(pi, {
        repoCwd: "/repo",
        path: "/wt",
        branch: "cow-feature",
      }),
    ).rejects.toThrow(/already exists/);

    expect(removeGitWorktreeMock).toHaveBeenCalledWith(pi, "/repo", "/wt");
    expect(deleteCreatedBranchMock).not.toHaveBeenCalled();
  });

  it("leaves the branch alone when the pre-add probe could not run", async () => {
    gitRunMock.mockImplementation(
      async (_pi: ExtensionAPI, args: readonly string[]) =>
        args[0] === "rev-parse"
          ? undefined
          : { code: 128, stdout: "", stderr: "fatal: already exists" },
    );

    await expect(
      createWorktreeCheckout(pi, {
        repoCwd: "/repo",
        path: "/wt",
        branch: "cow-feature",
      }),
    ).rejects.toThrow(/worktree removed/);

    expect(deleteCreatedBranchMock).not.toHaveBeenCalled();
  });
});

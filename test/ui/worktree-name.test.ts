/**
 * worktree-name.test.ts — the naming rule behind the wizard's worktree name field.
 * Covers the rejection kinds and the herdr length cap; no prefix is required of
 * a name. The field's re-prompt behavior is exercised in spawn-wizard.test.ts.
 */
import { describe, expect, it } from "vitest";
import {
  WORKTREE_BRANCH_MAX_LENGTH,
  describeWorktreeNameProblem,
  validateWorktreeBranchName,
} from "../../src/ui/menu/submenus/worktree-name.js";

describe("validateWorktreeBranchName", () => {
  it("accepts a lowercase name of letters, numbers, hyphens, and underscores", () => {
    expect(validateWorktreeBranchName("cow-fix-login")).toBeNull();
    expect(validateWorktreeBranchName("fix_login_2")).toBeNull();
    // No prefix is required: the name stands on its own.
    expect(validateWorktreeBranchName("plain-name")).toBeNull();
  });

  it("accepts a name at the herdr length cap and rejects one past it", () => {
    const atCap = `cow-${"a".repeat(WORKTREE_BRANCH_MAX_LENGTH - 4)}`;
    expect(atCap).toHaveLength(WORKTREE_BRANCH_MAX_LENGTH);
    expect(validateWorktreeBranchName(atCap)).toBeNull();
    expect(validateWorktreeBranchName(`${atCap}a`)).toEqual({
      kind: "too-long",
    });
  });

  it("names each rejection", () => {
    expect(validateWorktreeBranchName("")).toEqual({ kind: "empty-name" });
    // A bare prefix names nothing of its own.
    expect(validateWorktreeBranchName("cow-")).toEqual({
      kind: "invalid-characters",
    });
    expect(validateWorktreeBranchName("-leading")).toEqual({
      kind: "invalid-characters",
    });
    expect(validateWorktreeBranchName("trailing-")).toEqual({
      kind: "invalid-characters",
    });
    expect(validateWorktreeBranchName("cow-Fix")).toEqual({
      kind: "invalid-characters",
    });
    expect(validateWorktreeBranchName("cow-bad name")).toEqual({
      kind: "invalid-characters",
    });
    expect(validateWorktreeBranchName("cow-bad.name")).toEqual({
      kind: "invalid-characters",
    });
    expect(validateWorktreeBranchName("cow-bad/name")).toEqual({
      kind: "invalid-characters",
    });
  });
});

describe("describeWorktreeNameProblem", () => {
  it("renders each problem as a message", () => {
    expect(describeWorktreeNameProblem({ kind: "empty-name" })).toContain(
      "Enter a name",
    );
    expect(
      describeWorktreeNameProblem({ kind: "invalid-characters" }),
    ).toContain("only lowercase letters");
    expect(describeWorktreeNameProblem({ kind: "too-long" })).toContain(
      "32 characters",
    );
  });
});

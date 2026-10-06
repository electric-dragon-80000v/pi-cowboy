/**
 * worktree-name.test.ts — the naming rule behind the wizard's worktree name field.
 * Covers the four rejection kinds and the herdr length cap; the field's re-prompt
 * behavior is exercised in spawn-wizard.test.ts.
 */
import { describe, expect, it } from "vitest";
import {
  WORKTREE_BRANCH_MAX_LENGTH,
  describeWorktreeNameProblem,
  validateWorktreeBranchName,
} from "../../src/ui/menu/submenus/worktree-name.js";

describe("validateWorktreeBranchName", () => {
  it("accepts a cow- name of lowercase letters, numbers, hyphens, and underscores", () => {
    expect(validateWorktreeBranchName("cow-fix-login")).toBeNull();
    expect(validateWorktreeBranchName("cow-a")).toBeNull();
    expect(validateWorktreeBranchName("cow-fix_login_2")).toBeNull();
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
    expect(validateWorktreeBranchName("fix-login")).toEqual({
      kind: "missing-prefix",
    });
    expect(validateWorktreeBranchName("cow-")).toEqual({ kind: "empty-name" });
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
    expect(describeWorktreeNameProblem({ kind: "missing-prefix" })).toContain(
      'must start with "cow-"',
    );
    expect(describeWorktreeNameProblem({ kind: "empty-name" })).toContain(
      'Enter a name after "cow-"',
    );
    expect(
      describeWorktreeNameProblem({ kind: "invalid-characters" }),
    ).toContain("only lowercase letters");
    expect(describeWorktreeNameProblem({ kind: "too-long" })).toContain(
      "32 characters",
    );
  });
});

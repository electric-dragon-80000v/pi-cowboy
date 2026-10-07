/**
 * worktree-command-name.test.ts — the naming rule behind the `/cowboy worktree`
 * name field: free-form git branch names, no `cow-` prefix, capped at herdr's
 * agent-name length. The field's re-prompt behavior is exercised in
 * worktree-command.test.ts.
 */
import { describe, expect, it } from "vitest";
import {
  WORKTREE_COMMAND_NAME_MAX_LENGTH,
  describeWorktreeCommandNameProblem,
  validateWorktreeCommandName,
} from "../../src/ui/menu/submenus/worktree-command-name.js";

describe("validateWorktreeCommandName", () => {
  it("accepts any valid git branch name, without a cow- prefix", () => {
    expect(validateWorktreeCommandName("render-page")).toBeNull();
    expect(validateWorktreeCommandName("render/page")).toBeNull();
    expect(validateWorktreeCommandName("fix_login.2")).toBeNull();
    expect(validateWorktreeCommandName("release-2026.1")).toBeNull();
    // A name that merely looks like a spawn's is not special here.
    expect(validateWorktreeCommandName("cow-my-thing")).toBeNull();
  });

  it("accepts a name at the herdr length cap and rejects one past it", () => {
    const atCap = "a".repeat(WORKTREE_COMMAND_NAME_MAX_LENGTH);
    expect(validateWorktreeCommandName(atCap)).toBeNull();
    expect(validateWorktreeCommandName(`${atCap}a`)).toEqual({
      kind: "too-long",
    });
  });

  it("names each rejection", () => {
    expect(validateWorktreeCommandName("")).toEqual({ kind: "empty-name" });
    expect(validateWorktreeCommandName("bad name")).toEqual({
      kind: "invalid-characters",
    });
    expect(validateWorktreeCommandName("bad~name")).toEqual({
      kind: "invalid-characters",
    });
    expect(validateWorktreeCommandName("bad:name")).toEqual({
      kind: "invalid-characters",
    });
    expect(validateWorktreeCommandName("bad..name")).toEqual({
      kind: "invalid-shape",
    });
    expect(validateWorktreeCommandName("bad@{name")).toEqual({
      kind: "invalid-shape",
    });
    expect(validateWorktreeCommandName("-leading")).toEqual({
      kind: "invalid-shape",
    });
    expect(validateWorktreeCommandName("trailing/")).toEqual({
      kind: "invalid-shape",
    });
    expect(validateWorktreeCommandName("locked.lock")).toEqual({
      kind: "invalid-shape",
    });
    expect(validateWorktreeCommandName("@")).toEqual({ kind: "invalid-shape" });
  });
});

describe("describeWorktreeCommandNameProblem", () => {
  it("renders each problem as a message", () => {
    expect(
      describeWorktreeCommandNameProblem({ kind: "empty-name" }),
    ).toContain("Enter a name");
    expect(describeWorktreeCommandNameProblem({ kind: "too-long" })).toContain(
      `${WORKTREE_COMMAND_NAME_MAX_LENGTH} characters`,
    );
    expect(
      describeWorktreeCommandNameProblem({ kind: "invalid-characters" }),
    ).toContain("git branch name");
    expect(
      describeWorktreeCommandNameProblem({ kind: "invalid-shape" }),
    ).toContain("cannot contain .. or @{");
  });
});

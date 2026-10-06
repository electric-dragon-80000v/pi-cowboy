import { describe, expect, it } from "vitest";
import { buildWorktreeBranchSection } from "../src/agents/agent-runner.js";

describe("buildWorktreeBranchSection", () => {
  it("names the detected branch and states the merge rule", () => {
    const section = buildWorktreeBranchSection(
      "/wt/cow-fix-login-flow-abc12345",
      true,
      "cow-fix-login-flow-abc12345",
      "cow-fix-login-flow-abc12345",
    );
    expect(section).toContain("## Worktree branch");
    expect(section).toContain("`cow-fix-login-flow-abc12345`");
    expect(section).toContain("lands on THIS branch");
    expect(section).toContain("Do NOT switch branches");
    expect(section).toContain("merge_cowboy_branch");
  });

  it("falls back to the expected branch when detection failed", () => {
    const section = buildWorktreeBranchSection(
      "/wt/cow-fix-login-flow-abc12345",
      true,
      null,
      "cow-fix-login-flow-abc12345",
    );
    expect(section).toContain("`cow-fix-login-flow-abc12345`");
  });

  it("is empty outside a git worktree", () => {
    expect(buildWorktreeBranchSection(undefined, true, "main", "x")).toBe("");
    expect(buildWorktreeBranchSection("/wt/cow-x", false, null, "cow-x")).toBe(
      "",
    );
    expect(buildWorktreeBranchSection("/wt/cow-x", true, null, undefined)).toBe(
      "",
    );
  });
});

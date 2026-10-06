/** repo-scope-warning.test.ts — pure helpers behind the merge_cowboy_branch repo-scope warning. No git, no pi. */

import { describe, expect, it } from "vitest";
import {
  formatOutsideRepoWarning,
  isSameRepoRoot,
  normalizeRepoRoot,
} from "../src/agents/tool-merge.js";

describe("normalizeRepoRoot", () => {
  it("drops a trailing separator", () => {
    expect(normalizeRepoRoot("/repo/")).toBe("/repo");
  });

  it("collapses dot segments and duplicate separators", () => {
    expect(normalizeRepoRoot("/a//b/./c")).toBe("/a/b/c");
    expect(normalizeRepoRoot("/a/b/../b")).toBe("/a/b");
  });

  it("keeps the filesystem root intact", () => {
    expect(normalizeRepoRoot("/")).toBe("/");
  });
});

describe("isSameRepoRoot", () => {
  it("matches identical roots", () => {
    expect(isSameRepoRoot("/repo", "/repo")).toBe(true);
  });

  it("matches trailing-separator spellings", () => {
    expect(isSameRepoRoot("/repo/", "/repo")).toBe(true);
  });

  it("rejects different checkouts, including prefix siblings", () => {
    expect(isSameRepoRoot("/repo", "/other")).toBe(false);
    expect(isSameRepoRoot("/repo", "/repo2")).toBe(false);
    expect(isSameRepoRoot("/repo", "/repo/sub")).toBe(false);
  });
});

describe("formatOutsideRepoWarning", () => {
  it("is a single loud first line naming both checkouts", () => {
    const warning = formatOutsideRepoWarning("/merge/here", "/session/there");
    expect(warning.split("\n")).toHaveLength(1);
    expect(warning.startsWith("WARNING:")).toBe(true);
    expect(warning).toContain("/merge/here");
    expect(warning).toContain("/session/there");
  });

  it("matches the operator-visible wording", () => {
    expect(formatOutsideRepoWarning("/m", "/s")).toBe(
      "WARNING: merging in /m, outside your session repo (/s) — verify this was intended.",
    );
  });
});

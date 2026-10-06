/**
 * git-retention.integration.test.ts — retention assessment
 * (src/infrastructure/git/git-retention.ts).
 *
 * Only a verifiably clean worktree is reported removable; every keep carries a
 * reason string for the UI.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  formatRetentionClause,
  formatRetentionReason,
  isWorktreeDirty,
  worktreeRetentionReason,
} from "../../src/infrastructure/git/git-retention.js";
import {
  addWorktree,
  cleanupTmpDirs,
  freshTmp,
  makeRepo,
  realPi,
} from "../helpers/git-repo.js";

afterEach(cleanupTmpDirs);

describe("isWorktreeDirty", () => {
  it("reports false for a clean worktree and true for a dirty one", async () => {
    const repo = await makeRepo(freshTmp());
    const wt = join(freshTmp(), "wt-cow-clean-00000000");
    await addWorktree(repo, wt, "cow-clean-00000000");

    expect(await isWorktreeDirty(realPi(), wt)).toBe(false);

    writeFileSync(join(wt, "base.txt"), "edited\n");
    expect(await isWorktreeDirty(realPi(), wt)).toBe(true);
  });

  it("counts untracked files as dirty", async () => {
    const repo = await makeRepo(freshTmp());
    const wt = join(freshTmp(), "wt-cow-untracked-00000000");
    await addWorktree(repo, wt, "cow-untracked-00000000");

    writeFileSync(join(wt, "new.txt"), "untracked\n");
    expect(await isWorktreeDirty(realPi(), wt)).toBe(true);
  });

  it("returns undefined when the path is not a worktree (probe fails)", async () => {
    expect(await isWorktreeDirty(realPi(), join(freshTmp(), "nope"))).toBe(
      undefined,
    );
  });
});

describe("worktreeRetentionReason", () => {
  it("returns null for a clean worktree (safe to remove)", async () => {
    const repo = await makeRepo(freshTmp());
    const wt = join(freshTmp(), "wt-cow-retained-00000000");
    await addWorktree(repo, wt, "cow-retained-00000000");

    expect(await worktreeRetentionReason(realPi(), wt)).toBeNull();
  });

  it("returns kind:dirty for a worktree with uncommitted changes", async () => {
    const repo = await makeRepo(freshTmp());
    const wt = join(freshTmp(), "wt-cow-dirty-00000000");
    await addWorktree(repo, wt, "cow-dirty-00000000");
    writeFileSync(join(wt, "base.txt"), "changed\n");

    expect(await worktreeRetentionReason(realPi(), wt)).toEqual({
      kind: "dirty",
    });
  });

  it("returns kind:unverifiable when the probe fails", async () => {
    expect(
      await worktreeRetentionReason(realPi(), "/definitely/not/here"),
    ).toEqual({ kind: "unverifiable", detail: "git status probe failed" });
  });
});

describe("retention formatters", () => {
  it("renders the clause and the full reason", () => {
    expect(formatRetentionClause({ kind: "dirty" })).toBe(
      "has uncommitted changes",
    );
    expect(
      formatRetentionClause({
        kind: "unverifiable",
        detail: "git status probe failed",
      }),
    ).toBe("state could not be verified (git status probe failed)");

    expect(formatRetentionReason({ kind: "dirty" }, "/wt/cow-x-abc12345")).toBe(
      "Worktree /wt/cow-x-abc12345 has uncommitted changes — NOT removed.",
    );
  });
});

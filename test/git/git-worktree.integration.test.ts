/**
 * git-worktree.integration.test.ts — Layer 2 (src/infrastructure/git/git-worktree.ts).
 *
 * "dirty", "could not tell" (undefined, never a false clean), and best-effort
 * removal against real worktrees.
 */

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitCommandRunner } from "../../src/infrastructure/git/git-runner.js";
import {
  GitWorktree,
  removeGitWorktree,
} from "../../src/infrastructure/git/git-worktree.js";
import {
  addWorktree,
  cleanupTmpDirs,
  freshTmp,
  makeRepo,
  realPi,
} from "../helpers/git-repo.js";

afterEach(cleanupTmpDirs);

/** Worktree entity for `path` over real git. */
function worktreeAt(path: string, branch?: string): GitWorktree {
  return new GitWorktree(new GitCommandRunner(realPi()), path, branch);
}

describe("GitWorktree identity", () => {
  it("carries the path it was constructed with and the branch when known", () => {
    const runner = new GitCommandRunner(realPi());

    const plain = new GitWorktree(runner, "/wt/cow-x-00000000");
    expect(plain.path).toBe("/wt/cow-x-00000000");
    expect(plain.branch).toBeUndefined();

    const onBranch = new GitWorktree(
      runner,
      "/wt/cow-x-00000000",
      "cow-x-00000000",
    );
    expect(onBranch.path).toBe("/wt/cow-x-00000000");
    expect(onBranch.branch).toBe("cow-x-00000000");
  });
});

describe("GitWorktree.isDirty", () => {
  it("reports false for a clean worktree and true for a dirty one", async () => {
    const repo = await makeRepo(freshTmp());
    const wt = join(freshTmp(), "wt-cow-clean-00000000");
    await addWorktree(repo, wt, "cow-clean-00000000");

    expect(await worktreeAt(wt).isDirty()).toBe(false);

    writeFileSync(join(wt, "base.txt"), "edited\n");
    expect(await worktreeAt(wt).isDirty()).toBe(true);
  });

  it("counts untracked files as dirty", async () => {
    const repo = await makeRepo(freshTmp());
    const wt = join(freshTmp(), "wt-cow-untracked-00000000");
    await addWorktree(repo, wt, "cow-untracked-00000000");

    writeFileSync(join(wt, "new.txt"), "untracked\n");
    expect(await worktreeAt(wt).isDirty()).toBe(true);
  });

  it("returns undefined when the path is not a worktree (probe fails)", async () => {
    expect(
      await worktreeAt(join(freshTmp(), "nope")).isDirty(),
    ).toBeUndefined();
  });
});

describe("GitWorktree.status", () => {
  it("returns the porcelain status, empty when clean", async () => {
    const repo = await makeRepo(freshTmp());
    const wt = join(freshTmp(), "wt-cow-status-00000000");
    await addWorktree(repo, wt, "cow-status-00000000");

    expect(await worktreeAt(wt).status()).toBe("");

    writeFileSync(join(wt, "base.txt"), "edited\n");
    expect(await worktreeAt(wt).status()).toBe("M base.txt");
  });

  it("returns undefined for a path that is not a worktree", async () => {
    expect(await worktreeAt(join(freshTmp(), "nope")).status()).toBeUndefined();
  });
});

describe("GitWorktree.remove", () => {
  it("removes the checkout from inside itself by default", async () => {
    const repo = await makeRepo(freshTmp());
    const wt = join(freshTmp(), "wt-cow-remove-00000000");
    await addWorktree(repo, wt, "cow-remove-00000000");

    await worktreeAt(wt).remove();

    expect(existsSync(wt)).toBe(false);
  });

  it("removes the checkout when the caller holds the main checkout instead", async () => {
    const repo = await makeRepo(freshTmp());
    const wt = join(freshTmp(), "wt-cow-remove-cwd-00000000");
    await addWorktree(repo, wt, "cow-remove-cwd-00000000");

    await worktreeAt(wt).remove(true, repo);

    expect(existsSync(wt)).toBe(false);
  });

  it("never throws for a checkout that is not there", async () => {
    const repo = await makeRepo(freshTmp());
    const never = join(freshTmp(), "wt-cow-ghost-00000000");

    await expect(worktreeAt(never).remove(true, repo)).resolves.toBeUndefined();
  });
});

describe("removeGitWorktree", () => {
  it("removes a linked worktree, best effort", async () => {
    const repo = await makeRepo(freshTmp());
    const wt = join(freshTmp(), "wt-cow-free-00000000");
    await addWorktree(repo, wt, "cow-free-00000000");

    await removeGitWorktree(realPi(), repo, wt);

    expect(existsSync(wt)).toBe(false);
  });

  it("resolves quietly for a worktree that was never created", async () => {
    const repo = await makeRepo(freshTmp());

    await expect(
      removeGitWorktree(realPi(), repo, join(freshTmp(), "wt-none")),
    ).resolves.toBeUndefined();
  });
});

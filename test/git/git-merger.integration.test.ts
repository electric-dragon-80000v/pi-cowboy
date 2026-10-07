/**
 * git-merger.integration.test.ts — Layer 3 branch lifecycle
 * (src/infrastructure/git/git-merger.ts).
 *
 * Guardrails against real repositories: merges run in the main checkout on the
 * target branch with a clean tree, are idempotent, and leave conflicts in
 * progress; branch cleanup never deletes an unmerged, checked-out, or foreign
 * branch.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ExtensionAPI,
  ExecOptions,
} from "@earendil-works/pi-coding-agent";
import type { AttachmentProbe } from "../../src/infrastructure/git/git-merger.js";
import {
  deleteWorktreeBranch,
  mergeBranchIntoTarget,
} from "../../src/infrastructure/git/git-merger.js";
import {
  addWorktree,
  cleanupTmpDirs,
  execFileAsync,
  freshTmp,
  git,
  gitPi,
  makeAgentBranch,
  makeRepo,
  realPi,
} from "../helpers/git-repo.js";
import { resolvedBin } from "../helpers/resolved-bin.js";

afterEach(cleanupTmpDirs);

describe("mergeBranchIntoTarget", () => {
  it("merges an agent branch into main", async () => {
    const repo = await makeRepo(freshTmp());
    await makeAgentBranch(repo, "cow-feature-abc12345", "feat.txt", "new\n");

    const result = await mergeBranchIntoTarget(realPi(), {
      cwd: repo,
      branch: "cow-feature-abc12345",
    });

    expect(result.merged).toBe(true);
    expect(result.target).toBe("main");
    expect(result.mainRoot).toBe(repo);
    expect(await git(["rev-parse", "--abbrev-ref", "HEAD"], repo)).toBe("main");
    expect(await git(["cat-file", "-e", "main:feat.txt"], repo)).toBe("");
  });

  it("merges the agent branch into main and reports the output", async () => {
    const repo = await makeRepo(freshTmp());
    await makeAgentBranch(
      repo,
      "cow-fix-login-flow-abc12345",
      "feat.txt",
      "new\n",
    );

    const result = await mergeBranchIntoTarget(gitPi(), {
      cwd: repo,
      branch: "cow-fix-login-flow-abc12345",
    });

    expect(result.merged).toBe(true);
    expect(result.target).toBe("main");
    expect(result.mainRoot).toBe(repo);
    expect(await git(["rev-parse", "--abbrev-ref", "HEAD"], repo)).toBe("main");
    expect(await git(["log", "--oneline", "-1"], repo)).toMatch(
      /cow-fix-login-flow-abc12345|Merge branch/,
    );
  });

  it("refuses to merge when the main checkout is on another branch", async () => {
    const repo = await makeRepo(freshTmp());
    await makeAgentBranch(repo, "cow-wrong-abc12345", "feat.txt", "new\n");
    await execFileAsync(
      resolvedBin("git"),
      ["checkout", "-q", "-b", "release"],
      {
        cwd: repo,
      },
    );

    await expect(
      mergeBranchIntoTarget(realPi(), {
        cwd: repo,
        branch: "cow-wrong-abc12345",
      }),
    ).rejects.toThrow(/is on branch "release", not the merge target "main"/);
  });

  it("refuses when the main checkout is on another branch (wrong-branch guard)", async () => {
    const repo = await makeRepo(freshTmp());
    await makeAgentBranch(repo, "cow-a7-09-aaaabbbb", "a709.txt", "x\n");
    const mainTip = await git(["rev-parse", "HEAD"], repo);
    await execFileAsync(
      resolvedBin("git"),
      ["checkout", "-qb", "fix/other-work"],
      {
        cwd: repo,
      },
    );

    await expect(
      mergeBranchIntoTarget(gitPi(), {
        cwd: repo,
        branch: "cow-a7-09-aaaabbbb",
      }),
    ).rejects.toThrow(
      /is on branch "fix\/other-work", not the merge target "main"/,
    );
    expect(await git(["rev-parse", "main"], repo)).toBe(mainTip);
    expect(await git(["rev-parse", "fix/other-work"], repo)).toBe(mainTip);
  });

  it("refuses to merge into a dirty main checkout", async () => {
    const repo = await makeRepo(freshTmp());
    await makeAgentBranch(repo, "cow-dirty-abc12345", "feat.txt", "new\n");
    writeFileSync(join(repo, "base.txt"), "dirty\n");

    await expect(
      mergeBranchIntoTarget(realPi(), {
        cwd: repo,
        branch: "cow-dirty-abc12345",
      }),
    ).rejects.toThrow(/has uncommitted changes/);
  });

  it("refuses when the target checkout is dirty", async () => {
    const repo = await makeRepo(freshTmp());
    await makeAgentBranch(repo, "cow-dirty-cccccccc", "feat.txt", "new\n");
    writeFileSync(join(repo, "base.txt"), "dirty\n");

    await expect(
      mergeBranchIntoTarget(gitPi(), {
        cwd: repo,
        branch: "cow-dirty-cccccccc",
      }),
    ).rejects.toThrow(/has uncommitted changes/);
  });

  it("refuses a missing branch", async () => {
    const repo = await makeRepo(freshTmp());
    await expect(
      mergeBranchIntoTarget(realPi(), {
        cwd: repo,
        branch: "cow-nope-00000000",
      }),
    ).rejects.toThrow(/does not exist/);
  });

  it("refuses an unknown branch", async () => {
    const repo = await makeRepo(freshTmp());

    await expect(
      mergeBranchIntoTarget(gitPi(), {
        cwd: repo,
        branch: "cow-nope-00000000",
      }),
    ).rejects.toThrow(/does not exist/);
  });

  it("refuses to merge a branch into itself", async () => {
    const repo = await makeRepo(freshTmp());

    await expect(
      mergeBranchIntoTarget(realPi(), { cwd: repo, branch: "main" }),
    ).rejects.toThrow(/refusing to merge "main" into itself/);
  });

  it("refuses to merge when the target checkout holds no branch (detached HEAD)", async () => {
    const repo = await makeRepo(freshTmp());
    await makeAgentBranch(repo, "cow-detached-abc12345", "feat.txt", "new\n");
    const head = await git(["rev-parse", "HEAD"], repo);
    await execFileAsync(resolvedBin("git"), ["checkout", "-q", head], {
      cwd: repo,
    });

    await expect(
      mergeBranchIntoTarget(realPi(), {
        cwd: repo,
        branch: "cow-detached-abc12345",
      }),
    ).rejects.toThrow(
      /is on branch "\(detached\)", not the merge target "main"/,
    );
  });

  it("refuses to merge from outside a git repository", async () => {
    await expect(
      mergeBranchIntoTarget(realPi(), {
        cwd: freshTmp(),
        branch: "cow-anywhere-00000000",
      }),
    ).rejects.toThrow(/is not inside a git repository/);
  });

  it("reports alreadyMerged without a second merge (full result shape)", async () => {
    const repo = await makeRepo(freshTmp());
    await makeAgentBranch(repo, "cow-once-abc12345", "feat.txt", "new\n");
    const first = await mergeBranchIntoTarget(realPi(), {
      cwd: repo,
      branch: "cow-once-abc12345",
    });
    expect(first.merged).toBe(true);

    const second = await mergeBranchIntoTarget(realPi(), {
      cwd: repo,
      branch: "cow-once-abc12345",
    });
    expect(second).toEqual({
      merged: false,
      alreadyMerged: true,
      target: "main",
      mainRoot: repo,
    });
  });

  it("reports already-merged without running a second merge", async () => {
    const repo = await makeRepo(freshTmp());
    await makeAgentBranch(repo, "cow-twice-dddddddd", "feat.txt", "new\n");
    const pi = gitPi();

    const first = await mergeBranchIntoTarget(pi, {
      cwd: repo,
      branch: "cow-twice-dddddddd",
    });
    expect(first.merged).toBe(true);

    const second = await mergeBranchIntoTarget(pi, {
      cwd: repo,
      branch: "cow-twice-dddddddd",
    });
    expect(second.merged).toBe(false);
    expect(second.alreadyMerged).toBe(true);
  });

  it("merges into a custom target when HEAD is there", async () => {
    const repo = await makeRepo(freshTmp());
    await execFileAsync(resolvedBin("git"), ["checkout", "-qb", "dev"], {
      cwd: repo,
    });
    await makeAgentBranch(repo, "cow-dev-eeeeeeee", "feat.txt", "new\n");
    await execFileAsync(resolvedBin("git"), ["checkout", "-q", "dev"], {
      cwd: repo,
    });

    const result = await mergeBranchIntoTarget(gitPi(), {
      cwd: repo,
      branch: "cow-dev-eeeeeeee",
      target: "dev",
    });
    expect(result.merged).toBe(true);
    expect(result.target).toBe("dev");
  });

  it("leaves a conflicted merge in progress and lists the files (UU status retained)", async () => {
    const repo = await makeRepo(freshTmp());
    await execFileAsync(
      resolvedBin("git"),
      ["checkout", "-qb", "cow-conflict-abc12345"],
      {
        cwd: repo,
      },
    );
    writeFileSync(join(repo, "base.txt"), "branch change\n");
    await execFileAsync(resolvedBin("git"), ["add", "-A"], { cwd: repo });
    await execFileAsync(
      resolvedBin("git"),
      ["commit", "-qm", "branch change"],
      {
        cwd: repo,
      },
    );
    await execFileAsync(resolvedBin("git"), ["checkout", "-q", "main"], {
      cwd: repo,
    });
    writeFileSync(join(repo, "base.txt"), "main change\n");
    await execFileAsync(resolvedBin("git"), ["add", "-A"], { cwd: repo });
    await execFileAsync(resolvedBin("git"), ["commit", "-qm", "main change"], {
      cwd: repo,
    });

    await expect(
      mergeBranchIntoTarget(realPi(), {
        cwd: repo,
        branch: "cow-conflict-abc12345",
      }),
    ).rejects.toThrow(/has conflicts in:\nbase\.txt/);
    expect(await git(["status", "--porcelain"], repo)).toContain("UU base.txt");
    await execFileAsync(resolvedBin("git"), ["merge", "--abort"], {
      cwd: repo,
    });
  });

  it("reports a conflict as a conflict when the file listing could not run", async () => {
    const repo = await makeRepo(freshTmp());
    await execFileAsync(
      resolvedBin("git"),
      ["checkout", "-qb", "cow-unlisted-abc12345"],
      { cwd: repo },
    );
    writeFileSync(join(repo, "base.txt"), "branch change\n");
    await execFileAsync(resolvedBin("git"), ["add", "-A"], { cwd: repo });
    await execFileAsync(
      resolvedBin("git"),
      ["commit", "-qm", "branch change"],
      {
        cwd: repo,
      },
    );
    await execFileAsync(resolvedBin("git"), ["checkout", "-q", "main"], {
      cwd: repo,
    });
    writeFileSync(join(repo, "base.txt"), "main change\n");
    await execFileAsync(resolvedBin("git"), ["add", "-A"], { cwd: repo });
    await execFileAsync(resolvedBin("git"), ["commit", "-qm", "main change"], {
      cwd: repo,
    });

    const inner = gitPi();
    const listingUnavailable = {
      exec: async (cmd: string, args: string[], opts?: ExecOptions) => {
        if (args[0] === "diff" && args.includes("--diff-filter=U")) {
          throw new Error("probe unavailable");
        }
        return inner.exec(cmd, args, opts);
      },
    } as unknown as ExtensionAPI;

    // The refusal keeps the conflict marker, and no newline after it, so a reader
    // that parses the file list finds none instead of a placeholder path.
    await expect(
      mergeBranchIntoTarget(listingUnavailable, {
        cwd: repo,
        branch: "cow-unlisted-abc12345",
      }),
    ).rejects.toThrow(
      /has conflicts in: \(the conflicting files could not be listed[^\n]*\)\n/,
    );
    expect(await git(["status", "--porcelain"], repo)).toContain("UU base.txt");
    await execFileAsync(resolvedBin("git"), ["merge", "--abort"], {
      cwd: repo,
    });
  });

  it("leaves a conflicted merge in progress with MERGE_HEAD present", async () => {
    const repo = await makeRepo(freshTmp());
    await execFileAsync(
      resolvedBin("git"),
      ["checkout", "-qb", "cow-conflict-ffffffff"],
      {
        cwd: repo,
      },
    );
    writeFileSync(join(repo, "base.txt"), "branch version\n");
    await execFileAsync(resolvedBin("git"), ["commit", "-qam", "branch side"], {
      cwd: repo,
    });
    await execFileAsync(resolvedBin("git"), ["checkout", "-q", "main"], {
      cwd: repo,
    });
    writeFileSync(join(repo, "base.txt"), "main version\n");
    await execFileAsync(resolvedBin("git"), ["commit", "-qam", "main side"], {
      cwd: repo,
    });

    await expect(
      mergeBranchIntoTarget(gitPi(), {
        cwd: repo,
        branch: "cow-conflict-ffffffff",
      }),
    ).rejects.toThrow(/has conflicts in:\nbase\.txt/);
    expect(await git(["rev-parse", "--verify", "MERGE_HEAD"], repo)).toMatch(
      /^[0-9a-f]{40}$/,
    );
    await execFileAsync(resolvedBin("git"), ["merge", "--abort"], {
      cwd: repo,
    });
  });

  it("merges from inside a linked worktree cwd (resolves the main checkout)", async () => {
    const repo = await makeRepo(freshTmp());
    const wt = join(freshTmp(), "wt-cow-inside-00000000");
    await addWorktree(repo, wt, "cow-inside-00000000");
    writeFileSync(join(wt, "from-wt.txt"), "wt work\n");
    await execFileAsync(resolvedBin("git"), ["add", "-A"], { cwd: wt });
    await execFileAsync(resolvedBin("git"), ["commit", "-qm", "wt work"], {
      cwd: wt,
    });

    const result = await mergeBranchIntoTarget(realPi(), {
      cwd: wt,
      branch: "cow-inside-00000000",
    });
    expect(result.merged).toBe(true);
    expect(result.mainRoot).toBe(repo);
  });

  it("resolves the main checkout when called from inside a worktree", async () => {
    const repo = await makeRepo(freshTmp());
    await makeAgentBranch(repo, "cow-from-wt-11111111", "feat.txt", "new\n");
    const wt = join(freshTmp(), "wt");
    await execFileAsync(
      resolvedBin("git"),
      ["worktree", "add", "-b", "cow-unrelated-22222222", wt, "HEAD"],
      { cwd: repo },
    );

    const result = await mergeBranchIntoTarget(gitPi(), {
      cwd: wt,
      branch: "cow-from-wt-11111111",
    });
    expect(result.merged).toBe(true);
    expect(result.mainRoot).toBe(repo);
    expect(await git(["rev-parse", "main"], repo)).toBe(
      await git(["rev-parse", "cow-from-wt-11111111"], repo),
    );
    await execFileAsync(
      resolvedBin("git"),
      ["worktree", "remove", "--force", wt],
      {
        cwd: repo,
      },
    );
  });
});

describe("deleteWorktreeBranch", () => {
  /** Injected attachment answer: whether a live placement still holds the checkout. */
  let checkoutHeldByBackend = "";
  const attached: AttachmentProbe = async (worktreePath) =>
    worktreePath === checkoutHeldByBackend;

  it("reports not-applicable for a branch that is not an extension branch", async () => {
    const repo = await makeRepo(freshTmp());
    await execFileAsync(resolvedBin("git"), ["branch", "feature"], {
      cwd: repo,
    });

    expect(
      await deleteWorktreeBranch(realPi(), {
        branch: "feature",
        worktreePath: join(repo, "..", "feature"),
        repoCwd: repo,
      }),
    ).toEqual({ kind: "not-applicable" });
    expect(await git(["branch", "--list", "feature"], repo)).toBe("feature");
  });

  it("deletes a merged cow- branch once the worktree is gone", async () => {
    const repo = await makeRepo(freshTmp());
    const wt = join(freshTmp(), "cow-merged-00000000");
    await addWorktree(repo, wt, "cow-merged-00000000");
    writeFileSync(join(wt, "base.txt"), "changed\n");
    await execFileAsync(resolvedBin("git"), ["add", "-A"], { cwd: wt });
    await execFileAsync(resolvedBin("git"), ["commit", "-qm", "wt work"], {
      cwd: wt,
    });
    await execFileAsync(
      resolvedBin("git"),
      ["merge", "--no-edit", "cow-merged-00000000"],
      {
        cwd: repo,
      },
    );
    await execFileAsync(
      resolvedBin("git"),
      ["worktree", "remove", "--force", wt],
      {
        cwd: repo,
      },
    );

    expect(
      await deleteWorktreeBranch(
        realPi(),
        { branch: "cow-merged-00000000", worktreePath: wt, repoCwd: repo },
        attached,
      ),
    ).toEqual({
      kind: "deleted",
    });
    expect(await git(["branch", "--list", "cow-merged-00000000"], repo)).toBe(
      "",
    );
  });

  it("keeps an unmerged branch", async () => {
    const repo = await makeRepo(freshTmp());
    const wt = join(freshTmp(), "cow-unmerged-00000000");
    await addWorktree(repo, wt, "cow-unmerged-00000000");
    writeFileSync(join(wt, "base.txt"), "changed\n");
    await execFileAsync(resolvedBin("git"), ["add", "-A"], { cwd: wt });
    await execFileAsync(resolvedBin("git"), ["commit", "-qm", "wt work"], {
      cwd: wt,
    });
    await execFileAsync(
      resolvedBin("git"),
      ["worktree", "remove", "--force", wt],
      {
        cwd: repo,
      },
    );

    expect(
      await deleteWorktreeBranch(
        realPi(),
        { branch: "cow-unmerged-00000000", worktreePath: wt, repoCwd: repo },
        attached,
      ),
    ).toEqual({
      kind: "kept",
      reason: "unmerged",
    });
    expect(await git(["branch", "--list", "cow-unmerged-00000000"], repo)).toBe(
      "cow-unmerged-00000000",
    );
  });

  it("keeps a branch whose checkout the backend still has attached", async () => {
    const repo = await makeRepo(freshTmp());
    const wt = join(freshTmp(), "cow-live-00000000");
    await addWorktree(repo, wt, "cow-live-00000000");
    checkoutHeldByBackend = wt;

    expect(
      await deleteWorktreeBranch(
        realPi(),
        { branch: "cow-live-00000000", worktreePath: wt, repoCwd: repo },
        attached,
      ),
    ).toEqual({
      kind: "kept",
      reason: "checked-out",
    });
    expect(
      await git(["branch", "--list", "cow-live-00000000"], repo),
    ).toContain("cow-live-00000000");
  });

  it("reports not-applicable when the branch ref does not exist", async () => {
    const repo = await makeRepo(freshTmp());
    expect(
      await deleteWorktreeBranch(
        realPi(),
        {
          branch: "cow-ghost-00000000",
          worktreePath: join(freshTmp(), "wt-cow-ghost-00000000"),
          repoCwd: repo,
        },
        attached,
      ),
    ).toEqual({ kind: "not-applicable" });
  });
});

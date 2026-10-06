/**
 * git-materializer.cow.integration.test.ts — Layer 3 copy-on-write
 * materialization (src/infrastructure/git/git-materializer.ts) on a volume that
 * really clones. Runs only in the `integration-cow` project; the checkout
 * strategy, the guard cases, and the injected-fake fallback stay in
 * git-materializer.integration.test.ts.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cowCloneWorktree,
  materializeWorktree,
  worktreeAddArgs,
  type CowCloneResult,
  type WorktreeMaterializationOutcome,
} from "../../src/infrastructure/git/git-materializer.js";
import type { WorktreeMaterialization } from "../../src/spawn/worktree-policy.js";
import {
  addWorktree,
  cleanupTmpDirs,
  execFileAsync,
  freshTmp,
  git,
  gitStatus,
  makeCleanRepo,
  makeRepo,
  realPi,
} from "../helpers/git-repo.js";
import { resolvedBin } from "../helpers/resolved-bin.js";

afterEach(cleanupTmpDirs);

/**
 * The clone result of a materialization that cloned. Anything else — a fallback
 * or a plain checkout — is a failure these tests did not ask for.
 */
function cloned(result: WorktreeMaterializationOutcome): CowCloneResult {
  if (result.kind !== "cow") {
    throw new Error(`expected a copy-on-write clone, got "${result.kind}"`);
  }
  return result.clone;
}

describe("cowCloneWorktree", () => {
  it("replaces a fresh worktree with a CoW clone when the main checkout is clean", async () => {
    const t = freshTmp();
    const repo = await makeCleanRepo(t);
    const wt = join(t, "wt");
    await addWorktree(repo, wt, "cow-cow-e2e");

    const result = await cowCloneWorktree(realPi(), wt);

    expect(cloned(result).mode).toBe("cow");
    expect(cloned(result).reason).toBeUndefined();

    expect(readFileSync(join(wt, ".git"), "utf8")).toMatch(/^gitdir:/);
    expect(await gitStatus(wt)).toBe("");

    expect(readFileSync(join(wt, "tracked.txt"), "utf8")).toBe("hello\n");
    expect(readFileSync(join(wt, "src", "lib.ts"), "utf8")).toBe(
      "export const x = 1;\n",
    );

    expect(readFileSync(join(wt, "node_modules", "dep.txt"), "utf8")).toBe(
      "dep\n",
    );
    expect(readFileSync(join(wt, ".env"), "utf8")).toBe("SECRET=1\n");

    expect(await gitStatus(repo)).toBe("");
    expect(readFileSync(join(repo, "tracked.txt"), "utf8")).toBe("hello\n");
  });

  it("CoW-clones a clean main checkout into a --no-checkout worktree", async () => {
    const t = freshTmp();
    const repo = await makeRepo(t);
    const wt = join(t, "wt-cow-00000000");
    await execFileAsync(
      resolvedBin("git"),
      ["worktree", "add", "--no-checkout", "-b", "cow-cow-00000000", wt],
      {
        cwd: repo,
      },
    );

    const result = await cowCloneWorktree(realPi(), wt);

    expect(cloned(result).mode).toBe("cow");
    expect(cloned(result).reason).toBeUndefined();
    expect(await git(["status", "--porcelain"], wt)).toBe("");
    expect(await git(["rev-parse", "--abbrev-ref", "HEAD"], wt)).toBe(
      "cow-cow-00000000",
    );
  });

  it("carries a dirty main checkout's tracked edits and untracked files into the worktree under the dirty policy", async () => {
    const t = freshTmp();
    const repo = await makeCleanRepo(t);
    writeFileSync(join(repo, "tracked.txt"), "changed in main\n");
    writeFileSync(join(repo, "brand-new.txt"), "untracked\n");

    const wt = join(t, "wt");
    await addWorktree(repo, wt, "cow-cow-e2e");

    const result = await cowCloneWorktree(realPi(), wt, "dirty");

    // The dirty policy imports the parent's WIP, so the worktree starts dirty.
    expect(cloned(result).mode).toBe("cow");
    expect(cloned(result).reason).toContain("uncommitted changes");

    expect(readFileSync(join(wt, "tracked.txt"), "utf8")).toBe(
      "changed in main\n",
    );
    expect(readFileSync(join(wt, "brand-new.txt"), "utf8")).toBe("untracked\n");
    expect(await gitStatus(wt)).toBe(await gitStatus(repo));

    // Ignored state rides along as before.
    expect(readFileSync(join(wt, "node_modules", "dep.txt"), "utf8")).toBe(
      "dep\n",
    );
    expect(readFileSync(join(wt, ".env"), "utf8")).toBe("SECRET=1\n");
  });

  it("carries the parent's WIP into a --no-checkout worktree under the dirty policy", async () => {
    const t = freshTmp();
    const repo = await makeRepo(t);
    writeFileSync(join(repo, "base.txt"), "changed in main\n");
    writeFileSync(join(repo, "brand-new.txt"), "untracked\n");
    const wt = join(t, "wt-clone-00000000");
    await execFileAsync(
      resolvedBin("git"),
      ["worktree", "add", "--no-checkout", "-b", "cow-clone-00000000", wt],
      {
        cwd: repo,
      },
    );

    const result = await cowCloneWorktree(realPi(), wt, "dirty");

    expect(cloned(result).mode).toBe("cow");
    expect(cloned(result).reason).toContain("uncommitted changes");
    expect(readFileSync(join(wt, "base.txt"), "utf8")).toBe(
      "changed in main\n",
    );
    expect(readFileSync(join(wt, "brand-new.txt"), "utf8")).toBe("untracked\n");
    expect(await gitStatus(wt)).toBe(await gitStatus(repo));
  });

  it("carries a dirty parent's WIP into a worktree rooted inside the repo under the dirty policy", async () => {
    const t = freshTmp();
    // Canonicalize: git reports the physical path (macOS /var -> /private/var),
    // and this case compares the worktree path against the main checkout's.
    const repo = realpathSync(await makeCleanRepo(t));
    writeFileSync(join(repo, "tracked.txt"), "changed in main\n");
    writeFileSync(join(repo, "brand-new.txt"), "untracked\n");

    // A worktreeRoot relative to the repo root puts the worktree inside the
    // parent checkout, where the parent reports it as an untracked directory the
    // clone deliberately never carries.
    const wt = join(repo, "worktrees", "cow-inrepo-00000000");
    await addWorktree(repo, wt, "cow-inrepo-00000000");
    expect(
      await git(["ls-files", "--others", "--exclude-standard"], repo),
    ).toContain("worktrees/cow-inrepo-00000000/");

    const result = await cowCloneWorktree(realPi(), wt, "dirty");

    expect(cloned(result).mode).toBe("cow");
    expect(cloned(result).reason).toContain("uncommitted changes");
    expect(readFileSync(join(wt, "tracked.txt"), "utf8")).toBe(
      "changed in main\n",
    );
    expect(readFileSync(join(wt, "brand-new.txt"), "utf8")).toBe("untracked\n");

    // The worktree's own directory is not part of what it can carry: its status
    // is the parent's, minus that one entry.
    const statusOf = async (cwd: string): Promise<string> =>
      (
        await realPi().exec("git", ["status", "--porcelain"], {
          cwd,
        })
      ).stdout;
    const parentStatus = await statusOf(repo);
    expect(parentStatus).toContain("?? worktrees/");
    expect(await statusOf(wt)).toBe(
      parentStatus.replace("?? worktrees/\n", ""),
    );
  });

  it("leaves a dirty main checkout's changes out when the dirty-checkout policy is clean", async () => {
    const t = freshTmp();
    const repo = await makeCleanRepo(t);
    writeFileSync(join(repo, "tracked.txt"), "changed in main\n");
    writeFileSync(join(repo, "brand-new.txt"), "untracked\n");

    const wt = join(t, "wt");
    await addWorktree(repo, wt, "cow-clean-e2e");

    const result = await cowCloneWorktree(realPi(), wt, "clean");

    // Clean policy: the parent's tracked edits and untracked files stay out.
    expect(cloned(result).mode).toBe("seeded");
    expect(cloned(result).reason).toContain("uncommitted changes");

    expect(await gitStatus(wt)).toBe("");
    expect(readFileSync(join(wt, "tracked.txt"), "utf8")).toBe("hello\n");
    expect(existsSync(join(wt, "brand-new.txt"))).toBe(false);

    // Ignored state is still seeded.
    expect(readFileSync(join(wt, "node_modules", "dep.txt"), "utf8")).toBe(
      "dep\n",
    );
    expect(readFileSync(join(wt, ".env"), "utf8")).toBe("SECRET=1\n");
  });

  it("leaves a dirty main checkout's changes out under the default policy", async () => {
    const t = freshTmp();
    const repo = await makeCleanRepo(t);
    writeFileSync(join(repo, "tracked.txt"), "changed in main\n");
    writeFileSync(join(repo, "brand-new.txt"), "untracked\n");

    const wt = join(t, "wt");
    await addWorktree(repo, wt, "cow-default-e2e");

    const result = await cowCloneWorktree(realPi(), wt);

    // The default is clean: the parent's tracked edits and untracked files stay out.
    expect(cloned(result).mode).toBe("seeded");
    expect(cloned(result).reason).toContain("uncommitted changes");

    expect(await gitStatus(wt)).toBe("");
    expect(readFileSync(join(wt, "tracked.txt"), "utf8")).toBe("hello\n");
    expect(existsSync(join(wt, "brand-new.txt"))).toBe(false);

    // Ignored state is still seeded.
    expect(readFileSync(join(wt, "node_modules", "dep.txt"), "utf8")).toBe(
      "dep\n",
    );
    expect(readFileSync(join(wt, ".env"), "utf8")).toBe("SECRET=1\n");
  });

  it("seeds ignored state when a --no-checkout worktree meets a dirty main under the clean policy", async () => {
    const t = freshTmp();
    const repo = await makeRepo(t);
    writeFileSync(join(repo, "base.txt"), "changed in main\n");
    const wt = join(t, "wt-clean-00000000");
    await execFileAsync(
      resolvedBin("git"),
      ["worktree", "add", "--no-checkout", "-b", "cow-clean-00000000", wt],
      {
        cwd: repo,
      },
    );

    const result = await cowCloneWorktree(realPi(), wt, "clean");

    expect(cloned(result).mode).toBe("seeded");
    expect(cloned(result).reason).toContain("uncommitted changes");
    expect(await git(["status", "--porcelain"], wt)).toBe("");
  });
});

/** The clone strategy, whose outcome is asserted against a real cloned volume. */
const MATERIALIZATIONS: readonly WorktreeMaterialization[] = ["copy-on-write"];

describe.each(MATERIALIZATIONS)("materializeWorktree (%s)", (strategy) => {
  it("populates the worktree per the strategy and reports a tagged outcome", async () => {
    const t = freshTmp();
    const repo = await makeRepo(t);
    writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-qm", "ignore node_modules"], repo);
    mkdirSync(join(repo, "node_modules"));
    writeFileSync(join(repo, "node_modules", "dep.txt"), "dep\n");

    const branch = `cow-${strategy}-00000000`;
    const wt = join(t, `wt-${strategy}-00000000`);
    // Same add-argument pairing production uses.
    await execFileAsync(
      resolvedBin("git"),
      ["worktree", "add", ...worktreeAddArgs(strategy), "-b", branch, wt],
      { cwd: repo },
    );

    const calls: string[][] = [];
    const result = await materializeWorktree(realPi(calls), wt, strategy);

    expect(await git(["status", "--porcelain"], wt)).toBe("");
    expect(await git(["rev-parse", "--abbrev-ref", "HEAD"], wt)).toBe(branch);
    expect(readFileSync(join(wt, "base.txt"), "utf8")).toBe("base\n");
    expect(await git(["status", "--porcelain"], repo)).toBe("");

    expect(result).toEqual({ kind: "cow", clone: { mode: "cow" } });
    // The clone ran through pi.exec, as the file-copy helpers it uses are not git.
    expect(
      calls.some(([cmd]) => cmd.endsWith("/python3") || cmd.endsWith("/cp")),
    ).toBe(true);
    expect(readFileSync(join(wt, "node_modules", "dep.txt"), "utf8")).toBe(
      "dep\n",
    );
  });
});

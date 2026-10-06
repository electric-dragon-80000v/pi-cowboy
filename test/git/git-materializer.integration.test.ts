/**
 * git-materializer.integration.test.ts — Layer 3 worktree materialization
 * (src/infrastructure/git/git-materializer.ts) that holds on any volume: the
 * add-argument pairing, the ignored-seed parsing, the guard cases, the fallback
 * a non-clone volume takes, and the strategy-parametrized suite below, which runs
 * whichever materialization this volume can honor. What only a clone can show —
 * the clone itself, and the seeding a clean policy does — stays in
 * git-materializer.cow.integration.test.ts.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cowCloneWorktree,
  ignoredSeedPaths,
  materializeWorktree,
  worktreeAddArgs,
  type CowCloneResult,
  type WorktreeMaterializationOutcome,
} from "../../src/infrastructure/git/git-materializer.js";
import { GitError } from "../../src/infrastructure/git/git-runner.js";
import { detectCowAvailability } from "../../src/spawn/cow-support.js";
import type { WorktreeMaterialization } from "../../src/spawn/worktree-policy.js";
import {
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

describe("worktreeAddArgs", () => {
  it("asks for --no-checkout only when the strategy materializes the tree itself", () => {
    expect(worktreeAddArgs("copy-on-write")).toEqual(["--no-checkout"]);
    expect(worktreeAddArgs("checkout")).toEqual([]);
  });
});

describe("ignoredSeedPaths", () => {
  it("keeps only the ignored (!!) entries", () => {
    expect(
      ignoredSeedPaths([
        "!! node_modules/",
        "?? brand-new.txt",
        " M tracked.txt",
        "A  staged.txt",
        "!! .env",
      ]),
    ).toEqual(["node_modules/", ".env"]);
  });

  it("drops empty entries, the NUL-split tail included", () => {
    expect(ignoredSeedPaths(["!! .env", "", "!! "])).toEqual([".env"]);
  });

  it("skips paths containing a newline (the seed list is newline-separated)", () => {
    expect(ignoredSeedPaths(["!! odd\nname", "!! fine"])).toEqual(["fine"]);
  });
});

// The guard cases reject before the cloner runs, so they hold on any volume.
describe("cowCloneWorktree", () => {
  it("throws on a directory that is not a git worktree", async () => {
    const t = freshTmp();
    const plain = join(t, "plain");
    mkdirSync(plain);

    await expect(cowCloneWorktree(realPi(), plain)).rejects.toThrow(
      /copy-on-write worktree materialization failed/,
    );
  });

  it("throws a GitError on a plain directory and never wipes it", async () => {
    const t = freshTmp();
    const plain = join(t, "plain");
    mkdirSync(plain);
    writeFileSync(join(plain, "file.txt"), "x\n");

    await expect(cowCloneWorktree(realPi(), plain)).rejects.toBeInstanceOf(
      GitError,
    );
    expect(readFileSync(join(plain, "file.txt"), "utf8")).toBe("x\n");
  });

  it("throws when handed the main checkout itself, and never touches it", async () => {
    const t = freshTmp();
    const repo = await makeCleanRepo(t);

    await expect(cowCloneWorktree(realPi(), repo)).rejects.toBeInstanceOf(
      GitError,
    );
    expect(await gitStatus(repo)).toBe("");
    expect(readFileSync(join(repo, "tracked.txt"), "utf8")).toBe("hello\n");
    expect(readFileSync(join(repo, "node_modules", "dep.txt"), "utf8")).toBe(
      "dep\n",
    );
  });
});

/**
 * The materializations this volume can honor, from the project's own probe. The
 * suite below runs whichever branch the filesystem supports, so one place covers
 * both: a volume that really clones (the btrfs CI job) runs the copy-on-write
 * branch, and every other volume — the ext4 CI job included — runs the checkout
 * branch, which is what makes that job exercise checkout for real.
 */
async function materializationsThisVolumeSupports(): Promise<
  readonly WorktreeMaterialization[]
> {
  const availability = await detectCowAvailability(
    (command, args, options) => realPi().exec(command, args, options),
    freshTmp("materializer-probe-"),
  );
  const clones =
    availability.status === "known" &&
    availability.available.has("copy-on-write");
  return clones ? ["copy-on-write"] : ["checkout"];
}

/** The clone result of a materialization that cloned; any other outcome is a failure. */
function cloneResult(result: WorktreeMaterializationOutcome): CowCloneResult {
  if (result.kind !== "cow") {
    throw new Error(`expected a copy-on-write clone, got "${result.kind}"`);
  }
  return result.clone;
}

const MATERIALIZATIONS = await materializationsThisVolumeSupports();

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

    // Kind-agnostic: a worktree at the requested branch, its tracked files at
    // HEAD, and a parent nobody touched.
    expect(await git(["status", "--porcelain"], wt)).toBe("");
    expect(await git(["rev-parse", "--abbrev-ref", "HEAD"], wt)).toBe(branch);
    expect(readFileSync(join(wt, "base.txt"), "utf8")).toBe("base\n");
    expect(await git(["status", "--porcelain"], repo)).toBe("");

    if (strategy === "copy-on-write") {
      // The clone ran through pi.exec, as the file-copy helpers it uses are not git.
      expect(cloneResult(result)).toEqual({ mode: "cow" });
      expect(
        calls.some(([cmd]) => cmd.endsWith("/python3") || cmd.endsWith("/cp")),
      ).toBe(true);
      expect(readFileSync(join(wt, "node_modules", "dep.txt"), "utf8")).toBe(
        "dep\n",
      );
    } else {
      expect(result).toEqual({ kind: "checkout" });
      // A plain checkout runs no file-copy helpers, and shares no ignored state.
      expect(
        calls.some(([cmd]) => cmd.endsWith("/python3") || cmd.endsWith("/cp")),
      ).toBe(false);
      expect(existsSync(join(wt, "node_modules", "dep.txt"))).toBe(false);
    }
  });

  it("carries the main checkout's tracked work under the dirty policy", async () => {
    const t = freshTmp();
    const repo = await makeRepo(t);
    // One tracked file modified, one deleted, one untracked: the three shapes
    // the policy has to rule on.
    writeFileSync(join(repo, "extra.txt"), "extra\n");
    await git(["add", "extra.txt"], repo);
    await git(["commit", "-qm", "add extra"], repo);
    writeFileSync(join(repo, "base.txt"), "changed in main\n");
    rmSync(join(repo, "extra.txt"));
    writeFileSync(join(repo, "brand-new.txt"), "untracked\n");

    const branch = `cow-${strategy}-dirty`;
    const wt = join(t, `wt-${strategy}-dirty`);
    await execFileAsync(
      resolvedBin("git"),
      ["worktree", "add", ...worktreeAddArgs(strategy), "-b", branch, wt],
      { cwd: repo },
    );

    const before = await gitStatus(repo);
    const result = await materializeWorktree(realPi(), wt, strategy, "dirty");

    // Kind-agnostic: the tracked side arrives whole — the modification and the
    // deletion alike — and the parent is never touched on the way through.
    expect(readFileSync(join(wt, "base.txt"), "utf8")).toBe(
      "changed in main\n",
    );
    expect(existsSync(join(wt, "extra.txt"))).toBe(false);
    expect(await git(["diff", "HEAD", "--name-only"], wt)).toBe(
      await git(["diff", "HEAD", "--name-only"], repo),
    );
    expect(before).not.toBe("");
    expect(await gitStatus(repo)).toBe(before);

    if (strategy === "copy-on-write") {
      // The whole working tree was cloned, so the untracked file rode along.
      expect(readFileSync(join(wt, "brand-new.txt"), "utf8")).toBe(
        "untracked\n",
      );
      expect(cloneResult(result).mode).toBe("cow");
      expect(cloneResult(result).reason).toContain("uncommitted changes");
    } else {
      // The checkout materialization carries tracked changes only, so nothing
      // untracked may appear in the worktree.
      expect(existsSync(join(wt, "brand-new.txt"))).toBe(false);
      expect(result).toEqual({ kind: "checkout" });
      const wtStatus = await gitStatus(wt);
      expect(wtStatus).toContain("M base.txt");
      expect(wtStatus).toContain("D extra.txt");
      expect(wtStatus).not.toContain("brand-new");
    }
  });

  it("leaves the main checkout's work out under the clean policy", async () => {
    const t = freshTmp();
    const repo = await makeRepo(t);
    writeFileSync(join(repo, "base.txt"), "changed in main\n");
    writeFileSync(join(repo, "brand-new.txt"), "untracked\n");

    const branch = `cow-${strategy}-clean`;
    const wt = join(t, `wt-${strategy}-clean`);
    await execFileAsync(
      resolvedBin("git"),
      ["worktree", "add", ...worktreeAddArgs(strategy), "-b", branch, wt],
      { cwd: repo },
    );

    const result = await materializeWorktree(realPi(), wt, strategy, "clean");

    // Kind-agnostic: a worktree sitting clean at HEAD, with the parent's edits
    // left where they are, and nothing untracked copied in.
    expect(await gitStatus(wt)).toBe("");
    expect(readFileSync(join(wt, "base.txt"), "utf8")).toBe("base\n");
    expect(existsSync(join(wt, "brand-new.txt"))).toBe(false);

    if (strategy === "copy-on-write") {
      expect(cloneResult(result).mode).toBe("seeded");
      expect(cloneResult(result).reason).toContain('"clean"');
    } else {
      expect(result).toEqual({ kind: "checkout" });
    }
  });
});

/**
 * The checkout strategy takes its path on every volume, so these run everywhere
 * rather than under the volume probe: neither one clones.
 */
describe("materializeWorktree (checkout)", () => {
  it("carries nothing when the dirty parent's changes are all untracked", async () => {
    const t = freshTmp();
    const repo = await makeRepo(t);
    // Nothing tracked differs from HEAD, so there is no patch to apply.
    writeFileSync(join(repo, "brand-new.txt"), "untracked\n");

    const wt = join(t, "wt-untracked-only");
    await execFileAsync(
      resolvedBin("git"),
      ["worktree", "add", "-b", "cow-untracked-only", wt],
      { cwd: repo },
    );

    const result = await materializeWorktree(realPi(), wt, "checkout", "dirty");

    expect(result).toEqual({ kind: "checkout" });
    expect(existsSync(join(wt, "brand-new.txt"))).toBe(false);
    expect(await gitStatus(wt)).toBe("");
  });

  it("fails the materialization when the parent's tracked changes cannot be applied", async () => {
    const t = freshTmp();
    const repo = await makeRepo(t);
    writeFileSync(join(repo, "base.txt"), "changed in main\n");

    const wt = join(t, "wt-conflict");
    await execFileAsync(
      resolvedBin("git"),
      ["worktree", "add", "-b", "cow-conflict", wt],
      { cwd: repo },
    );
    // Something already wrote to the worktree, so the parent's patch no longer
    // applies: a half-applied tree is the failure mode, and it fails instead.
    writeFileSync(join(wt, "base.txt"), "conflicting\n");

    await expect(
      materializeWorktree(realPi(), wt, "checkout", "dirty"),
    ).rejects.toThrow(/checkout worktree materialization failed/);
    // The parent is never touched on the way through.
    expect(readFileSync(join(repo, "base.txt"), "utf8")).toBe(
      "changed in main\n",
    );
  });
});

describe("copy-on-write fallback", () => {
  it("completes the checkout with git when the volume cannot clone", async () => {
    const t = freshTmp();
    const repo = await makeCleanRepo(t);
    const wt = join(t, "wt");
    // The copy-on-write path adds with --no-checkout, so git lays nothing down.
    await execFileAsync(
      resolvedBin("git"),
      ["worktree", "add", "--no-checkout", "-b", "cow-fallback", wt],
      { cwd: repo },
    );
    expect(existsSync(join(wt, "tracked.txt"))).toBe(false);

    // A volume where everything but git fails: the probe's clone and every
    // entry's clone alike, which is what an ext4 machine looks like.
    const base = realPi();
    const noCow = {
      ...base,
      exec: async (
        cmd: string,
        args: string[],
        opts?: { cwd?: string; timeout?: number },
      ) =>
        basename(cmd) === "git"
          ? base.exec(cmd, args, opts)
          : {
              code: 1,
              stdout: "",
              stderr: "clone failed: not supported",
              killed: false,
            },
    };

    const result = await materializeWorktree(
      noCow,
      wt,
      "copy-on-write",
      "clean",
    );

    expect(result).toEqual({
      kind: "cow-fallback",
      reason: expect.stringContaining("cannot clone"),
    });
    expect(readFileSync(join(wt, "tracked.txt"), "utf8")).toBe("hello\n");
    expect(readFileSync(join(wt, "src", "lib.ts"), "utf8")).toBe(
      "export const x = 1;\n",
    );
    // A plain checkout shares nothing with the parent.
    expect(existsSync(join(wt, "node_modules", "dep.txt"))).toBe(false);
    expect(existsSync(join(wt, ".env"))).toBe(false);
    expect(await gitStatus(wt)).toBe("");
    expect(await git(["rev-parse", "--abbrev-ref", "HEAD"], wt)).toBe(
      "cow-fallback",
    );
    // The parent is never touched on the way through.
    expect(await gitStatus(repo)).toBe("");
  });
});

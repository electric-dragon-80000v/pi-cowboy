/**
 * git-materializer.integration.test.ts — Layer 3 worktree materialization
 * (src/infrastructure/git/git-materializer.ts) that holds on any volume: the
 * add-argument pairing, the ignored-seed parsing, the checkout strategy, the
 * guard cases, and the fallback a non-clone volume takes. The copy-on-write
 * strategy's clone is asserted on a clone-capable volume in
 * git-materializer.cow.integration.test.ts.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cowCloneWorktree,
  ignoredSeedPaths,
  materializeWorktree,
  worktreeAddArgs,
} from "../../src/infrastructure/git/git-materializer.js";
import { GitError } from "../../src/infrastructure/git/git-runner.js";
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

/** The strategy whose outcome needs no clone-capable volume. */
const MATERIALIZATIONS: readonly WorktreeMaterialization[] = ["checkout"];

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

    expect(result).toEqual({ kind: "checkout" });
    // A plain checkout runs no file-copy helpers.
    expect(
      calls.some(([cmd]) => cmd.endsWith("/python3") || cmd.endsWith("/cp")),
    ).toBe(false);
    expect(existsSync(join(wt, "node_modules", "dep.txt"))).toBe(false);
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

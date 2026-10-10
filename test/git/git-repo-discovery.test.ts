/**
 * git-repo-discovery.test.ts — `isInsideGitRepository`, the boot-time repo check.
 *
 * Filesystem-only on purpose: a `.git` entry in an ancestor decides, so a git
 * that cannot answer is never read as "not a repository". Pins the walk-up,
 * both `.git` shapes (a directory and a linked worktree's file), and git's
 * environment being ignored.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isInsideGitRepository } from "../../src/infrastructure/git-client.js";

const dirs: string[] = [];

/** A fresh temp dir, removed after the test. */
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "repo-discovery-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("isInsideGitRepository", () => {
  it("finds a `.git` directory in the cwd itself", () => {
    const dir = tmp();
    mkdirSync(join(dir, ".git"));

    expect(isInsideGitRepository(dir)).toBe(true);
  });

  it("finds a `.git` directory in an ancestor", () => {
    const dir = tmp();
    mkdirSync(join(dir, ".git"));
    const nested = join(dir, "src", "deep");
    mkdirSync(nested, { recursive: true });

    expect(isInsideGitRepository(nested)).toBe(true);
  });

  it("counts a linked worktree's `.git` file", () => {
    const dir = tmp();
    writeFileSync(join(dir, ".git"), "gitdir: /elsewhere/.git/worktrees/wt\n");

    expect(isInsideGitRepository(dir)).toBe(true);
  });

  it("is false when no ancestor holds a `.git`", () => {
    const dir = tmp();
    mkdirSync(join(dir, "src"));

    expect(isInsideGitRepository(join(dir, "src"))).toBe(false);
  });

  it("answers from the filesystem even when git's environment points elsewhere", () => {
    const dir = tmp();
    mkdirSync(join(dir, ".git"));
    const saved = process.env.GIT_DIR;
    process.env.GIT_DIR = join(dir, "no-such-git-dir");
    try {
      expect(isInsideGitRepository(dir)).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = saved;
    }
  });
});

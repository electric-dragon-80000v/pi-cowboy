/**
 * cow-clone.cow.integration.test.ts — the real materialization on a volume that
 * really clones: a real git worktree, the real `python3` clonefile call (macOS)
 * and the real FICLONE copy (Linux). These assert a clone, so they run only in
 * the `integration-cow` project (a btrfs loop device in CI); the fake-cloner
 * contract lives in cow-clone.test.ts, and the budget case that holds on any
 * volume stays in cow-clone.integration.test.ts.
 */

import { spawn } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  defaultCowCloneDeps,
  materializeCowClone,
  type ExecLike,
} from "../src/infrastructure/git/cow-clone.js";
import {
  addWorktree,
  cleanupTmpDirs,
  freshTmp,
  gitStatus,
  makeCleanRepo,
} from "./helpers/git-repo.js";

afterEach(cleanupTmpDirs);

/**
 * The slice of `pi.exec` the materializer runs through, over real child
 * processes — including its quirk of reporting a killed child as code 0.
 */
const testExec: ExecLike = (command, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options?.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let killed = false;
    const timer = options?.timeout
      ? setTimeout(() => {
          killed = true;
          child.kill("SIGKILL");
        }, options.timeout)
      : undefined;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 0, stdout, stderr, killed });
    });
  });

describe("materializeCowClone", () => {
  it("clones a clean main checkout into a fresh worktree, CoW and atomically", async () => {
    const t = freshTmp();
    const repo = await makeCleanRepo(t);
    symlinkSync("dep.txt", join(repo, "node_modules", "link.txt"));
    const wt = join(t, "wt");
    await addWorktree(repo, wt, "cow-cow-node-00000000");

    const result = await materializeCowClone(
      { wtPath: wt, mainRoot: repo },
      { kind: "all" },
      defaultCowCloneDeps(testExec),
    );

    // One clonefile call per entry on macOS; Linux reflinks entry by entry.
    expect(result.mechanism).toBe(
      process.platform === "darwin" ? "clonefile" : "reflink",
    );

    // The wipe kept the worktree's own .git link.
    expect(readFileSync(join(wt, ".git"), "utf8")).toMatch(/^gitdir:/);

    expect(readFileSync(join(wt, "tracked.txt"), "utf8")).toBe("hello\n");
    expect(readFileSync(join(wt, "src", "lib.ts"), "utf8")).toBe(
      "export const x = 1;\n",
    );
    expect(readFileSync(join(wt, "node_modules", "dep.txt"), "utf8")).toBe(
      "dep\n",
    );
    expect(readFileSync(join(wt, ".env"), "utf8")).toBe("SECRET=1\n");
    // Cloned, not followed: the link still points at its sibling.
    expect(readlinkSync(join(wt, "node_modules", "link.txt"))).toBe("dep.txt");

    expect(await gitStatus(wt)).toBe("");
    expect(await gitStatus(repo)).toBe("");
  });

  it("seeds ignored state without importing the parent's uncommitted work", async () => {
    const t = freshTmp();
    const repo = await makeCleanRepo(t);
    const wt = join(t, "wt");
    await addWorktree(repo, wt, "cow-cow-node-seed");
    writeFileSync(join(repo, "tracked.txt"), "changed in main\n");
    writeFileSync(join(repo, "brand-new.txt"), "untracked\n");

    const result = await materializeCowClone(
      { wtPath: wt, mainRoot: repo },
      { kind: "seed", rels: ["node_modules", ".env"] },
      defaultCowCloneDeps(testExec),
    );

    expect(result.mechanism).toBe(
      process.platform === "darwin" ? "clonefile" : "reflink",
    );

    // Tracked files stay as git checked them out; the parent's edits stay out.
    expect(readFileSync(join(wt, "tracked.txt"), "utf8")).toBe("hello\n");
    expect(existsSync(join(wt, "brand-new.txt"))).toBe(false);

    expect(readFileSync(join(wt, "node_modules", "dep.txt"), "utf8")).toBe(
      "dep\n",
    );
    expect(readFileSync(join(wt, ".env"), "utf8")).toBe("SECRET=1\n");
    expect(await gitStatus(wt)).toBe("");
  });
});

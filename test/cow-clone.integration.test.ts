/**
 * cow-clone.integration.test.ts — the real materialization's filesystem-
 * independent case: a real git worktree and the real cloner over real child
 * processes, where the clone is expected to give up on its budget. The clone
 * itself is asserted only on a clone-capable volume, in
 * cow-clone.cow.integration.test.ts; the fake-cloner contract lives in
 * cow-clone.test.ts.
 */

import { spawn } from "node:child_process";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CowCloneError,
  defaultCowCloneDeps,
  materializeCowClone,
  type ExecLike,
} from "../src/infrastructure/git/cow-clone.js";
import {
  addWorktree,
  cleanupTmpDirs,
  freshTmp,
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
  it("gives up on a clone that outlives its budget", async () => {
    if (process.platform !== "darwin") return; // the child cloner is macOS-only
    const t = freshTmp();
    const repo = await makeCleanRepo(t);
    const wt = join(t, "wt");
    await addWorktree(repo, wt, "cow-cow-node-timeout");

    const error = await materializeCowClone(
      { wtPath: wt, mainRoot: repo },
      { kind: "seed", rels: ["node_modules"] },
      defaultCowCloneDeps(testExec, 1),
    ).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(CowCloneError);
    expect((error as CowCloneError).reason).toBe("timeout");
  });
});

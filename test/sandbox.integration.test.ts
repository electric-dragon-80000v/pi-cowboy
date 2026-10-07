/**
 * sandbox.integration.test.ts — `createAdoptedWorktree` against real git: the
 * create the spawn path and `/cowboy worktree` share, and the rollback a failed
 * adoption runs. The host is a fake — the pane belongs to the execution backend,
 * which has its own suite — so what runs for real here is git.
 *
 * The materialization is `checkout`, so nothing here needs a cloning volume.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentHost, AgentHostRef } from "../src/agents/agent-host.js";
import { createAdoptedWorktree } from "../src/spawn/sandbox.js";
import {
  cleanupTmpDirs,
  freshTmp,
  git,
  makeCleanRepo,
  realPi,
} from "./helpers/git-repo.js";

afterEach(cleanupTmpDirs);

const ADOPTED_REF: AgentHostRef = {
  engine: "herdr",
  name: "adopted",
  paneId: "pane-1",
  tabId: "tab-1",
  workspaceId: "ws-1",
  paneCreated: false,
};

/** A host that adopts, or refuses with `failure`. */
function fakeHost(failure?: string): AgentHost {
  return {
    hostAt: async () =>
      failure === undefined ? ADOPTED_REF : Promise.reject(new Error(failure)),
    isAttached: async () => false,
    release: async () => true,
  } as unknown as AgentHost;
}

/** The create request for one worktree, under a fresh root beside the repo. */
function request(repo: string, branch: string) {
  return {
    repoCwd: repo,
    path: join(repo, "..", "worktrees", branch),
    branch,
    materialization: "checkout" as const,
    dirtyCheckout: "clean" as const,
    host: fakeHost(),
  };
}

describe("createAdoptedWorktree", () => {
  it("creates a free-form branch, adopts it, and reports the materialization", async () => {
    const repo = await makeCleanRepo(freshTmp());
    const options = request(repo, "render-page");

    const created = await createAdoptedWorktree(realPi(), options);

    expect(created.path).toBe(options.path);
    expect(created.branch).toBe("render-page");
    expect(created.materialization).toEqual({ kind: "checkout" });
    expect(existsSync(created.path)).toBe(true);
    expect(await git(["branch", "--show-current"], created.path)).toBe(
      "render-page",
    );
  });

  it("creates the directory level a nested name asks for", async () => {
    const repo = await makeCleanRepo(freshTmp());
    const options = request(repo, "feat/login");

    const created = await createAdoptedWorktree(realPi(), options);

    // The name is the branch and the directory at once, `/` and all.
    expect(existsSync(created.path)).toBe(true);
    expect(await git(["branch", "--show-current"], created.path)).toBe(
      "feat/login",
    );
    expect(created.materialization).toEqual({ kind: "checkout" });
  });

  it.each(["render-page", "feat/login"])(
    "removes the worktree and the branch it created when adoption fails (%s)",
    async (branch) => {
      const repo = await makeCleanRepo(freshTmp());
      const options = request(repo, branch);
      const host = fakeHost("herdr worktree open failed");
      const failed = await createAdoptedWorktree(realPi(), {
        ...options,
        host,
      }).catch((err: unknown) => err);

      expect(failed).toBeInstanceOf(Error);
      expect((failed as Error).message).toContain(
        "could not create the herdr worktree: herdr worktree open failed",
      );
      // The rollback is by name: neither git artifact outlives the failure.
      expect(existsSync(options.path)).toBe(false);
      expect(await git(["branch", "--list", branch], repo)).toBe("");
      expect((failed as Error).message).toContain(`branch ${branch} deleted`);
    },
  );
});

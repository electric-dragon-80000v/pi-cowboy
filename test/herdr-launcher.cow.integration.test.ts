/**
 * herdr-launcher.cow.integration.test.ts — createWorktreeCheckout's copy-on-write
 * path on a volume that really clones. Runs only in the `integration-cow`
 * project; the checkout strategy and every injected-fake rollback stay in
 * herdr-launcher.integration.test.ts.
 */

import { execFile } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createWorktreeCheckout } from "../src/spawn/herdr-launcher.js";
import type { WorktreeMaterialization } from "../src/spawn/worktree-policy.js";
import { resolvedBin } from "./helpers/resolved-bin.js";

const execFileAsync = promisify(execFile);

/** Canned herdr responses, real exec otherwise; records calls for shell-out assertions. */
function hybridPi(
  herdrResponse: (args: string[]) => {
    code: number;
    stdout: string;
    stderr: string;
  },
  herdrCalls?: string[][],
  otherCalls?: string[][],
  otherResponse?: (
    cmd: string,
    args: string[],
  ) => { code: number; stdout: string; stderr: string } | undefined,
): ExtensionAPI {
  return {
    exec: async (cmd: string, args: string[], opts?: unknown) => {
      if (cmd === "herdr") {
        herdrCalls?.push(args);
        return herdrResponse(args);
      }
      otherCalls?.push([cmd, ...args]);
      const response = otherResponse?.(cmd, args);
      if (response) return response;
      try {
        const { stdout, stderr } = await execFileAsync(resolvedBin(cmd), args, {
          cwd: (opts as { cwd?: string } | undefined)?.cwd,
        });
        return { code: 0, stdout, stderr };
      } catch (err) {
        const e = err as {
          code?: number | string;
          stdout?: string;
          stderr?: string;
        };
        return {
          code: typeof e.code === "number" ? e.code : 1,
          stdout: e.stdout ?? "",
          stderr: e.stderr ?? "",
        };
      }
    },
  } as unknown as ExtensionAPI;
}

/** Temp repo with a clean checkout plus gitignored state (only CoW carries it over). */
async function makeRepoWithIgnoredState(dir: string): Promise<string> {
  const repo = join(dir, "repo");
  await execFileAsync("git", ["init", "-b", "main", repo]);
  await execFileAsync("git", ["config", "user.email", "t@t"], { cwd: repo });
  await execFileAsync("git", ["config", "user.name", "t"], { cwd: repo });
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n.env\n");
  writeFileSync(join(repo, "tracked.txt"), "hello\n");
  await execFileAsync("git", ["add", "-A"], { cwd: repo });
  await execFileAsync("git", ["commit", "-qm", "init"], { cwd: repo });
  mkdirSync(join(repo, "node_modules"));
  writeFileSync(join(repo, "node_modules", "dep.txt"), "dep\n");
  writeFileSync(join(repo, ".env"), "SECRET=1\n");
  return repo;
}

async function gitStatus(cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["status", "--porcelain"], {
    cwd,
  });
  return stdout.trim();
}

/** Canned herdr `worktree open` response. */
function herdrOpenResponse(wt: string, branch: string) {
  return () => ({
    code: 0,
    stdout: JSON.stringify({
      id: "x",
      result: {
        workspace: { workspace_id: "w1" },
        worktree: {
          path: wt,
          branch,
          label: "feature",
          is_linked_worktree: true,
        },
        tab: { tab_id: "w1:t9" },
        root_pane: { pane_id: "w1:p9" },
      },
    }),
    stderr: "",
  });
}

/** Whether a command is one of the cloner's helpers rather than git or herdr. */
function clonedThroughPi(cmd: string): boolean {
  return cmd.endsWith("/python3") || cmd.endsWith("/cp") || cmd.endsWith("/du");
}

/** The clone strategy, whose tree is asserted against a real cloned volume. */
const MATERIALIZATIONS: readonly WorktreeMaterialization[] = ["copy-on-write"];

describe.each(MATERIALIZATIONS)(
  "createWorktreeCheckout (%s materialization)",
  (strategy) => {
    let tmp: string | undefined;

    afterEach(() => {
      if (tmp) rmSync(tmp, { recursive: true, force: true });
      tmp = undefined;
    });

    it("creates the worktree on the pinned branch without touching herdr", async () => {
      tmp = mkdtempSync(join(tmpdir(), `herdr-create-${strategy}-`));
      const repo = await makeRepoWithIgnoredState(tmp);
      const wt = join(tmp, "wt");
      const herdrCalls: string[][] = [];
      const otherCalls: string[][] = [];
      // Only herdr is canned; `git worktree add` and materialization run for real.
      const pi = hybridPi(
        herdrOpenResponse(wt, "cow-feature"),
        herdrCalls,
        otherCalls,
      );

      const created = await createWorktreeCheckout(pi, {
        repoCwd: repo,
        path: wt,
        branch: "cow-feature",
        materialization: strategy,
      });

      expect(created.path).toBe(wt);
      expect(created.branch).toBe("cow-feature");
      // Adoption is the host's job: the git half never shells out to herdr.
      expect(herdrCalls).toEqual([]);
      expect(await gitStatus(wt)).toBe("");
      expect(readFileSync(join(wt, "tracked.txt"), "utf8")).toBe("hello\n");
      expect(await gitStatus(repo)).toBe("");
      expect(readFileSync(join(repo, "tracked.txt"), "utf8")).toBe("hello\n");

      // The clone runs through pi.exec; the helpers are not git.
      expect(otherCalls.some(([cmd]) => clonedThroughPi(cmd))).toBe(true);
      expect(readFileSync(join(wt, "node_modules", "dep.txt"), "utf8")).toBe(
        "dep\n",
      );
      expect(readFileSync(join(wt, ".env"), "utf8")).toBe("SECRET=1\n");
    });
  },
);

describe("createWorktreeCheckout rollback", () => {
  let tmp: string | undefined;

  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  });

  it("says nothing when the volume clones as asked", async () => {
    tmp = mkdtempSync(join(tmpdir(), "herdr-materialization-quiet-"));
    const repo = await makeRepoWithIgnoredState(tmp);
    const wt = join(tmp, "cow-feature");
    const pi = hybridPi(
      () => ({
        code: 0,
        stdout: JSON.stringify({ id: "x", result: { worktrees: [] } }),
        stderr: "",
      }),
      [],
    );
    const warnings: string[] = [];

    await createWorktreeCheckout(pi, {
      repoCwd: repo,
      path: wt,
      branch: "cow-feature",
      materialization: "copy-on-write",
      notify: (message) => warnings.push(message),
    });

    expect(warnings).toEqual([]);
  });
});

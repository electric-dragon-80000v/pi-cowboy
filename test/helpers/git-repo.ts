/**
 * git-repo.ts — shared fixtures for the git-plane suites (test/git/*).
 *
 * Every fixture drives REAL git and sh: the plane's contract is argv + exit code +
 * filesystem effect, so fakes would test nothing. `realPi` runs anything (recording
 * argv on request); `gitPi` refuses non-git programs, so a stray shell-out fails
 * loudly.
 */

import { execFile } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolvedBin } from "./resolved-bin.js";

export const execFileAsync = promisify(execFile);

const tmpDirs: string[] = [];

/** Fresh temp dir for `cleanupTmpDirs`. */
export function freshTmp(prefix = "git-plane-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

/** Remove every temp dir created so far. */
export function cleanupTmpDirs(): void {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** pi.exec that really runs commands, recording invocations on request. */
export function realPi(calls?: string[][]): ExtensionAPI {
  return {
    exec: async (
      cmd: string,
      args: string[],
      opts?: { cwd?: string; timeout?: number },
    ) => {
      calls?.push([cmd, ...args]);
      try {
        const { stdout, stderr } = await execFileAsync(resolvedBin(cmd), args, {
          cwd: opts?.cwd,
          timeout: opts?.timeout ?? 60_000,
          maxBuffer: 64 * 1024 * 1024,
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

/** pi.exec that runs real git and rejects anything else. */
export function gitPi(): ExtensionAPI {
  return {
    exec: async (cmd: string, args: string[], opts?: unknown) => {
      if (cmd !== "git") throw new Error(`unexpected command ${cmd}`);
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

/** pi.exec whose every invocation fails to start (the transport-error case). */
export function brokenPi(message = "spawn failed"): ExtensionAPI {
  return {
    exec: async () => {
      throw new Error(message);
    },
  } as unknown as ExtensionAPI;
}

/** Run git; trimmed stdout (throws on failure). */
export async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync(resolvedBin("git"), args, { cwd });
  return stdout.trim();
}

/** Trimmed `git status --porcelain` for cleanliness assertions. */
export async function gitStatus(cwd: string): Promise<string> {
  const r = await realPi().exec("git", ["status", "--porcelain"], { cwd });
  if (r.code !== 0) throw new Error(`git status failed: ${r.stderr}`);
  return r.stdout.trim();
}

/** Repo on main with one commit; the canonical repo root. */
export async function makeRepo(t: string): Promise<string> {
  const repo = join(t, "repo");
  await execFileAsync(resolvedBin("git"), ["init", "-b", "main", repo]);
  await execFileAsync(resolvedBin("git"), ["config", "user.email", "t@t"], {
    cwd: repo,
  });
  await execFileAsync(resolvedBin("git"), ["config", "user.name", "t"], {
    cwd: repo,
  });
  writeFileSync(join(repo, "base.txt"), "base\n");
  await execFileAsync(resolvedBin("git"), ["add", "-A"], { cwd: repo });
  await execFileAsync(resolvedBin("git"), ["commit", "-qm", "init"], {
    cwd: repo,
  });
  // Canonicalize: git prints the physical path (macOS /var -> /private/var).
  return realpathSync(repo);
}

/** Repo with a clean tree but gitignored state. */
export async function makeCleanRepo(dir: string): Promise<string> {
  const repo = join(dir, "repo");
  // `git init` creates the dir itself, so run it from the parent.
  await git(["init", "-b", "main", repo], dir);
  await git(["config", "user.email", "t@t"], repo);
  await git(["config", "user.name", "t"], repo);
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n.env\n");
  writeFileSync(join(repo, "tracked.txt"), "hello\n");
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "lib.ts"), "export const x = 1;\n");
  await git(["add", "-A"], repo);
  await git(["commit", "-m", "init"], repo);
  mkdirSync(join(repo, "node_modules"));
  writeFileSync(join(repo, "node_modules", "dep.txt"), "dep\n");
  writeFileSync(join(repo, ".env"), "SECRET=1\n");
  return repo;
}

/** Commit a file on a new branch off main; HEAD stays on main. */
export async function makeAgentBranch(
  repo: string,
  branch: string,
  file: string,
  content: string,
): Promise<void> {
  await execFileAsync(resolvedBin("git"), ["checkout", "-qb", branch], {
    cwd: repo,
  });
  writeFileSync(join(repo, file), content);
  await execFileAsync(resolvedBin("git"), ["add", "-A"], { cwd: repo });
  await execFileAsync(resolvedBin("git"), ["commit", "-qm", `work ${branch}`], {
    cwd: repo,
  });
  await execFileAsync(resolvedBin("git"), ["checkout", "-q", "main"], {
    cwd: repo,
  });
}

/** Worktree on `branch` at `wt`, with a real checkout. */
export async function addWorktree(
  repo: string,
  wt: string,
  branch: string,
): Promise<void> {
  await execFileAsync(
    resolvedBin("git"),
    ["worktree", "add", "-b", branch, wt],
    {
      cwd: repo,
    },
  );
}

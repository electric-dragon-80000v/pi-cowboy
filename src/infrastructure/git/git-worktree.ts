/**
 * git-worktree.ts — Layer 2: one git worktree as an entity, and the repo's set
 * of them.
 *
 * Binds path (and branch, when known) to the transport. No policy here: dirty
 * worktrees are interpreted in git-retention.ts, branches in git-merger.ts.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { GIT_EXEC_TIMEOUT_MS } from "../../utils.js";
import {
  GitCommandRunner,
  GIT_WORKTREE_TIMEOUT_MS,
  type GitProbeOptions,
} from "./git-runner.js";

/** Budget (ms) for the read-only questions a picker asks: a scan must stay snappy. */
const WORKTREE_SCAN_TIMEOUT_MS = 5_000;

/** One entry of `git worktree list --porcelain`. */
export interface GitWorktreeEntry {
  /** Absolute path of the checkout. */
  path: string;
  /** Branch the checkout carries; null for a detached HEAD. */
  branch: string | null;
  isDetached: boolean;
}

/** One linked worktree checkout on disk. */
export class GitWorktree {
  constructor(
    private readonly runner: GitCommandRunner,
    /** Absolute path of the checkout. */
    readonly path: string,
    /** Branch the checkout carries, when the caller knows it. */
    readonly branch?: string,
  ) {}

  /**
   * `git status --porcelain`, trimmed. `undefined` means "could not tell" —
   * callers must treat it as dirty, never clean.
   */
  async status(options?: GitProbeOptions): Promise<string | undefined> {
    return this.runner.probe(["status", "--porcelain"], this.path, options);
  }

  /** Whether the checkout has uncommitted changes; `undefined` is not clean. */
  async isDirty(): Promise<boolean | undefined> {
    const status = await this.status({ timeoutMs: GIT_EXEC_TIMEOUT_MS });
    if (status === undefined) return undefined;
    return status !== "";
  }

  /**
   * Best-effort `git worktree remove [--force]`; never throws. Defaults to
   * running from the worktree itself, which git allows.
   */
  async remove(force = true, cwd: string = this.path): Promise<void> {
    await this.runner.run(
      force
        ? ["worktree", "remove", "--force", this.path]
        : ["worktree", "remove", this.path],
      cwd,
      GIT_WORKTREE_TIMEOUT_MS,
    );
  }
}

/** Best-effort `git worktree remove --force`; never throws. */
export async function removeGitWorktree(
  pi: ExtensionAPI,
  repoCwd: string,
  wtPath: string,
): Promise<void> {
  await new GitWorktree(new GitCommandRunner(pi), wtPath).remove(true, repoCwd);
}

/**
 * Parse `git worktree list --porcelain` output (blank-line-separated blocks):
 * `worktree <path>`, `HEAD <sha>`, `branch refs/heads/<name>` or `detached`.
 */
function parseWorktreeList(output: string): GitWorktreeEntry[] {
  const entries: GitWorktreeEntry[] = [];
  for (const block of output.split(/\n\n+/)) {
    if (!block.trim()) continue;
    let path = "";
    let branch: string | null = null;
    let isDetached = false;
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) {
        path = line.slice("worktree ".length);
      } else if (line.startsWith("branch refs/heads/")) {
        branch = line.slice("branch refs/heads/".length);
      } else if (line === "detached") {
        isDetached = true;
      }
    }
    if (path) entries.push({ path, branch, isDetached });
  }
  return entries;
}

/** The repo's checkouts: the main one first, linked ones after. Null when git cannot answer. */
export async function listGitWorktrees(
  pi: ExtensionAPI,
  repoCwd: string,
): Promise<GitWorktreeEntry[] | null> {
  const output = await new GitCommandRunner(pi).probe(
    ["worktree", "list", "--porcelain"],
    repoCwd,
    { timeoutMs: WORKTREE_SCAN_TIMEOUT_MS },
  );
  if (output === undefined) return null;
  return parseWorktreeList(output);
}

/** Whether `cwd` is inside a git repository (the same `rev-parse` probe the worktree validator runs). */
export async function isGitRepo(
  pi: ExtensionAPI,
  cwd: string,
): Promise<boolean> {
  const commonDir = await new GitCommandRunner(pi).probe(
    ["rev-parse", "--git-common-dir"],
    cwd,
    { timeoutMs: WORKTREE_SCAN_TIMEOUT_MS },
  );
  return commonDir !== undefined && commonDir !== "";
}

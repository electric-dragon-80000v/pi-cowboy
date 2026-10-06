/**
 * herdr-launcher.ts — git-side worktree creation with rollback on every failure.
 * Herdr adoption (`worktree open`) is out of scope — see AgentHost.hostAt.
 */

import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
// Git HOW lives in git-client.ts; orchestration stays here.
import {
  GitError,
  deleteWorktreeBranch,
  gitProbe,
  gitRun,
  materializeWorktree,
  removeGitWorktree,
  resolveMainCheckout,
  worktreeAddArgs,
  GIT_WORKTREE_TIMEOUT_MS,
  type WorktreeMaterializationOutcome,
} from "../infrastructure/git-client.js";
import {
  DEFAULT_WORKTREE_CHECKOUT_TYPE,
  DEFAULT_WORKTREE_MATERIALIZATION,
  type WorktreeCheckoutType,
  type WorktreeMaterialization,
} from "./worktree-policy.js";

/** Whether `branch` was already in the repo before the add. `worktree add -b` refuses a branch that exists, so a branch absent here and present after a failed add is this call's to prune; one that existed belongs to the caller. A probe that cannot run answers true, so a transport failure never deletes. */
async function branchExisted(
  pi: ExtensionAPI,
  repoCwd: string,
  branch: string,
): Promise<boolean> {
  const probe = await gitRun(
    pi,
    ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
    repoCwd,
    GIT_WORKTREE_TIMEOUT_MS,
  );
  if (probe === undefined) return true;
  return probe.code === 0;
}

/** A created git worktree checkout, before host adoption. */
export interface WorktreeCheckout {
  path: string;
  /** Requested branch, verified against the created checkout. */
  branch: string;
  /** Main checkout: adoption source and removal cwd. */
  repoCwd: string;
}

// --- Worktree checkout creation (pre-adoption) ---

export interface CreateWorktreeOptions {
  /** Any path inside the parent repo; the main checkout is resolved from it. */
  repoCwd: string;
  path: string;
  /** Pinned `cow-<task>-<id>` branch; always a valid git branch name by construction. */
  branch: string;
  /** Base ref the new branch starts from; default "HEAD". */
  base?: string;
  /** Working-tree materialization; drives both the add args and the materialization step. */
  materialization?: WorktreeMaterialization;
  /** Whether the new checkout starts dirty with a dirty main checkout's WIP; defaults to the configured policy (`clean`). */
  dirtyCheckout?: WorktreeCheckoutType;
  /** Same shape as AgentSandbox's warning hook, so the sandbox passes its own through unchanged. */
  notify?: (message: string, kind: "warning") => void;
}

export async function createWorktreeCheckout(
  pi: ExtensionAPI,
  options: CreateWorktreeOptions,
): Promise<WorktreeCheckout> {
  const branch = options.branch.trim();
  if (branch === "") {
    throw new GitError(
      "worktree checkout requires a branch name (`cow-<task>-<id>`)",
    );
  }
  // Herdr rejects a linked worktree as the adoption source: start from the main checkout.
  const mainRoot = await resolveMainCheckout(pi, options.repoCwd);
  const wtPath = path.resolve(options.path);
  const materializationStrategy =
    options.materialization ?? DEFAULT_WORKTREE_MATERIALIZATION;
  const dirtyCheckout = options.dirtyCheckout ?? DEFAULT_WORKTREE_CHECKOUT_TYPE;

  // Copy-on-write adds with `--no-checkout`; materializeWorktree below populates the tree.
  const existedBefore = await branchExisted(pi, mainRoot, branch);
  const add = await gitRun(
    pi,
    [
      "worktree",
      "add",
      ...worktreeAddArgs(materializationStrategy),
      "-b",
      branch,
      wtPath,
      options.base ?? "HEAD",
    ],
    mainRoot,
    GIT_WORKTREE_TIMEOUT_MS,
  );
  if (add === undefined || add.code !== 0) {
    await removeGitWorktree(pi, mainRoot, wtPath);
    // git can create the ref before it fails. The two later failure paths
    // prune it unconditionally; this one prunes only a branch it created, so a
    // collision with a caller's branch leaves that branch alone.
    if (!existedBefore) {
      await deleteWorktreeBranch(pi, wtPath, mainRoot);
    }
    throw new GitError(
      add === undefined
        ? `git worktree add for "${branch}" could not run (worktree removed)`
        : `git worktree add for "${branch}" failed (worktree removed): ${(add.stderr || add.stdout || `exit ${add.code}`).slice(0, 300)}`,
    );
  }
  // A worktree on any other branch is not ours to keep: a spawn there would commit onto another task's branch.
  const actualBranch = await gitProbe(pi, ["branch", "--show-current"], wtPath);
  if (actualBranch !== branch) {
    await removeGitWorktree(pi, mainRoot, wtPath);
    // No attachment probe: the host has not seen the tree yet, so it is detached by construction.
    await deleteWorktreeBranch(pi, wtPath, mainRoot);
    throw new GitError(
      actualBranch === undefined
        ? `worktree created at ${wtPath} but its branch could not be verified (worktree removed)`
        : `worktree created at ${wtPath} is on branch "${actualBranch || "(detached)"}", not the requested "${branch}" (worktree removed). The branch "${actualBranch}" still exists.`,
    );
  }
  // Materialize before the subagent pane starts, so it always sees the final checkout.
  let outcome: WorktreeMaterializationOutcome;
  try {
    outcome = await materializeWorktree(
      pi,
      wtPath,
      materializationStrategy,
      dirtyCheckout,
    );
  } catch (err) {
    await removeGitWorktree(pi, mainRoot, wtPath);
    await deleteWorktreeBranch(pi, wtPath, mainRoot);
    const msg = err instanceof Error ? err.message : String(err);
    throw new GitError(
      `worktree created but ${materializationStrategy} materialization failed (worktree removed): ${msg}`,
    );
  }
  // A fallback still leaves a usable worktree, but not the one the setting asked
  // for: the spawn has nothing to tell the user about it, so tell them here.
  if (outcome.kind === "cow-fallback") {
    const dropped =
      dirtyCheckout === "dirty"
        ? " The parent's uncommitted work was not carried over."
        : "";
    options.notify?.(
      `[cowboy] ${outcome.reason}${dropped} Nothing is shared with the parent checkout.`,
      "warning",
    );
  }
  return { path: wtPath, branch, repoCwd: mainRoot };
}

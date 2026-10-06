/**
 * git-retention.ts — Layer 3: what a worktree holds that must not be destroyed.
 *
 * Conservative: an unverifiable tree is kept, never destroyed, always with a
 * reason string. Branch merge state is out of scope — branch commits live in the
 * object store, so removing a clean worktree never loses them (see
 * git-merger.ts's BranchCleaner for branch deletion).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { WorktreeRetentionReason } from "../../types.js";
import { GitCommandRunner } from "./git-runner.js";
import { GitWorktree } from "./git-worktree.js";

function worktree(pi: ExtensionAPI, worktreePath: string): GitWorktree {
  return new GitWorktree(new GitCommandRunner(pi), worktreePath);
}

/** Whether a worktree has uncommitted changes; undefined when the probe fails. */
export async function isWorktreeDirty(
  pi: ExtensionAPI,
  worktreePath: string,
): Promise<boolean | undefined> {
  return worktree(pi, worktreePath).isDirty();
}

/**
 * Why a worktree must be kept, or null when clean (the only removable state).
 * An unreadable tree is kept as unverifiable, never destroyed.
 */
export async function worktreeRetentionReason(
  pi: ExtensionAPI,
  worktreePath: string,
): Promise<WorktreeRetentionReason | null> {
  const dirty = await worktree(pi, worktreePath).isDirty();
  if (dirty === undefined) {
    return { kind: "unverifiable", detail: "git status probe failed" };
  }
  if (dirty) return { kind: "dirty" };

  return null;
}

/** Short reason clause for UI toasts. */
export function formatRetentionClause(reason: WorktreeRetentionReason): string {
  switch (reason.kind) {
    case "dirty":
      return "has uncommitted changes";
    case "unverifiable":
      return `state could not be verified (${reason.detail})`;
  }
}

/** Full retention warning for UI toasts. */
export function formatRetentionReason(
  reason: WorktreeRetentionReason,
  worktreePath: string,
): string {
  return `Worktree ${worktreePath} ${formatRetentionClause(reason)} — NOT removed.`;
}

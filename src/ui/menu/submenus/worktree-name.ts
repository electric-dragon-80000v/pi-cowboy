/**
 * worktree-name.ts — the spawn wizard's worktree name field, shown after Spawn.
 *
 * The field owns the naming rule for a manually created worktree: the name is
 * the git branch, the worktree directory, and the spawned agent's herdr name,
 * so it must be `cow-` + a non-empty lowercase `[a-z0-9_-]` suffix within
 * herdr's 32-character agent-name cap. Submit re-prompts with a notification
 * instead of completing on a rejected name.
 */

import { Input } from "@earendil-works/pi-tui";
import type { Notify } from "../helpers.js";
import { HERDR_AGENT_NAME_MAX_LENGTH } from "../../../spawn/worktree-policy.js";

/** Prefix every worktree name carries; the field is prefilled with it. */
export const WORKTREE_BRANCH_PREFIX = "cow-";

/** Longest accepted name: the branch is the herdr agent name, capped at `[a-z][a-z0-9_-]{0,31}`. */
export const WORKTREE_BRANCH_MAX_LENGTH = HERDR_AGENT_NAME_MAX_LENGTH;

/** Why a user-entered worktree name was rejected. */
export type WorktreeNameProblem =
  | { kind: "missing-prefix" }
  | { kind: "empty-name" }
  | { kind: "invalid-characters" }
  | { kind: "too-long" };

/** Validate a trimmed worktree name; null means accepted. */
export function validateWorktreeBranchName(
  input: string,
): WorktreeNameProblem | null {
  if (!input.startsWith(WORKTREE_BRANCH_PREFIX)) {
    return { kind: "missing-prefix" };
  }
  const suffix = input.slice(WORKTREE_BRANCH_PREFIX.length);
  if (suffix === "") return { kind: "empty-name" };
  if (!/^[a-z0-9_-]+$/.test(suffix)) return { kind: "invalid-characters" };
  if (input.length > WORKTREE_BRANCH_MAX_LENGTH) return { kind: "too-long" };
  return null;
}

/** User-facing message for a rejected worktree name. */
export function describeWorktreeNameProblem(
  problem: WorktreeNameProblem,
): string {
  switch (problem.kind) {
    case "missing-prefix":
      return `Worktree name must start with "${WORKTREE_BRANCH_PREFIX}" — it is prefilled; add your name after it.`;
    case "empty-name":
      return `Enter a name after "${WORKTREE_BRANCH_PREFIX}" (for example cow-fix-login).`;
    case "invalid-characters":
      return "Invalid name: only lowercase letters, numbers, hyphens, and underscores allowed.";
    case "too-long":
      return `Worktree name is too long: herdr agent names cap at ${WORKTREE_BRANCH_MAX_LENGTH} characters, so the name after "${WORKTREE_BRANCH_PREFIX}" can be at most ${WORKTREE_BRANCH_MAX_LENGTH - WORKTREE_BRANCH_PREFIX.length} characters.`;
  }
}

export interface WorktreeNameInputOptions {
  /** Notification sink for a rejected name. */
  notify: Notify;
  /** The accepted, trimmed name. */
  onDone: (name: string) => void;
  /** Escape: leave without a name. */
  onCancel: () => void;
}

/** Single-line name field, prefilled `cow-`; a rejected submit keeps the text. */
export function createWorktreeNameInput(
  options: WorktreeNameInputOptions,
): Input {
  const input = new Input();
  input.focused = true;
  // `setValue` leaves the caret at position 0; typing the prefix lands it after,
  // where the user continues the name.
  for (const char of WORKTREE_BRANCH_PREFIX) input.handleInput(char);
  input.onSubmit = (value) => {
    const trimmed = value.trim();
    const problem = validateWorktreeBranchName(trimmed);
    if (problem) {
      options.notify(describeWorktreeNameProblem(problem), "error");
      return;
    }
    options.onDone(trimmed);
  };
  input.onEscape = () => options.onCancel();
  return input;
}

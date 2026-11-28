/**
 * worktree-name.ts — the spawn wizard's worktree name field, shown after Spawn.
 *
 * The field owns the naming rule for a manually created worktree: the name is
 * the git branch, the worktree directory, and the spawned agent's herdr name,
 * so it must be a non-empty lowercase `[a-z0-9_-]` name that starts and ends
 * with a letter or number, within herdr's 32-character agent-name cap. No
 * prefix is required: the field opens with the configured
 * `agent.worktreePrefix` typed in, and the user is free to edit it away — which
 * is why a bare prefix (the untouched prefill) is rejected: it ends with a
 * separator and names nothing. Submit re-prompts with a notification instead of
 * completing on a rejected name.
 */

import type { Input } from "@earendil-works/pi-tui";
import type { Notify } from "../helpers.js";
import { HERDR_AGENT_NAME_MAX_LENGTH } from "../../../predicates.js";
import { createNameField } from "./name-field.js";

/** Longest accepted name: the branch is the herdr agent name, capped at `[a-z][a-z0-9_-]{0,31}`. */
export const WORKTREE_BRANCH_MAX_LENGTH = HERDR_AGENT_NAME_MAX_LENGTH;

/** Why a user-entered worktree name was rejected. */
export type WorktreeNameProblem =
  | { kind: "empty-name" }
  | { kind: "invalid-characters" }
  | { kind: "too-long" };

/** Validate a trimmed worktree name; null means accepted. */
export function validateWorktreeBranchName(
  input: string,
): WorktreeNameProblem | null {
  if (input === "") return { kind: "empty-name" };
  if (!/^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/.test(input)) {
    return { kind: "invalid-characters" };
  }
  if (input.length > WORKTREE_BRANCH_MAX_LENGTH) return { kind: "too-long" };
  return null;
}

/** User-facing message for a rejected worktree name. */
export function describeWorktreeNameProblem(
  problem: WorktreeNameProblem,
): string {
  switch (problem.kind) {
    case "empty-name":
      return "Enter a name (for example cow-fix-login).";
    case "invalid-characters":
      return "Invalid name: only lowercase letters, numbers, hyphens, and underscores allowed, and it must start and end with a letter or number.";
    case "too-long":
      return `Worktree name is too long: herdr agent names cap at ${WORKTREE_BRANCH_MAX_LENGTH} characters.`;
  }
}

export interface WorktreeNameInputOptions {
  /** Text the field opens with: the configured prefix, which the user may edit away. */
  prefill: string;
  /** Notification sink for a rejected name. */
  notify: Notify;
  /** The accepted, trimmed name. */
  onDone: (name: string) => void;
  /** Escape: leave without a name. */
  onCancel: () => void;
}

/** Single-line name field; a rejected submit keeps the field open on its text. */
export function createWorktreeNameInput(
  options: WorktreeNameInputOptions,
): Input {
  return createNameField({
    prefill: options.prefill,
    notify: options.notify,
    validate: validateWorktreeBranchName,
    describeProblem: describeWorktreeNameProblem,
    onDone: options.onDone,
    onCancel: options.onCancel,
  });
}

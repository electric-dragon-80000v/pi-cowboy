/**
 * worktree-command-name.ts — the `/cowboy worktree` command's name field.
 *
 * The name is the git branch and the directory under the worktree root at once,
 * so it follows git's own branch-name rules instead of the spawn wizard's
 * `cow-`-prefixed grammar, and a name that happens to start with `cow-` is
 * nothing special. It is capped at herdr's agent-name length because the pane
 * adoption names the worktree with it. Submit re-prompts with a notification
 * instead of completing on a rejected name.
 */

import type { Input } from "@earendil-works/pi-tui";
import type { Notify } from "../helpers.js";
import { HERDR_AGENT_NAME_MAX_LENGTH } from "../../../spawn/worktree-policy.js";
import { createNameField } from "./name-field.js";

/** Longest accepted name: the pane adoption carries it as herdr's agent name. */
export const WORKTREE_COMMAND_NAME_MAX_LENGTH = HERDR_AGENT_NAME_MAX_LENGTH;

/** Why a free-form worktree name was rejected. */
export type WorktreeCommandNameProblem =
  | { kind: "empty-name" }
  | { kind: "too-long" }
  | { kind: "invalid-characters" }
  | { kind: "invalid-shape" };

/** Characters git refuses anywhere in a branch name. */
const ILLEGAL_BRANCH_CHARACTERS = /[ ~^:?*[\\]/;

/** Whether a branch name holds a character git refuses: a control character, or one of its own set. */
function hasIllegalCharacter(input: string): boolean {
  for (const char of input) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
    if (ILLEGAL_BRANCH_CHARACTERS.test(char)) return true;
  }
  return false;
}

/** Validate a trimmed worktree name as a git branch name; null means accepted. */
export function validateWorktreeCommandName(
  input: string,
): WorktreeCommandNameProblem | null {
  if (input === "") return { kind: "empty-name" };
  if (input.length > WORKTREE_COMMAND_NAME_MAX_LENGTH) {
    return { kind: "too-long" };
  }
  if (hasIllegalCharacter(input)) {
    return { kind: "invalid-characters" };
  }
  const shapeIsWrong =
    input.startsWith("-") ||
    input.startsWith(".") ||
    input.startsWith("/") ||
    input.endsWith(".") ||
    input.endsWith("/") ||
    input.endsWith(".lock") ||
    input.includes("..") ||
    input.includes("//") ||
    input.includes("@{") ||
    input === "@";
  return shapeIsWrong ? { kind: "invalid-shape" } : null;
}

/** User-facing message for a rejected worktree name. */
export function describeWorktreeCommandNameProblem(
  problem: WorktreeCommandNameProblem,
): string {
  switch (problem.kind) {
    case "empty-name":
      return "Enter a name: it becomes the worktree's directory and its git branch.";
    case "too-long":
      return `Name is too long: the pane adoption carries it as a herdr agent name, which caps at ${WORKTREE_COMMAND_NAME_MAX_LENGTH} characters.`;
    case "invalid-characters":
      return "Invalid name: it must be a git branch name, so letters, digits, and - _ . / only — no spaces, and none of ~ ^ : ? * [ \\.";
    case "invalid-shape":
      return "Invalid name: a git branch name cannot contain .. or @{, cannot start with - . or /, and cannot end with . / or .lock.";
  }
}

export interface WorktreeCommandNameInputOptions {
  /** Text the field opens with: the inline name, when the command was given one. */
  prefill: string;
  /** Notification sink for a rejected name. */
  notify: Notify;
  /** The accepted, trimmed name. */
  onDone: (name: string) => void;
  /** Escape: leave without a name. */
  onCancel: () => void;
}

/** Single-line free-form name field; a rejected submit keeps the text. */
export function createWorktreeCommandNameInput(
  options: WorktreeCommandNameInputOptions,
): Input {
  return createNameField({
    prefill: options.prefill,
    notify: options.notify,
    validate: validateWorktreeCommandName,
    describeProblem: describeWorktreeCommandNameProblem,
    onDone: options.onDone,
    onCancel: options.onCancel,
  });
}

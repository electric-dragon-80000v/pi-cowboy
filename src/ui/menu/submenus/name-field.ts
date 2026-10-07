/**
 * name-field.ts — the single-line name field the worktree flows ask with.
 *
 * What the flows share lives here: one line of input, a rejected submit that
 * notifies and keeps the text, an accepted one that reports the trimmed name,
 * and Escape leaving without a name. Each caller brings its own prefill, rule
 * and wording — the spawn wizard's names are `cow-`-prefixed, the
 * `/cowboy worktree` command's are free-form.
 */

import { Input } from "@earendil-works/pi-tui";
import type { Notify } from "../helpers.js";

export interface NameFieldOptions<Problem> {
  /**
   * Text the field opens with, typed at the caret so the user continues after
   * it. Control characters are left out: they are keys to the field, not text.
   */
  prefill: string;
  /** Notification sink for a rejected name. */
  notify: Notify;
  /** Why the submitted name cannot be used, or null when it can. */
  validate: (name: string) => Problem | null;
  /** User-facing message for a rejection. */
  describeProblem: (problem: Problem) => string;
  /** The accepted, trimmed name. */
  onDone: (name: string) => void;
  /** Escape: leave without a name. */
  onCancel: () => void;
}

/**
 * Whether the field's key handling would take `char` as an operator rather than
 * text. Control characters — C0, DEL, and C1 — are keys (enter submits, escape
 * cancels, backspace and ctrl-u edit) or are dropped; none is ever inserted.
 */
function isControlCharacter(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
}

/** Single-line name field; a rejected submit keeps the field open on its text. */
export function createNameField<Problem>(
  options: NameFieldOptions<Problem>,
): Input {
  const input = new Input();
  input.focused = true;
  // `setValue` leaves the caret at position 0; typing the prefill lands it after
  // it, where the user continues the name. Only text is typed: control
  // characters are keys to the field, so backspace, ctrl-u and undo would edit
  // the prefill away instead of appearing in the name.
  for (const char of options.prefill) {
    if (!isControlCharacter(char)) input.handleInput(char);
  }
  input.onSubmit = (value) => {
    const trimmed = value.trim();
    const problem = options.validate(trimmed);
    if (problem) {
      options.notify(options.describeProblem(problem), "error");
      return;
    }
    options.onDone(trimmed);
  };
  input.onEscape = () => options.onCancel();
  return input;
}

/**
 * stop-keys.ts — the shared shape of a harness stop: press the keys its TUI
 * binds to exit, through the session's active pane surface.
 *
 * The keys differ per harness because they are the TUI's own keybindings, not a
 * process signal: pi and codex exit on ctrl+d, opencode and claude interrupt on
 * the first ctrl+c and exit on the second. The multiplexer carries the keys and
 * confirms the process is gone; it never guesses a sequence of its own.
 */

import type { HarnessStop, HarnessStopRequest } from "../harness.js";

/** A harness stop that presses `keys`, in order, into the active pane. */
export function stopWithKeys(keys: readonly string[]): HarnessStop {
  return ({ pane, paneId }: HarnessStopRequest): Promise<void> =>
    pane.sendKeys(paneId, keys);
}

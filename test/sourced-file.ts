/**
 * sourced-file.ts — reading what a harness had the pane source.
 *
 * A launcher install types only `. '<file>'` into the pane; what the pane's
 * shell evaluates is the staged file. A test that asserts on the launcher or
 * its proof reads the file the typed command names.
 */

import { readFileSync } from "node:fs";

/** The lines of the file a typed `. '<file>'` command sources. */
export function sourcedLines(command: unknown): string[] {
  const match =
    typeof command === "string" ? /^\. '(.+)'$/.exec(command) : null;
  if (match === null) {
    throw new Error(`not a source command: ${String(command)}`);
  }
  return readFileSync(match[1]!, "utf-8").trimEnd().split("\n");
}

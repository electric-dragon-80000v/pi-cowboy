/**
 * sourced-file.ts — reading what a harness had the pane source.
 *
 * A launcher install types only `. '<file>'` into the pane; what the pane's
 * shell evaluates is the staged file. A test that asserts on the launcher or
 * its proof reads the file the typed command names.
 */

import { readFileSync } from "node:fs";

/**
 * The lines of the file a typed `. '<file>'` command sources. The path is read
 * back out of its shell quoting, so a staging root that holds a single quote
 * (typed as `'\''`) names the file the shell would open.
 */
export function sourcedLines(command: unknown): string[] {
  const match =
    typeof command === "string" ? /^\. '(.+)'$/.exec(command) : null;
  if (match === null) {
    throw new Error(`not a source command: ${String(command)}`);
  }
  const file = match[1]!.replaceAll("'\\''", "'");
  return readFileSync(file, "utf-8").trimEnd().split("\n");
}

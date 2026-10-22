/**
 * launch-env.ts — staging a launch's environment for its pane-side launcher.
 *
 * The variables come from `harness.<id>.env` and a template's per-family table,
 * and the most likely thing in one is a credential. A launcher that put the
 * values in the command it types at the pane's prompt would leave them in that
 * pane's scrollback and in the shell's history file, so the values are staged
 * the way the briefing and the task are: an owner-only file, sourced by the
 * launcher. Only the file's path crosses the pane's command line.
 */

import { writeResultFile } from "../result-file-permissions.js";
import { singleQuoteShellWord } from "./pane-launcher.js";

/**
 * Stage one launch's variables as shell assignments in `file`, or return `null`
 * when the launch carries none — a spawn with no overrides needs no file.
 *
 * Each line is `export NAME='value'`: `export` rather than `set -a`, so sourcing
 * never depends on a shell option the pane's profile may have changed. Names
 * arrive validated (a POSIX identifier, not reserved) and values are single-quoted,
 * so a value holding `$`, a backtick, or a quote rides as bytes.
 */
export function stageLaunchEnv(
  file: string,
  env: Readonly<Record<string, string>>,
): string | null {
  const entries = Object.entries(env);
  if (entries.length === 0) return null;
  writeResultFile(
    file,
    `${entries
      .map(([name, value]) => `export ${name}=${singleQuoteShellWord(value)}`)
      .join("\n")}\n`,
  );
  return file;
}

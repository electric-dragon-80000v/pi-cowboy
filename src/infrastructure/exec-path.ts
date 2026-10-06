/**
 * exec-path.ts — resolving a program the way a shell would, over this process's
 * PATH. The clone path and the harness availability probe both ask this question,
 * and both must answer it the same way.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Absolute path of the first executable `name` on PATH; undefined when there is
 * none. Only a regular file counts: `X_OK` alone is also true of a directory, and
 * a directory named after a program is not that program.
 */
export function commandPath(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (dir === "") continue;
    const candidate = path.join(dir, name);
    try {
      // `statSync` follows a symlink, so a link to an executable counts and a
      // broken or dangling one does not.
      if (!fs.statSync(candidate).isFile()) continue;
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // next directory
    }
  }
  return undefined;
}

/** First executable `name` on PATH; the bare name if there is none. */
export function resolveCommand(name: string): string {
  return commandPath(name) ?? name;
}

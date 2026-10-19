/**
 * parent-config-link.ts — carrying one of the parent's own config files into a
 * spawn's staged config directory, as a symlink.
 *
 * A harness that redirects its config directory (`CLAUDE_CONFIG_DIR`,
 * `OPENCODE_CONFIG_DIR`) shadows everything the parent keeps inside the real
 * one. Where that includes what the spawn needs to authenticate or to find its
 * providers — on Linux, claude's `.credentials.json` and opencode's user config —
 * the staged directory names that one file back at the parent's.
 *
 * A symlink rather than a copy: the parent's file stays the one source of truth,
 * so a token the spawn refreshes in place is the parent's refreshed token, and no
 * second copy of a secret outlives the spawn or goes stale beside it. The link
 * names the parent file's resolved path, so a spawn of a spawn points at the
 * real file rather than at a link inside a staging tree its parent's teardown
 * removes. A writer that replaces the file (write-then-rename) rather than
 * writing through it replaces only the link: the spawn keeps working, the
 * parent's file is untouched.
 *
 * One file, never the directory: the parent's config directory also holds state
 * that belongs to the parent alone (other projects' trust entries, history,
 * settings the staging deliberately decides), and linking the whole directory
 * would hand all of it to the spawn.
 */

import fs from "node:fs";
import * as path from "node:path";

/**
 * A directory named by an environment variable, or undefined when the variable
 * is unset or empty — an empty value means "use the default", as the XDG spec
 * reads it, never the current directory.
 */
export function envDir(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === "" ? undefined : value;
}

/**
 * Link `parentFile` into `stagedDir` under its own name, replacing whatever
 * that name already holds. Best effort: a parent file that does not exist — the
 * macOS keychain case, a user with no config, a non-default layout — or any
 * failure to link leaves the staged directory as it was, and the spawn starts
 * on the staging alone instead of failing its launch.
 */
export function linkParentConfigFile(
  parentFile: string,
  stagedDir: string,
): void {
  const link = path.join(stagedDir, path.basename(parentFile));
  try {
    const target = fs.realpathSync(parentFile);
    if (!fs.statSync(target).isFile()) return;
    fs.rmSync(link, { force: true });
    fs.symlinkSync(target, link);
  } catch {
    // Best effort: without the link the spawn reads the staged directory alone,
    // which is the behaviour of a parent whose file is not on disk.
  }
}

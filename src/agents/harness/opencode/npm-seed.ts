/**
 * opencode/npm-seed.ts — the fake npm project that keeps opencode from
 * installing its plugin into every config directory it loads.
 *
 * opencode treats a config directory as an npm project: on every load it asks
 * npm for `@opencode-ai/plugin`, which is 61 MB of `node_modules` per spawn
 * (measured on 1.18.35). The seed is a workaround for that check — an
 * undocumented dependency test inside someone else's binary — so it lives alone
 * here, with the rule it was derived from, rather than beside anything that
 * reads a config directory for its own sake.
 */

import fs from "node:fs";
import * as path from "node:path";
import {
  ensureResultDir,
  writeResultFile,
} from "../../result-file-permissions.js";

/** Where opencode resolves a config directory's dependencies from. */
const NODE_MODULES_DIR_NAME = "node_modules";

/** The npm project opencode's check reads. */
const PACKAGE_FILE_NAME = "package.json";
const LOCK_FILE_NAME = "package-lock.json";

/** The package opencode installs into every config directory it loads. */
const PLUGIN_PACKAGE = "@opencode-ai/plugin";

/**
 * The version the seed declares for `PLUGIN_PACKAGE`.
 *
 * opencode's check runs its install only when `<configDir>/node_modules` is
 * missing, or when `package-lock.json`'s root package (`packages[""]`) names
 * none of the dependencies that `package.json` and opencode's own `add` list
 * declare. Neither file's version is compared — a seed declaring `0.0.1`, or
 * `*`, short-circuits exactly like this one — so this pin can fall behind an
 * upgraded opencode without costing anything. Should opencode start comparing
 * versions, the check fails and opencode installs the version it pins, rewriting
 * both files: the same one-time install a directory with no seed at all pays.
 */
const PLUGIN_VERSION = "1.18.35";

/**
 * The seed manifest: exactly what a real install leaves, without the installed
 * bytes.
 */
const PACKAGE_JSON = `${JSON.stringify(
  { dependencies: { [PLUGIN_PACKAGE]: PLUGIN_VERSION } },
  null,
  2,
)}\n`;

/**
 * The seed lock for a directory. opencode's check reads one thing out of it —
 * the root package's declared dependency names — so it carries no resolved tree;
 * a real install rewrites it in full. The name is the directory's own, as npm
 * writes it.
 */
function packageLockJson(configDir: string): string {
  return `${JSON.stringify(
    {
      name: path.basename(configDir),
      lockfileVersion: 3,
      requires: true,
      packages: { "": { dependencies: { [PLUGIN_PACKAGE]: PLUGIN_VERSION } } },
    },
    null,
    2,
  )}\n`;
}

/** Write the seed into a config directory, creating the module directory it names. */
export function writeNpmSeed(configDir: string): void {
  ensureResultDir(path.join(configDir, NODE_MODULES_DIR_NAME));
  writeResultFile(path.join(configDir, PACKAGE_FILE_NAME), PACKAGE_JSON);
  writeResultFile(
    path.join(configDir, LOCK_FILE_NAME),
    packageLockJson(configDir),
  );
}

/** Remove the seed. Best effort, and safe when it is already gone. */
export function removeNpmSeed(configDir: string): void {
  try {
    fs.rmSync(path.join(configDir, NODE_MODULES_DIR_NAME), {
      recursive: true,
      force: true,
    });
    fs.rmSync(path.join(configDir, PACKAGE_FILE_NAME), { force: true });
    fs.rmSync(path.join(configDir, LOCK_FILE_NAME), { force: true });
  } catch {
    // Best effort: the seed is a temp-dir artifact, like the rest of the spawn's
    // staging files.
  }
}

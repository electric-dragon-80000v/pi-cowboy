/**
 * opencode/user-config.ts — stages a filtered copy of the parent's OpenCode
 * configuration in a spawn's config directory.
 *
 * opencode launches with `OPENCODE_CONFIG_DIR` naming the staging tree, so the
 * files the parent session reads are shadowed. The spawn still needs their
 * providers and general settings, but not the parts that belong to that session
 * alone: the definitions in `agent/`, the plugins it loaded, its permission rules,
 * or its update policy. Its MCP servers are copied: they are the parent's tools.
 *
 * Which roots are excluded, and which `configInclude` names are legal, is the
 * slice policy in config.ts. This module reads the files, filters them through
 * that policy, and writes the staged copies. Update checks are the launcher's:
 * it sets `OPENCODE_DISABLE_AUTOUPDATE`, so no staged value decides them.
 */

import fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import { isRecord } from "../../../predicates.js";
import { errorMessage } from "../../../utils.js";
import {
  ensureResultDir,
  writeResultFile,
} from "../../result-file-permissions.js";
import {
  EXCLUDED_OPENCODE_CONFIG_ROOTS,
  type OpencodeConfigRoot,
} from "./config.js";

/** The names opencode reads its user config under, in either dialect. */
export const USER_CONFIG_FILE_NAMES = [
  "opencode.json",
  "opencode.jsonc",
] as const;

/**
 * The name the parent's explicit config file is staged under — not one opencode
 * scans from a config directory. The launcher names this file with
 * `OPENCODE_CONFIG`, leaving opencode's own precedence between it and the staged
 * directory intact.
 */
const EXPLICIT_CONFIG_FILE_NAME = "explicit-config.json";

/**
 * The config directory the user's own opencode reads: its own
 * `OPENCODE_CONFIG_DIR` when set, else `opencode` under the XDG config home.
 * Resolved per call, like the staging directory.
 */
export function userOpencodeConfigDir(): string {
  const xdgConfigHome =
    envDir("XDG_CONFIG_HOME") ?? path.join(homedir(), ".config");
  return envDir("OPENCODE_CONFIG_DIR") ?? path.join(xdgConfigHome, "opencode");
}

/**
 * Write the filtered parent configuration into `configDir`, answering the staged
 * copy of the file `OPENCODE_CONFIG` names when there was one. Each file is read
 * and filtered separately and staged under its own name, so the name opencode
 * would read in the parent's directory resolves to its filtered counterpart
 * here. A missing, unreadable, or non-object file is skipped with a warning; the
 * spawn then starts on the staging alone rather than failing its launch.
 */
export function writeUserOpencodeConfig(input: {
  configDir: string;
  configInclude: readonly OpencodeConfigRoot[];
}): string | undefined {
  const sourceDir = userOpencodeConfigDir();
  const staged = new Map<string, Record<string, unknown>>();
  for (const name of USER_CONFIG_FILE_NAMES) {
    const sourceFile = path.join(sourceDir, name);
    const source = readUserConfig(sourceFile);
    if (source === undefined) continue;
    staged.set(name, filterUserConfig(source, input.configInclude, sourceFile));
  }

  writeStagedConfigs(input.configDir, staged);
  return stageExplicitConfig(input.configDir, input.configInclude);
}

/**
 * Stage a filtered copy of the file `OPENCODE_CONFIG` names. Handing the spawn
 * the parent's path would also hand it the roots the staging excludes (plugins,
 * permission rules, agent definitions). The launcher points the
 * variable at this copy, so opencode keeps its own precedence between it and the
 * staged directory.
 */
function stageExplicitConfig(
  configDir: string,
  configInclude: readonly OpencodeConfigRoot[],
): string | undefined {
  const sourceFile = envDir("OPENCODE_CONFIG");
  if (sourceFile === undefined) return undefined;
  const source = readUserConfig(sourceFile);
  if (source === undefined) return undefined;
  const stagedFile = path.join(configDir, EXPLICIT_CONFIG_FILE_NAME);
  writeResultFile(
    stagedFile,
    `${JSON.stringify(filterUserConfig(source, configInclude, sourceFile), null, 2)}\n`,
  );
  return stagedFile;
}

/** Read one config file, or undefined when it is absent or unusable. */
function readUserConfig(filePath: string): Record<string, unknown> | undefined {
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    if ((err as { code?: string } | undefined)?.code === "ENOENT") {
      return undefined;
    }
    console.warn(
      `[subagents] Could not read the opencode user config ${filePath}: ${errorMessage(err)}. The spawn starts without it.`,
    );
    return undefined;
  }

  const errors: import("jsonc-parser").ParseError[] = [];
  const parsed: unknown = parseJsonc(text, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length > 0) {
    console.warn(
      `[subagents] Ignoring malformed opencode user config ${filePath}: it is not valid JSONC. The spawn starts without it.`,
    );
    return undefined;
  }
  if (!isRecord(parsed)) {
    console.warn(
      `[subagents] Ignoring malformed opencode user config ${filePath}: it is not a JSON object. The spawn starts without it.`,
    );
    return undefined;
  }
  return parsed;
}

/**
 * Copy the user config without the excluded roots, then copy back the roots
 * `configInclude` names whole. `$schema` never survives: it is a reference to
 * the schema file, not a setting a staged config needs.
 */
function filterUserConfig(
  source: Record<string, unknown>,
  configInclude: readonly OpencodeConfigRoot[],
  filePath: string,
): Record<string, unknown> {
  const kept = structuredClone(source);
  for (const root of EXCLUDED_OPENCODE_CONFIG_ROOTS) delete kept[root];
  delete kept.$schema;

  for (const root of configInclude) {
    if (Object.hasOwn(source, root)) {
      kept[root] = structuredClone(source[root]);
    }
  }
  return rebaseFileReferences(kept, path.dirname(filePath)) as Record<
    string,
    unknown
  >;
}

/**
 * `{file:./path}` is resolved against the file that carried it. The staged copy
 * lives elsewhere, so each relative reference becomes the source-relative
 * absolute path; an already-absolute one is left alone.
 */
const FILE_REFERENCE = /\{file:([^}]+)\}/g;

function rebaseFileReferences(value: unknown, sourceDir: string): unknown {
  if (typeof value === "string") {
    return value.replace(
      FILE_REFERENCE,
      (_match, referenced: string) =>
        `{file:${absoluteReference(referenced, sourceDir)}}`,
    );
  }
  if (Array.isArray(value)) {
    return value.map((entry) => rebaseFileReferences(entry, sourceDir));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        rebaseFileReferences(entry, sourceDir),
      ]),
    );
  }
  return value;
}

function absoluteReference(reference: string, sourceDir: string): string {
  if (reference.startsWith("~/")) {
    return path.join(homedir(), reference.slice(2));
  }
  return path.isAbsolute(reference)
    ? reference
    : path.resolve(sourceDir, reference);
}

/** Write the staged configs, replacing any file a previous staging left. */
function writeStagedConfigs(
  configDir: string,
  staged: ReadonlyMap<string, Record<string, unknown>>,
): void {
  ensureResultDir(configDir);
  for (const name of [...USER_CONFIG_FILE_NAMES, EXPLICIT_CONFIG_FILE_NAME]) {
    fs.rmSync(path.join(configDir, name), { force: true });
  }
  for (const [name, config] of staged) {
    writeResultFile(
      path.join(configDir, name),
      `${JSON.stringify(config, null, 2)}\n`,
    );
  }
}

/** An environment directory, or undefined when unset or empty (XDG's default). */
function envDir(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === "" ? undefined : value;
}

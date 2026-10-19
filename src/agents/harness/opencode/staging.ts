/**
 * opencode/staging.ts — the config directory a spawn is pointed at: its path,
 * its assembly, and its removal.
 *
 * opencode launches with `OPENCODE_CONFIG_DIR` naming this directory and with
 * project config disabled, so everything the spawn gets is what lands here: the
 * definition its prompt is read from (definition.ts). Nothing here launches
 * anything or knows which pane the process will live in.
 *
 * The redirect also shadows the user's own `opencode.json` / `opencode.jsonc`,
 * which is where the providers live; a spawn without them has no provider and
 * fails ("User not found"). So the staging links the parent's user config file
 * in (parent-config-link.ts). Auth needs no link: `auth.json` lives in the XDG
 * data directory, which `OPENCODE_CONFIG_DIR` does not redirect.
 */

import fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { subagentResultDirFor } from "../../../paths.js";
import type { ToolSelection } from "../../harness.js";
import { envDir, linkParentConfigFile } from "../parent-config-link.js";
import { removeAgentDefinition, writeAgentDefinition } from "./definition.js";

/** The config directory's name inside a spawn's staging directory. */
const CONFIG_DIR_NAME = "opencode";

/** The names opencode reads its user config under, in either dialect. */
const USER_CONFIG_FILE_NAMES = ["opencode.json", "opencode.jsonc"] as const;

/**
 * The config directory the parent session's opencode reads: its own
 * `OPENCODE_CONFIG_DIR` when set, else `opencode` under the XDG config home.
 * Resolved per call, like the staging directory.
 */
function parentOpencodeConfigDir(): string {
  const xdgConfigHome =
    envDir("XDG_CONFIG_HOME") ?? path.join(homedir(), ".config");
  return envDir("OPENCODE_CONFIG_DIR") ?? path.join(xdgConfigHome, "opencode");
}

/**
 * `<subagentResultDirFor(id)>/opencode` — the config dir opencode is pointed at.
 */
export function opencodeConfigDir(subagentId: string): string {
  return path.join(subagentResultDirFor(subagentId), CONFIG_DIR_NAME);
}

/**
 * Write the whole staging tree and return the config dir.
 *
 * The system prompt is read before anything is created, so an unreadable prompt
 * file fails the spawn without leaving a half-built tree behind. A definition
 * file already in place is overwritten. The user config links are best-effort:
 * a parent with neither file has no providers to carry.
 */
export function writeOpencodeStaging(input: {
  subagentId: string;
  systemPromptFile: string;
  toolSelection: ToolSelection;
}): string {
  const systemPrompt = fs.readFileSync(input.systemPromptFile, "utf-8");
  const configDir = opencodeConfigDir(input.subagentId);
  writeAgentDefinition(configDir, {
    subagentId: input.subagentId,
    systemPrompt,
    toolSelection: input.toolSelection,
  });
  const parentDir = parentOpencodeConfigDir();
  for (const name of USER_CONFIG_FILE_NAMES) {
    linkParentConfigFile(path.join(parentDir, name), configDir);
  }
  return configDir;
}

/**
 * Remove the staging tree: the files each module staged, then the directory that
 * held them. Best effort and idempotent — every step is a no-op when its target
 * is already gone.
 */
export function removeOpencodeStaging(subagentId: string): void {
  const configDir = opencodeConfigDir(subagentId);
  removeAgentDefinition(configDir, subagentId);
  removeConfigDir(configDir);
}

/** Remove the directory the staged files lived in. Best effort. */
function removeConfigDir(configDir: string): void {
  try {
    fs.rmSync(configDir, { recursive: true, force: true });
  } catch {
    // Best effort: the config directory is a temp-dir artifact, like the rest of
    // the spawn's staging files.
  }
}

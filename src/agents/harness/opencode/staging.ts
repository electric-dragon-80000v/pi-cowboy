/**
 * opencode/staging.ts — the config directory a spawn is pointed at: its path,
 * its assembly, and its removal.
 *
 * opencode launches with `OPENCODE_CONFIG_DIR` naming this directory and with
 * project config disabled, so everything the spawn gets is what lands here: the
 * definition its prompt is read from (definition.ts). Nothing here launches
 * anything or knows which pane the process will live in.
 */

import fs from "node:fs";
import * as path from "node:path";
import { subagentResultDirFor } from "../../../paths.js";
import type { ToolSelection } from "../../harness.js";
import { removeAgentDefinition, writeAgentDefinition } from "./definition.js";

/** The config directory's name inside a spawn's staging directory. */
const CONFIG_DIR_NAME = "opencode";

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
 * file already in place is overwritten.
 */
export function writeOpencodeStaging(input: {
  subagentId: string;
  systemPromptFile: string;
  variant: string | null;
  toolSelection: ToolSelection;
}): string {
  const systemPrompt = fs.readFileSync(input.systemPromptFile, "utf-8");
  const configDir = opencodeConfigDir(input.subagentId);
  writeAgentDefinition(configDir, {
    subagentId: input.subagentId,
    systemPrompt,
    variant: input.variant,
    toolSelection: input.toolSelection,
  });
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

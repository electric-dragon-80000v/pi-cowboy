/**
 * opencode/definition.ts — the agent definition opencode reads a spawn's system
 * prompt from.
 *
 * opencode takes no system prompt on its argv: it reads one from the body of an
 * agent definition, so a spawn's prompt is staged as one. The file's name is the
 * agent's name, its frontmatter names the spawn and the rules it launches under,
 * and its body is the prompt, verbatim.
 */

import fs from "node:fs";
import * as path from "node:path";
import { stringify } from "yaml";
import { subagentTokenFor } from "../../../paths.js";
import type { ToolSelection } from "../../harness.js";
import {
  ensureResultDir,
  writeResultFile,
} from "../../result-file-permissions.js";
import { opencodePermissions } from "./permissions.js";

/** Where opencode looks for agent definitions inside a config directory. */
const AGENT_DIR_NAME = "agent";

/**
 * Definition files are markdown, and opencode takes the agent name from the file
 * name.
 */
const AGENT_FILE_SUFFIX = ".md";

export interface OpencodeAgentDefinition {
  readonly subagentId: string;
  readonly systemPrompt: string;
  /** `null` = no variant was requested, and the frontmatter carries no key for it. */
  readonly variant: string | null;
  readonly toolSelection: ToolSelection;
}

/**
 * The frontmatter opencode reads, in the order it is written.
 *
 * `mode: primary` is load-bearing: opencode falls back to its own default agent,
 * with no prompt at all, when the named agent is not a primary agent.
 * `description` carries the spawn identity, which stays visible in
 * `opencode debug agent <id>`.
 *
 * `lineWidth: 0` writes each value on one line whatever its length: `variant`
 * is model-provided text, and folding a long one would make the scalar's
 * emitted style depend on how long it happens to be.
 */
function frontmatter(input: OpencodeAgentDefinition): string {
  return stringify(
    {
      description: subagentTokenFor(input.subagentId),
      mode: "primary",
      permission: opencodePermissions(input.toolSelection),
      ...(input.variant === null ? {} : { variant: input.variant }),
    },
    { lineWidth: 0 },
  );
}

/** The agent definition: YAML frontmatter between its delimiters, then the prompt. */
export function opencodeAgentMarkdown(input: OpencodeAgentDefinition): string {
  return `---\n${frontmatter(input)}---\n\n${input.systemPrompt}`;
}

/** Where one spawn's definition lives inside the config directory it is staged in. */
function definitionFile(configDir: string, subagentId: string): string {
  return path.join(
    configDir,
    AGENT_DIR_NAME,
    `${subagentId}${AGENT_FILE_SUFFIX}`,
  );
}

/** Write the definition, creating the directory it lives in. */
export function writeAgentDefinition(
  configDir: string,
  input: OpencodeAgentDefinition,
): void {
  ensureResultDir(path.join(configDir, AGENT_DIR_NAME));
  writeResultFile(
    definitionFile(configDir, input.subagentId),
    opencodeAgentMarkdown(input),
  );
}

/** Remove the definition file. Best effort, and safe when it is already gone. */
export function removeAgentDefinition(
  configDir: string,
  subagentId: string,
): void {
  try {
    fs.rmSync(definitionFile(configDir, subagentId), { force: true });
  } catch {
    // Best effort: the definition is a temp-dir artifact, like the rest of the
    // spawn's staging files.
  }
}

/**
 * orchestrator-discovery.ts — Orchestrator file discovery, parsing, and merging.
 *
 * Scans `~/.pi/agent/orchestrators/`, `<project>/.agents/orchestrators/`, and
 * `<project>/.pi/orchestrators/` for `*.toml` (`name`, `display_name`,
 * `guidance`, `[cues]`). `guidance` is subagent-facing prose
 * copied verbatim into the child prompt — never rendered as a cue — defaulted
 * from the base template when omitted.
 *
 * Merging is per cue over the code `default` base; `display_name` / `guidance`
 * are replaced wholesale by the highest layer.
 */

import {
  parseTemplateToml,
  scanTemplateFilesInDir,
  type TemplateNotify,
  type TemplateScanWarning,
} from "../templates/template-files.js";
import { DEFAULT_ORCHESTRATORS } from "./default-orchestrators.js";
import {
  OrchestratorTemplateSchema,
  type OrchestratorTemplate,
} from "./orchestrator-template.js";
import type { OrchestratorConfig } from "./types.js";

// --- Types ---

/** One parsed orchestrator template. */
export type OrchestratorTemplateFile = OrchestratorTemplate;

const ORCHESTRATOR_SCAN_WARNING: TemplateScanWarning = {
  label: "Orchestrator",
  problem: "is not a valid orchestrator template and was skipped",
};

// --- parseOrchestratorFile ---

/** Parse one orchestrator template file. Shape and cue-variable failures throw here and become the scanner's one-line skip warning. */
export function parseOrchestratorFile(
  content: string,
): OrchestratorTemplateFile {
  return OrchestratorTemplateSchema.parse(parseTemplateToml(content));
}

// --- scanOrchestratorFilesInDir ---

/** Scan a directory for `.toml` orchestrators (empty array when missing). A nameless file is skipped; an invalid one is skipped with a one-line warning via `notify`. */
export async function scanOrchestratorFilesInDir(
  dirPath: string,
  notify?: TemplateNotify,
): Promise<OrchestratorTemplateFile[]> {
  return scanTemplateFilesInDir(
    dirPath,
    parseOrchestratorFile,
    (orchestrator) => orchestrator.name,
    notify,
    ORCHESTRATOR_SCAN_WARNING,
  );
}

// --- mergeOrchestrators ---

/**
 * Merge defaults with user, shared, and project overrides (highest to lowest:
 * project > shared > user > defaults). Every name starts from the code
 * `default` base; a loaded template replaces only the cue events it defines.
 */
export function mergeOrchestrators(
  defaults:
    Map<string, OrchestratorConfig> | Record<string, OrchestratorConfig>,
  userOrchestrators: OrchestratorTemplateFile[],
  sharedOrchestrators: OrchestratorTemplateFile[],
  projectOrchestrators: OrchestratorTemplateFile[],
): Map<string, OrchestratorConfig> {
  const result = new Map<string, OrchestratorConfig>(
    defaults instanceof Map ? defaults : Object.entries(defaults),
  );
  const base = result.get("default") ?? DEFAULT_ORCHESTRATORS.default;

  for (const layer of [
    userOrchestrators,
    sharedOrchestrators,
    projectOrchestrators,
  ]) {
    for (const template of layer) {
      if (!template.name) continue;
      result.set(
        template.name,
        applyOverride(
          result.get(template.name) ?? namedBase(template.name, base),
          template,
        ),
      );
    }
  }

  return result;
}

/**
 * The base a name that is not registered yet starts from: the `default`
 * template's cues and guidance, carried under this name — whose own name is
 * its display name, since only an explicit `display_name` names it otherwise.
 */
function namedBase(
  name: string,
  defaultConfig: OrchestratorConfig,
): OrchestratorConfig {
  return { ...defaultConfig, name, displayName: name };
}

function applyOverride(
  base: OrchestratorConfig,
  template: OrchestratorTemplateFile,
): OrchestratorConfig {
  return {
    ...base,
    name: template.name ?? base.name,
    displayName: template.display_name ?? base.displayName,
    cues: { ...base.cues, ...template.cues },
    guidance: template.guidance ?? base.guidance,
  };
}

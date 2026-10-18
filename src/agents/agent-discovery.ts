/**
 * agent-discovery.ts — Agent file discovery, parsing, and config merging.
 *
 * Scans user, shared, and project `*.toml` dirs through
 * AgentTemplateSchema into AgentConfigs. Per-field precedence:
 * default < user < shared < project.
 */

import {
  compactDefined,
  parseTemplateToml,
  scanTemplateFilesInDir,
  type TemplateNotify,
  type TemplateRefusal,
  type TemplateScanWarning,
} from "../templates/template-files.js";
import { AgentTemplateSchema, type AgentTemplate } from "./agent-template.js";
import type { AgentConfig, ModelsByFamily, ToolsByFamily } from "./types.js";

/** One parsed agent template. */
export type AgentTemplateFile = AgentTemplate;

/** Shape failures throw; the scanner turns that into a one-line skip warning. */
export function parseAgentFile(content: string): AgentTemplateFile {
  return AgentTemplateSchema.parse(parseTemplateToml(content));
}

const AGENT_SCAN_WARNING: TemplateScanWarning = {
  label: "Agent",
  problem: "is not a valid agent template and was skipped",
};

/**
 * Empty array when the directory doesn't exist. Stays shell-free: `notify` and
 * `refuse` are injected, so the session's rules — which harness ids this
 * session runs — are the caller's, not this module's.
 */
export async function scanAgentFilesInDir(
  dirPath: string,
  notify?: TemplateNotify,
  refuse?: TemplateRefusal<AgentTemplateFile>,
): Promise<AgentTemplateFile[]> {
  return scanTemplateFilesInDir(
    dirPath,
    parseAgentFile,
    (agent) => agent.name,
    notify,
    AGENT_SCAN_WARNING,
    refuse,
  );
}

/** Per-field precedence: project > shared > user > extension > defaults. A set field wins; undefined falls through. */
export function mergeAgents(
  defaults: Map<string, AgentConfig>,
  userAgents: AgentTemplateFile[],
  sharedAgents: AgentTemplateFile[],
  projectAgents: AgentTemplateFile[],
): Map<string, AgentConfig> {
  const result = new Map<string, AgentConfig>();

  for (const [name, config] of defaults) {
    result.set(name, { ...config });
  }

  mergeAgentOverrides(result, userAgents);
  mergeAgentOverrides(result, sharedAgents);
  mergeAgentOverrides(result, projectAgents);

  return result;
}

function mergeAgentOverrides(
  result: Map<string, AgentConfig>,
  agents: AgentTemplateFile[],
): void {
  for (const template of agents) {
    if (!template.name) continue;
    const existing = result.get(template.name);
    if (existing) {
      // display_name and description identify this file's agent, so a same-named
      // override replaces them rather than inheriting an earlier layer's values.
      const identity: Partial<AgentConfig> = {
        displayName: template.display_name,
        description: template.description ?? "",
      };
      const incoming = fromTemplate(template);
      const modelsByFamily = mergeModelsByFamily(
        existing.modelsByFamily,
        incoming.modelsByFamily,
      );
      const toolsByFamily = mergeToolsByFamily(
        existing.toolsByFamily,
        incoming.toolsByFamily,
      );
      result.set(template.name, {
        ...existing,
        ...incoming,
        ...(modelsByFamily ? { modelsByFamily } : {}),
        ...(toolsByFamily ? { toolsByFamily } : {}),
        ...identity,
      });
    } else {
      result.set(template.name, {
        ...BASE_DEFAULTS,
        ...fromTemplate(template),
      });
    }
  }
}

/**
 * Per-family merge of the layers' model keys: a later layer's key for one
 * family replaces that family's and leaves every other family's intact, the
 * same per-field precedence the rest of the config follows.
 */
function mergeModelsByFamily(
  existing: ModelsByFamily | undefined,
  incoming: ModelsByFamily | undefined,
): ModelsByFamily | undefined {
  const merged = { ...existing, ...incoming };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * Per-family merge of the layers' tool filters: a later layer's slice for one
 * family replaces that family's and leaves every other family's intact, the
 * same per-field precedence the rest of the config follows.
 */
function mergeToolsByFamily(
  existing: ToolsByFamily | undefined,
  incoming: ToolsByFamily | undefined,
): ToolsByFamily | undefined {
  const merged = { ...existing, ...incoming };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * Only explicitly-set fields (undefined falls through). An empty `inlined_skills` list is a set value,
 * so a higher layer clears inlining with it.
 */
function fromTemplate(template: AgentTemplateFile): Partial<AgentConfig> {
  const { harness } = template;
  const obj: Record<string, unknown> = {
    name: template.name,
    displayName: template.display_name,
    description: template.description,
    harnessType: template.harness_type,
    toolsByFamily: harness?.toolsByFamily,
    extensions: harness?.extensions,
    skills: harness?.skills,
    inlinedSkills: harness?.inlined_skills,
    modelsByFamily: harness?.modelsByFamily,
    thinkingLevel: harness?.thinking,
    variant: harness?.variant,
    hidden: template.hidden,
    fork: harness?.fork,
    includeContextFiles: harness?.include_context_files,
    worktreeCheckoutType: template.worktree_checkout_type,
    systemPrompt: template.system_prompt,
  };
  return compactDefined(obj) as Partial<AgentConfig>;
}

const BASE_DEFAULTS: AgentConfig = {
  name: "unknown",
  description: "",
  // extensions and skills intentionally omitted — resolved by global default
  inlinedSkills: [],
  systemPrompt: "",
};

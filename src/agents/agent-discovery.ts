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
  type TemplateScanWarning,
} from "../templates/template-files.js";
import { AgentTemplateSchema, type AgentTemplate } from "./agent-template.js";
import type { AgentConfig } from "./types.js";

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

/** Empty array when the directory doesn't exist. Stays shell-free: `notify` is the injected warning sink. */
export async function scanAgentFilesInDir(
  dirPath: string,
  notify?: TemplateNotify,
): Promise<AgentTemplateFile[]> {
  return scanTemplateFilesInDir(
    dirPath,
    parseAgentFile,
    (agent) => agent.name,
    notify,
    AGENT_SCAN_WARNING,
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

interface FilterArms {
  tools?: true | string[] | false;
  excludeTools?: string[];
  extensions?: true | string[] | false;
}

/** Arbitrate the one runtime boundary that can see both tool filter arms (parsed .toml): whitelist (string[]) wins, else blacklist. */
function arbitrateFilters(config: FilterArms): AgentConfig {
  const { tools, excludeTools, ...rest } = config;
  const out: FilterArms = { ...rest };

  if (tools !== undefined && excludeTools !== undefined) {
    if (Array.isArray(tools)) out.tools = tools;
    else out.excludeTools = excludeTools;
  } else {
    if (tools !== undefined) out.tools = tools;
    if (excludeTools !== undefined) out.excludeTools = excludeTools;
  }

  // The arbitration above guarantees a single arm; the compiler cannot infer that.
  return out as AgentConfig;
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
      result.set(
        template.name,
        arbitrateFilters({
          ...existing,
          ...fromTemplate(template),
          ...identity,
        }),
      );
    } else {
      result.set(
        template.name,
        arbitrateFilters({ ...BASE_DEFAULTS, ...fromTemplate(template) }),
      );
    }
  }
}

/**
 * Only explicitly-set fields (undefined falls through). May carry both filter
 * arms; arbitrated by the caller. An empty `inlined_skills` list is a set value,
 * so a higher layer clears inlining with it.
 */
function fromTemplate(template: AgentTemplateFile): Partial<AgentConfig> {
  const { harness } = template;
  const obj: Record<string, unknown> = {
    name: template.name,
    displayName: template.display_name,
    description: template.description,
    harnessType: template.harness_type,
    tools: harness?.tools,
    excludeTools: harness?.exclude_tools,
    extensions: harness?.extensions,
    skills: harness?.skills,
    inlinedSkills: harness?.inlined_skills,
    model: harness?.model,
    thinkingLevel: harness?.thinking,
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

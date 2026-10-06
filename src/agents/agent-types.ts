/**
 * agent-types.ts — Unified agent type registry.
 *
 * Precedence: default < extension < user < shared < project. Hidden agents
 * stay registered but are excluded from spawning.
 *
 * The registry is session state; it lives in the shell and is read and written
 * here through the shell getters.
 */

import { EXTENSION_AGENTS_DIR } from "../paths.js";
import { getSessionTemplates, type AgentTemplateRegistry } from "../shell.js";
import {
  scanAgentFilesInDir,
  mergeAgents,
  type AgentTemplateFile,
} from "./agent-discovery.js";
import { DEFAULT_AGENTS } from "./default-agents.js";
import type { AgentConfig } from "./types.js";

function registry(): AgentTemplateRegistry {
  return getSessionTemplates().agents;
}

interface RegisterAgentsOptions {
  disableDefaultAgents?: boolean;
}

/** Warning sink for unloadable agent files; injected so the scan layer stays shell-free. */
type DiscoveryNotify = (message: string, kind: "warning") => void;

export function registerAgents(
  userAgents: Map<string, AgentConfig>,
  options?: RegisterAgentsOptions,
): void {
  const agents = new Map<string, AgentConfig>();

  if (!options?.disableDefaultAgents) {
    for (const [name, config] of DEFAULT_AGENTS) {
      agents.set(name, config);
    }
  }

  for (const [name, config] of userAgents) {
    agents.set(name, config);
  }

  registry().agents = agents;
}

export function setAgentScanDirs(
  userDir: string,
  projectDir: string,
  sharedDir?: string,
): void {
  registry().scanDirs = {
    user: userDir,
    project: projectDir,
    shared: sharedDir ?? "",
  };
}

export async function scanAndMerge(options?: {
  disableDefaultAgents?: boolean;
  notify?: DiscoveryNotify;
}): Promise<Map<string, AgentConfig>> {
  const disableDefaults = options?.disableDefaultAgents === true;
  const notify = options?.notify;
  const scanDirs = registry().scanDirs;
  const [extensionAgents, userAgents, sharedAgents, projectAgents] =
    await Promise.all([
      disableDefaults
        ? Promise.resolve<AgentTemplateFile[]>([])
        : scanAgentFilesInDir(EXTENSION_AGENTS_DIR, notify),
      scanAgentFilesInDir(scanDirs.user, notify),
      scanAgentFilesInDir(scanDirs.shared, notify),
      scanAgentFilesInDir(scanDirs.project, notify),
    ]);
  const defaults = disableDefaults
    ? new Map<string, AgentConfig>()
    : DEFAULT_AGENTS;
  // First override layer, so default < extension < user < shared < project.
  const withExtension = mergeAgents(defaults, extensionAgents, [], []);
  return mergeAgents(withExtension, userAgents, sharedAgents, projectAgents);
}
/** Worktree agents follow the parent project's uniqueness rules. */
export async function discoverNewAgents(
  worktreeDir?: string,
  options?: { disableDefaultAgents?: boolean; notify?: DiscoveryNotify },
): Promise<number> {
  const merged = await scanAndMerge(options);
  const { agents } = registry();

  let count = 0;
  for (const [name, config] of merged) {
    if (!agents.has(name)) {
      agents.set(name, config);
      count++;
    }
  }

  if (worktreeDir) {
    const worktreeAgents = await scanAgentFilesInDir(
      worktreeDir,
      options?.notify,
    );
    const wtMerged = mergeAgents(new Map(), [], [], worktreeAgents);
    for (const [name, config] of wtMerged) {
      if (!agents.has(name)) {
        agents.set(name, config);
        count++;
      }
    }
  }

  return count;
}

/**
 * Result of resolving a type name against the registry.
 *
 * - resolved: exact match, or one case-insensitive match (key is canonical).
 * - ambiguous: several names differ only by case; never a silent pick.
 * - not-found: nothing matches, even after case folding.
 *
 * Only registered names resolve (displayName is display-only). Hidden agents
 * still resolve by name.
 */
type TypeResolution =
  | { kind: "resolved"; key: string }
  | { kind: "ambiguous"; candidates: string[] }
  | { kind: "not-found" };

export function resolveType(name: string): TypeResolution {
  const { agents } = registry();
  if (!name) return { kind: "not-found" };
  if (agents.has(name)) return { kind: "resolved", key: name };
  const lower = name.toLowerCase();
  const candidates: string[] = [];
  for (const key of agents.keys()) {
    if (key.toLowerCase() === lower) candidates.push(key);
  }
  if (candidates.length === 1) return { kind: "resolved", key: candidates[0] };
  if (candidates.length > 1) return { kind: "ambiguous", candidates };
  return { kind: "not-found" };
}

/** Resolve a type, discovering from worktreeDir on miss. Trust/validation checks stay in the caller. */
export async function resolveTypeOrDiscover(
  type: string,
  worktreeDir?: string,
  notify?: DiscoveryNotify,
): Promise<TypeResolution> {
  let resolution = resolveType(type);
  if (resolution.kind === "not-found") {
    await discoverNewAgents(worktreeDir, { notify });
    resolution = resolveType(type);
  }
  return resolution;
}

export function getAgentConfig(name: string): AgentConfig | undefined {
  const resolution = resolveType(name);
  return resolution.kind === "resolved"
    ? registry().agents.get(resolution.key)
    : undefined;
}

export function getAvailableTypes(): string[] {
  return [...registry().agents.entries()]
    .filter(([_, config]) => config.hidden !== true)
    .map(([name]) => name);
}

export function getAllTypes(): string[] {
  return [...registry().agents.keys()];
}

export interface ResolvedAgentConfig {
  displayName: string;
  description: string;
  /** Controls tool schema visibility. true = all, string[] = listed, false = none. */
  tools?: true | string[] | false;
  extensions: true | string[] | false;
  skills: true | string[] | false;
}

/** undefined means "not explicitly set" → resolve from the global default. */
function applyGlobalDefaults(
  skills: true | string[] | false | undefined,
  extensions: true | string[] | false | undefined,
  loadSkillsImplicitly: boolean,
  loadExtensionsImplicitly: boolean,
): { skills: true | string[] | false; extensions: true | string[] | false } {
  return {
    skills: skills ?? loadSkillsImplicitly,
    extensions: extensions ?? loadExtensionsImplicitly,
  };
}

export function getConfig(
  type: string,
  loadSkillsImplicitly: boolean = true,
  loadExtensionsImplicitly: boolean = true,
): ResolvedAgentConfig {
  const config = getAgentConfig(type);
  if (config) {
    const { skills, extensions, ...rest } = config;
    const defaults = applyGlobalDefaults(
      skills,
      extensions,
      loadSkillsImplicitly,
      loadExtensionsImplicitly,
    );
    return {
      displayName: rest.displayName ?? rest.name,
      description: rest.description,
      tools: rest.tools,
      ...defaults,
    };
  }

  const defaults = applyGlobalDefaults(
    undefined,
    undefined,
    loadSkillsImplicitly,
    loadExtensionsImplicitly,
  );
  return {
    displayName: "Agent",
    description: "General-purpose agent for complex, multi-step tasks",
    ...defaults,
  };
}

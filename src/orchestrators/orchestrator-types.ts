/**
 * orchestrator-types.ts — Unified orchestrator template registry.
 *
 * Embedded defaults overlaid with TOML templates. Precedence: default <
 * extension < user < shared < project; the code `default` is the per-cue base
 * for every registered name.
 *
 * The registry is session state; it lives in the shell and is read and written
 * here through the shell getters.
 */

import { EXTENSION_ORCHESTRATORS_DIR } from "../paths.js";
import {
  getSessionTemplates,
  type OrchestratorTemplateRegistry,
} from "../shell.js";
import { DEFAULT_ORCHESTRATORS } from "./default-orchestrators.js";
import {
  mergeOrchestrators,
  scanOrchestratorFilesInDir,
  type OrchestratorTemplateFile,
} from "./orchestrator-discovery.js";
import type { OrchestratorConfig } from "./types.js";

function registry(): OrchestratorTemplateRegistry {
  return getSessionTemplates().orchestrators;
}

interface RegisterOrchestratorsOptions {
  /** When true, skip the built-in DEFAULT_ORCHESTRATORS. */
  disableDefaultOrchestrators?: boolean;
}

/** Warning sink for unloadable orchestrator files; injected so the scan layer stays shell-free. */
type OrchestratorNotify = (message: string, kind: "warning") => void;

export function registerOrchestrators(
  loaded: Map<string, OrchestratorConfig>,
  options?: RegisterOrchestratorsOptions,
): void {
  const orchestrators = new Map<string, OrchestratorConfig>();

  if (!options?.disableDefaultOrchestrators) {
    for (const [name, config] of Object.entries(DEFAULT_ORCHESTRATORS)) {
      orchestrators.set(name, config);
    }
  }

  for (const [name, config] of loaded) {
    orchestrators.set(name, config);
  }

  registry().orchestrators = orchestrators;
}

export function setOrchestratorScanDirs(
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

/** Scan every orchestrator directory and merge it over the code defaults. */
export async function scanAndMergeOrchestrators(options?: {
  disableDefaultOrchestrators?: boolean;
  notify?: OrchestratorNotify;
}): Promise<Map<string, OrchestratorConfig>> {
  const disableDefaults = options?.disableDefaultOrchestrators === true;
  const notify = options?.notify;
  const scanDirs = registry().scanDirs;
  const [
    extensionOrchestrators,
    userOrchestrators,
    sharedOrchestrators,
    projectOrchestrators,
  ] = await Promise.all([
    disableDefaults
      ? Promise.resolve<OrchestratorTemplateFile[]>([])
      : scanOrchestratorFilesInDir(EXTENSION_ORCHESTRATORS_DIR, notify),
    scanOrchestratorFilesInDir(scanDirs.user, notify),
    scanOrchestratorFilesInDir(scanDirs.shared, notify),
    scanOrchestratorFilesInDir(scanDirs.project, notify),
  ]);
  const defaults = disableDefaults
    ? new Map<string, OrchestratorConfig>()
    : DEFAULT_ORCHESTRATORS;
  const withExtension = mergeOrchestrators(
    defaults,
    extensionOrchestrators,
    [],
    [],
  );
  return mergeOrchestrators(
    withExtension,
    userOrchestrators,
    sharedOrchestrators,
    projectOrchestrators,
  );
}

/** Resolve a name to its config: exact match wins, then a single case-insensitive one. `undefined` when nothing matches — including a case-ambiguous name, where picking one would be a guess. */
export function resolveOrchestrator(
  name: string,
): OrchestratorConfig | undefined {
  const { orchestrators } = registry();
  if (!name) return undefined;
  const exact = orchestrators.get(name);
  if (exact) return exact;

  const lower = name.toLowerCase();
  const candidates: OrchestratorConfig[] = [];
  for (const [key, config] of orchestrators) {
    if (key.toLowerCase() === lower) candidates.push(config);
  }
  return candidates.length === 1 ? candidates[0] : undefined;
}

export function getOrchestrator(name: string): OrchestratorConfig | undefined {
  return resolveOrchestrator(name);
}

/** Registered orchestrator names, in registration order. */
export function getAvailableOrchestrators(): string[] {
  return [...registry().orchestrators.values()].map((config) => config.name);
}

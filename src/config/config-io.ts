/**
 * config-io.ts — config persistence with global + project override layers.
 * Effective config merges project over global over built-in defaults; each
 * file stores only its own keys and the merged config is never written back.
 * The project layer may carry only model and concurrency keys; a key it may
 * not carry does not apply. A malformed project file is never overwritten.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { SubagentsConfig } from "../models/model-precedence.js";
import { DEFAULT_HARNESS, parseHarnessId } from "../agents/harness.js";
import { defaultExtensionDir, EXTENSION_NAME } from "../paths.js";
import { isRecord } from "../predicates.js";
import {
  DEFAULT_WORKTREE_CHECKOUT_TYPE,
  DEFAULT_WORKTREE_MATERIALIZATION,
  parseWorktreeCheckoutType,
  parseWorktreeMaterialization,
} from "../spawn/worktree-policy.js";
import { DEFAULT_AGENT_TYPE, DEFAULT_ORCHESTRATOR_NAME } from "../types.js";
import { errorMessage } from "../utils.js";
import { CONFIG_AGENT_NON_MODEL_KEYS } from "./types.js";
import { validateRawLayer } from "./config-validation.js";

/** File name of the config in the extension dir and a project's `.pi/<extension>` dir. */
const CONFIG_FILE_NAME = "config.json";

/**
 * Resolved at call time: the extension dir can be redirected per process, so
 * it must never be snapshotted at module scope.
 */
function configPath(): string {
  return path.join(defaultExtensionDir(), CONFIG_FILE_NAME);
}

/** Resolved at call time (see configPath). */
export function customPromptPath(): string {
  return path.join(defaultExtensionDir(), "prompt.md");
}

export const VALID_SYSTEM_PROMPT_MODES = new Set<string>([
  "replace",
  "inherit",
  "custom",
]);

/** Default concurrency config — used for resets. */
const DEFAULT_CONCURRENCY: SubagentsConfig["concurrency"] = {
  default: 4,
};

/** Default agent settings — merged into loaded config so callers get a complete shape. */
const DEFAULT_AGENT: SubagentsConfig["agent"] = {
  default: null,
  defaultAgentType: DEFAULT_AGENT_TYPE,
  defaultOrchestrator: DEFAULT_ORCHESTRATOR_NAME,
  systemPromptMode: "replace",
  includeContextFiles: true,
  disableDefaultAgents: false,
  extensionEnabled: true,
  showActiveIndicator: true,
  grazingEnabled: true,
  worktreeMaterialization: DEFAULT_WORKTREE_MATERIALIZATION,
  worktreeCheckoutType: DEFAULT_WORKTREE_CHECKOUT_TYPE,
  harnessType: DEFAULT_HARNESS,
};

export type ConfigTarget = "session" | "global" | "project";

export type ProjectLayerStatus =
  "untrusted" | "absent" | "loaded" | "malformed";

export interface RawConcurrency {
  default?: number;
  providers?: Record<string, number>;
  models?: Record<string, number>;
}

export interface RawConfig {
  agent?: Record<string, unknown>;
  concurrency?: RawConcurrency;
}

export interface LoadedConfig {
  global: RawConfig;
  project: RawConfig | null;
  projectStatus: ProjectLayerStatus;
}

/** Persistence port consumed by ConfigStore. */
export interface ConfigIO {
  load(): LoadedConfig;
  /** False while the loaded global file is malformed; such a file is never overwritten. */
  isGlobalWritable(): boolean;
  saveGlobal(config: RawConfig): void;
  saveProject(config: RawConfig): void;
}

/** Agent keys a project file may set: the model family plus per-type overrides. */
export const MODEL_FAMILY_KEYS = new Set(["default", "defaultThinking"]);

/** True when a project file may carry this agent key (model keys only). */
export function isProjectAllowedAgentKey(key: string): boolean {
  return (
    MODEL_FAMILY_KEYS.has(key) || !CONFIG_AGENT_NON_MODEL_KEYS.includes(key)
  );
}

/** Read + validate the project file. null = absent, "malformed" = invalid. */
type ProjectRead = { raw: RawConfig } | "malformed" | null;

/** The global layer always loads, empty on failure. A file it could not parse is not written over. */
type GlobalRead = { raw: RawConfig; malformed: boolean };

/**
 * Each save touches only its own layer. A malformed project file is never
 * written; without a project dir the project layer is untrusted. A malformed
 * global file is reported and never written either.
 */
export function createConfigIO(projectDir?: string): ConfigIO {
  const projectPath = projectDir
    ? path.join(projectDir, EXTENSION_NAME, CONFIG_FILE_NAME)
    : null;
  let projectStatus: ProjectLayerStatus = projectDir ? "absent" : "untrusted";
  let projectRaw: RawConfig | null = null;
  let globalMalformed = false;

  return {
    load: () => {
      const globalRead = readGlobalRaw();
      const global = globalRead.raw;
      globalMalformed = globalRead.malformed;
      if (projectPath) {
        const read = readProjectRaw(projectPath);
        if (read === null) {
          projectRaw = null;
          projectStatus = "absent";
        } else if (read === "malformed") {
          projectRaw = null;
          projectStatus = "malformed";
        } else {
          projectRaw = read.raw;
          projectStatus = "loaded";
        }
      } else {
        projectRaw = null;
        projectStatus = "untrusted";
      }
      return { global, project: projectRaw, projectStatus };
    },
    isGlobalWritable: () => !globalMalformed,
    saveGlobal: (config) => {
      if (globalMalformed) {
        console.warn(
          "[subagents] Refusing to write global config (malformed); change not saved",
        );
        return;
      }
      writeJsonAtomic(configPath(), config);
    },
    saveProject: (config) => {
      if (
        !projectPath ||
        projectStatus === "malformed" ||
        projectStatus === "untrusted"
      ) {
        console.warn(
          `[subagents] Refusing to write project config (${projectStatus}); change not saved`,
        );
        return;
      }
      writeJsonAtomic(projectPath, config);
    },
  };
}

/**
 * Project keys win; absent keys inherit from global. Non-model project agent
 * keys are dropped. Concurrency merges per entry. Pure — no I/O.
 */
export function mergeLayers(
  global: RawConfig,
  project: RawConfig | null,
): RawConfig {
  const agent = { ...global.agent };
  if (project?.agent) {
    for (const [key, value] of Object.entries(project.agent)) {
      if (isProjectAllowedAgentKey(key)) agent[key] = value;
    }
  }
  return {
    agent,
    concurrency: mergeRawConcurrency(global.concurrency, project?.concurrency),
  };
}

/** Highest priority last. Never emits `default: undefined`, which would override the baked default in mergeDefaults' spread. */
function mergeRawConcurrency(
  ...layers: Array<RawConcurrency | undefined>
): RawConcurrency {
  const out: RawConcurrency = {};
  const providers: Record<string, number> = {};
  const models: Record<string, number> = {};
  for (const layer of layers) {
    if (!layer) continue;
    if (layer.default !== undefined) out.default = layer.default;
    Object.assign(providers, layer.providers ?? {});
    Object.assign(models, layer.models ?? {});
  }
  if (Object.keys(providers).length > 0) out.providers = providers;
  if (Object.keys(models).length > 0) out.models = models;
  return out;
}

/** Bake hardcoded defaults into a raw config. */
export function mergeDefaults(raw: RawConfig): SubagentsConfig {
  // Spread form so the loaded value wins; values come from JSON, hence the casts.
  const concurrency = {
    ...DEFAULT_CONCURRENCY,
    ...raw.concurrency,
  } as SubagentsConfig["concurrency"];
  const agent = {
    ...DEFAULT_AGENT,
    ...raw.agent,
  } as SubagentsConfig["agent"];
  agent.worktreeMaterialization =
    parseWorktreeMaterialization(agent.worktreeMaterialization) ??
    DEFAULT_WORKTREE_MATERIALIZATION;
  agent.worktreeCheckoutType =
    parseWorktreeCheckoutType(agent.worktreeCheckoutType) ??
    DEFAULT_WORKTREE_CHECKOUT_TYPE;
  agent.harnessType = parseHarnessId(agent.harnessType) ?? DEFAULT_HARNESS;
  return {
    agent,
    concurrency,
  };
}

/** A missing file reads as {}; an unparsable one warns, reads as {}, and is not written over. */
function readGlobalRaw(): GlobalRead {
  let text: string;
  try {
    text = fs.readFileSync(configPath(), "utf-8");
  } catch (err) {
    if ((err as { code?: string } | undefined)?.code === "ENOENT") {
      return { raw: {}, malformed: false };
    }
    return warnMalformedGlobal(err);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return warnMalformedGlobal(err);
  }
  // Per-value validation: drop bad values with a warning, keep valid keys.
  return { raw: validateRawLayer(parsed, configPath()), malformed: false };
}

function warnMalformedGlobal(err: unknown): GlobalRead {
  console.warn(
    `[subagents] Ignoring malformed global config ${configPath()}: ${errorMessage(err)}`,
  );
  return { raw: {}, malformed: true };
}

/** Missing reads as absent; unreadable/invalid warns and reads as malformed. */
function readProjectRaw(projectPath: string): ProjectRead {
  if (!fs.existsSync(projectPath)) return null;
  let text: string;
  try {
    text = fs.readFileSync(projectPath, "utf-8");
  } catch (err) {
    console.warn(
      `[subagents] Ignoring malformed project config ${projectPath}: ${errorMessage(err)}`,
    );
    return "malformed";
  }
  return parseProjectContents(text, projectPath);
}

/** Malformed input warns and reads as "malformed". */
function parseProjectContents(text: string, filePath: string): ProjectRead {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    console.warn(
      `[subagents] Ignoring malformed project config ${filePath}: ${errorMessage(err)}`,
    );
    return "malformed";
  }
  if (!isRecord(parsed)) {
    console.warn(
      `[subagents] Ignoring malformed project config ${filePath}: not a JSON object`,
    );
    return "malformed";
  }
  const raw = parsed as RawConfig;
  if (raw.agent !== undefined && !isRecord(raw.agent))
    return malformedSection(filePath, "agent");
  if (raw.concurrency !== undefined && !isRecord(raw.concurrency)) {
    return malformedSection(filePath, "concurrency");
  }
  if (
    raw.concurrency?.providers !== undefined &&
    !isRecord(raw.concurrency.providers)
  ) {
    return malformedSection(filePath, "concurrency.providers");
  }
  if (
    raw.concurrency?.models !== undefined &&
    !isRecord(raw.concurrency.models)
  ) {
    return malformedSection(filePath, "concurrency.models");
  }
  return { raw: validateRawLayer(raw, filePath) };
}

function malformedSection(projectPath: string, section: string): "malformed" {
  console.warn(
    `[subagents] Ignoring malformed project config ${projectPath}: "${section}" is not a JSON object`,
  );
  return "malformed";
}

function writeJsonAtomic(filePath: string, config: unknown): void {
  const tmpPath = filePath + ".tmp";
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2), "utf-8");
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    console.error(`[subagents] Failed to save config: ${errorMessage(err)}`);
  }
}

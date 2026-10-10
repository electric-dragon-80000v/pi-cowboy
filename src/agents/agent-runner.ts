/**
 * agent-runner.ts — Launch-plan building for herdr-pane subagents.
 *
 * Produces a `SubagentLaunchPlan`: staged prompt files and the launch
 * context, with the argv owned by the resolved harness (prompt text compiled
 * by `../prompt/subagent-system-prompt.js`). The child process owns extension
 * discovery and tool validation.
 */

import fs from "node:fs";
import path from "node:path";
import {
  SettingsManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { errorMessage } from "../utils.js";
import {
  agentDir,
  subagentResultDirFor,
  subagentResultFileFor,
  subagentSystemFileFor,
  subagentTaskFileFor,
} from "../paths.js";
import { type AgentWorktree, type RunTunables } from "../types.js";
import { getStore } from "../shell.js";
import {
  buildSubagentSystemPrompt,
  buildWorktreeBranchSection,
} from "../prompt/subagent-system-prompt.js";
import type {
  ExtensionLaunchMode,
  HarnessId,
  SkillLaunchMode,
  ToolSelection,
} from "./harness.js";
import { harnessFor } from "./harness/registry.js";
import type { AgentConfig, SubagentType } from "./types.js";
import {
  getAgentConfig,
  getConfig,
  type ResolvedAgentConfig,
} from "./agent-types.js";
import { ensureResultDir, writeResultFile } from "./result-file-permissions.js";
import { resolveHarnessType } from "./spawn-defaults.js";

// Re-exported for consumers importing it from this module.
export { buildWorktreeBranchSection };

// ── Launch plan ─────────────────────────────────────────────────────

/**
 * Resolve the skill mode: `default` leaves pi's own discovery alone, so an
 * implicit `skills: true` reaches the agent through pi's skill section.
 * `none` suppresses that discovery because the extension decides the agent's
 * skills itself — an explicit list is rendered into the prompt here, and
 * `skills: false` withholds skills entirely.
 */
function resolveSkillMode(
  skills: ResolvedAgentConfig["skills"],
  agentConfig: AgentConfig | undefined,
): SkillLaunchMode {
  // An empty inlined list inlines nothing, so it must not suppress pi's own
  // skills. The length test, not an isArray test, is what keeps that true.
  const inlinedSkills = agentConfig?.inlinedSkills ?? [];
  const extensionDecidesSkills =
    skills === false || Array.isArray(skills) || inlinedSkills.length > 0;
  return extensionDecidesSkills ? { kind: "none" } : { kind: "default" };
}

type ExtensionPackageSource = string | { source: string };

/** Reads only SettingsManager configuration — never loads, crawls, or inspects extensions; the child pi owns that. */
function resolveExtensionSources(
  entries: readonly string[],
  settings: {
    packages: readonly ExtensionPackageSource[];
    extensionPaths: readonly string[];
  },
  cwd: string,
): string[] {
  const sources = new Map<string, string | null>();

  const addSource = (name: string, source: string): void => {
    const key = name.toLowerCase();
    const previous = sources.get(key);
    if (previous === undefined) sources.set(key, source);
    else if (previous !== source) sources.set(key, null);
  };

  for (const packageEntry of settings.packages) {
    const source =
      typeof packageEntry === "string" ? packageEntry : packageEntry.source;
    const name = extensionSourceName(source);
    if (name) addSource(name, source);
  }
  for (const extensionPath of settings.extensionPaths) {
    const name = extensionSourceName(extensionPath);
    if (name) addSource(name, extensionPath);
  }

  return entries.map((entry) => {
    if (isPiExtensionSource(entry)) return entry;
    if (isExistingPath(entry, cwd)) return entry;

    const name = extensionEntryName(entry);
    const source = sources.get(name.toLowerCase());
    if (source === null) {
      throw new Error(
        `Extension entry "${entry}" is ambiguous in pi settings; more than one source matches its name. The agent did not start.`,
      );
    }
    if (source === undefined) {
      throw new Error(
        `Extension entry "${entry}" is not in the pi settings and is not an npm:, git:, or path source. The agent did not start.`,
      );
    }
    return source;
  });
}

function isPiExtensionSource(value: string): boolean {
  return value.startsWith("npm:") || value.startsWith("git:");
}

function isExistingPath(value: string, cwd: string): boolean {
  if (path.isAbsolute(value)) return fs.existsSync(value);
  return fs.existsSync(path.resolve(cwd, value));
}

function extensionEntryName(value: string): string {
  const slashIndex = value.indexOf("/");
  return (slashIndex === -1 ? value : value.slice(0, slashIndex)).toLowerCase();
}

function extensionSourceName(source: string): string | undefined {
  const withoutFragment = source.split("#", 1)[0].replace(/[\\/]$/, "");
  if (!withoutFragment) return undefined;

  if (withoutFragment.startsWith("npm:")) {
    const packageSpec = withoutFragment.slice("npm:".length);
    const packageName = packageSpec.startsWith("@")
      ? packageSpec.split("/", 2).at(1)?.split("@", 1)[0]
      : packageSpec.split("@", 1)[0];
    return packageName?.toLowerCase();
  }

  const sourcePath = withoutFragment.startsWith("git:")
    ? withoutFragment.slice("git:".length)
    : withoutFragment;
  const base = path.basename(sourcePath);
  const name = path.basename(base, path.extname(base));
  if (name === "index") {
    const parent = path.basename(path.dirname(sourcePath));
    return parent || undefined;
  }
  return name || undefined;
}

function notifyLaunchConfigurationError(
  ctx: ExtensionContext,
  message: string,
): never {
  ctx.ui.notify(`[cowboy] ${message}`, "error");
  throw new Error(message);
}

/**
 * The parent session's persisted file, when the runtime has one. `--fork`
 * needs a real path, so an ephemeral (`--no-session`) session has nothing to
 * fork; absence is reported rather than passed through as an empty argument.
 */
function resolveParentSessionFile(ctx: ExtensionContext): string | undefined {
  const source = ctx as unknown as {
    sessionFile?: string;
    sessionManager?: { getSessionFile?: () => string | undefined };
  };
  const candidate =
    source.sessionFile ?? source.sessionManager?.getSessionFile?.();
  if (!candidate) return undefined;
  return candidate;
}

function resolveToolCliEntries(
  entries: readonly string[],
  optionName: "tools" | "excludeTools",
): string[] {
  const resolved = new Set<string>();
  for (const entry of entries) {
    // pi takes bare tool names. An extension's tools are named by the extension
    // itself, so there is nothing to qualify here and nothing to strip.
    if (!entry) {
      throw new Error(`Empty entry in ${optionName} is not supported`);
    }
    resolved.add(entry);
  }
  return [...resolved];
}

export interface SubagentLaunchPlan {
  /** Cosmetic herdr agent name. */
  name?: string;
  /** Working directory for the pane (resolved worktree path or parent cwd). */
  cwd: string;
  systemPrompt?: string;
  /**
   * Absolute path pi receives in `--system-prompt`. pi reads a file whenever
   * the value names an existing path, so the multi-line prompt never crosses
   * herdr's single-line shell encoder.
   */
  systemPromptFile?: string;
  /** The complete argv the pane runs (task included — the harness decides how it rides). */
  piArgs: string[];

  resultFile?: string;
  /** `null` = no model override was requested. */
  modelKey: string | null;
  taskSlug?: string;
  /** The harness that owns the pane `piArgs` launches into. */
  harness: HarnessId;
}

interface LaunchTunables extends RunTunables {
  agentId?: string;
  cwd?: string;
  projectTrusted?: boolean;
}

interface LaunchExtras {
  description: string;
  /** Worktree coordinates with ownership; absent for parent-cwd runs. */
  worktree?: AgentWorktree;
  /** The subagent-facing guidance the resolved orchestration template declares, rendered as the system prompt's final block. */
  agentGuidance?: string;
}

/** The child pi owns extension discovery and tool validation; this only forwards configuration. */
export async function buildLaunchPlan(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  type: SubagentType,
  prompt: string,
  options: LaunchTunables & LaunchExtras,
): Promise<SubagentLaunchPlan> {
  const store = getStore();
  const effectiveCwd = options.cwd ?? ctx.cwd;

  const config = getConfig(
    type,
    store.agent.loadSkillsImplicitly,
    store.agent.loadExtensionsImplicitly,
  );
  const agentConfig = getAgentConfig(type);
  const harnessType = resolveHarnessType(type);
  const skillMode = resolveSkillMode(config.skills, agentConfig);

  const warnings: string[] = [];
  const bufferNotify = (msg: string) => {
    warnings.push(msg);
  };

  let extMode: ExtensionLaunchMode = { kind: "default" };
  if (config.extensions === false) {
    extMode = { kind: "none" };
  } else if (Array.isArray(config.extensions)) {
    if (config.extensions.length === 0) {
      extMode = { kind: "none" };
    } else {
      try {
        const settingsManager = SettingsManager.create(
          effectiveCwd,
          agentDir(),
          { projectTrusted: options.projectTrusted !== false },
        );
        extMode = {
          kind: "paths",
          paths: resolveExtensionSources(
            config.extensions,
            {
              packages: settingsManager.getPackages(),
              extensionPaths: settingsManager.getExtensionPaths(),
            },
            effectiveCwd,
          ),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        notifyLaunchConfigurationError(ctx, message);
      }
    }
  }
  let toolSelection: ToolSelection = { kind: "default" };
  try {
    if (agentConfig?.tools === false) {
      toolSelection = { kind: "none" };
    } else if (Array.isArray(agentConfig?.tools)) {
      toolSelection = {
        kind: "include",
        names: resolveToolCliEntries(agentConfig.tools, "tools"),
      };
    } else if (agentConfig?.excludeTools?.length) {
      toolSelection = {
        kind: "exclude",
        names: resolveToolCliEntries(agentConfig.excludeTools, "excludeTools"),
      };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    notifyLaunchConfigurationError(ctx, message);
  }

  // Neither payload crosses argv as content: herdr's `agent start` encodes
  // argv into the pane shell command and rejects control characters, so the
  // prompt rides as `--system-prompt <system.md>` and the task as `@<prompt.md>`.
  const agentId = options.agentId ?? "unknown";
  const resultDir = subagentResultDirFor(agentId);
  // Owner-only staging: these files may carry secrets; throws, never caught here.
  ensureResultDir(resultDir);
  const resultFile = subagentResultFileFor(agentId);
  const systemFile = subagentSystemFileFor(agentId);
  const taskFile = subagentTaskFileFor(agentId);

  const systemPrompt = await buildSubagentSystemPrompt({
    pi,
    ctx,
    type,
    agentConfig,
    config,
    cwd: effectiveCwd,
    globalSystemPromptMode: store.agent.systemPromptMode,
    globalIncludeContextFiles: store.agent.includeContextFiles,
    worktreePath: options.worktree?.path,
    expectedBranch: options.worktree?.branch,
    agentGuidance: options.agentGuidance,
    resultFile,
    notify: bufferNotify,
  });

  try {
    writeResultFile(systemFile, systemPrompt);
  } catch (err) {
    throw new Error(
      `cannot write the system prompt file ${systemFile}: ${errorMessage(err)}. The agent did not start.`,
      { cause: err },
    );
  }
  // pi falls back to literal prompt text when --system-prompt names no
  // existing path — that would silently launch with no instructions.
  if (!fs.existsSync(systemFile)) {
    throw new Error(
      `the system prompt file is missing after the write: ${systemFile}. The agent did not start.`,
    );
  }
  // Throws on failure: a launch without its task file must not proceed.
  writeResultFile(taskFile, prompt);

  const forkSessionFile = options.fork
    ? resolveParentSessionFile(ctx)
    : undefined;
  if (options.fork && forkSessionFile === undefined) {
    bufferNotify(
      "Fork session is enabled, but no parent session file is available; launching without --fork",
    );
  }

  // The harness owns the argv — including how the task rides — because the
  // CLI surface is the harness's, not the orchestrator's.
  const piArgs = harnessFor(harnessType).buildArgs({
    subagentId: agentId,
    systemPromptFile: systemFile,
    taskFile,
    resultFile,
    modelKey: options.modelSelection?.key ?? null,
    toolSelection,
    thinkingLevel: options.thinkingLevel ?? null,
    forkSessionFile: forkSessionFile ?? null,
    skills: skillMode,
    extensions: extMode,
    projectTrusted: options.projectTrusted !== false,
  });

  for (const msg of warnings) {
    ctx.ui.notify(`[cowboy] ${msg}`, "warning");
  }

  return {
    name: agentId,
    cwd: effectiveCwd,
    systemPrompt,
    systemPromptFile: systemFile,
    piArgs,
    resultFile,
    modelKey: options.modelSelection?.key ?? null,
    harness: harnessType,
  };
}

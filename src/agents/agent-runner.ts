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
import { errorMessage, modelChoiceKey } from "../utils.js";
import {
  agentDir,
  subagentEnvFileFor,
  subagentResultDirFor,
  subagentResultFileFor,
  subagentSystemFileFor,
  subagentTaskFileFor,
} from "../paths.js";
import { type AgentWorktree, type RunTunables } from "../types.js";
import { getHarnessRegistry, getStore } from "../shell.js";
import {
  buildSubagentSystemPrompt,
  buildWorktreeBranchSection,
} from "../prompt/subagent-system-prompt.js";
import {
  reservedEnvVarsOf,
  RESERVED_ENV_VARS_BY_FAMILY,
  type AnyHarnessId,
  type CodexLaunchInputs,
  type ExtensionLaunchMode,
  type HarnessEnvReservations,
  type HarnessFamily,
  type HarnessContinuation,
  type HarnessLaunch,
  type PiLaunchInputs,
  type SkillLaunchMode,
  type SubagentLaunchInputs,
  type ToolSelection,
} from "./harness.js";
import type { AgentMultiplexerKind, PaneControl } from "./agent-host.js";
import { stageLaunchEnv } from "./harness/launch-env.js";
import {
  mergeEnv,
  sanitizeEnv,
  trustedEnv,
  type EnvOverrides,
  type EnvProblem,
} from "./harness/env-overrides.js";
import type { AgentConfig, SubagentType } from "./types.js";
import {
  getAgentConfig,
  getConfig,
  type ResolvedAgentConfig,
} from "./agent-types.js";
import { ensureResultDir, writeResultFile } from "./result-file-permissions.js";

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
    // Each family writes bare tool names in its own vocabulary. An
    // extension's tools are named by the extension itself, so there is
    // nothing to qualify here and nothing to strip.
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
  /**
   * The system prompt text itself, as written to `launch.systemPromptFile`.
   */
  systemPrompt?: string;
  /**
   * The complete argv the harness built, whatever binary it launches. The name
   * is the seam's own vocabulary — the supervisor and herdr both spell it
   * `piArgs` — not a claim that the process is pi.
   */
  piArgs: string[];
  /**
   * The launch request `piArgs` was built from, and the same object a harness's
   * `prepare` receives: one construction site, so a field the launch adds
   * reaches both without a second copy to keep in step.
   */
  launch: HarnessLaunch;
  taskSlug?: string;
  /** The harness that owns the pane `piArgs` launches into. */
  harness: AnyHarnessId;
}

interface LaunchTunables extends RunTunables {
  agentId?: string;
  cwd?: string;
  projectTrusted?: boolean;
}

interface LaunchExtras {
  description: string;
  /** The harness the launch resolves, so the plan and the pool identity agree. */
  harness: AnyHarnessId;
  /** Worktree coordinates with ownership; absent for parent-cwd runs. */
  worktree?: AgentWorktree;
  /** The subagent-facing guidance the resolved orchestration template declares, rendered as the system prompt's final block. */
  agentGuidance?: string;
  /** The session a handover's launch continues; absent for every other launch. */
  continuation?: HarnessContinuation;
  /**
   * The session's pane surface, so the launch reserves the environment the
   * active multiplexer owns. Absent when a plan is built outside a live session.
   */
  pane?: PaneControl;
}

/**
 * The launch request for one harness. A built-in id is one of the closed
 * families below, so its own inputs are the only ones it can be handed; any
 * other registered id is a plugin harness, whose request carries the shared
 * inputs and the open arm's tag alone — its CLI-specific options live in its
 * own code, so nothing built-in-family-specific can reach it.
 */
function buildLaunchRequest(
  harnessType: AnyHarnessId,
  sharedInputs: SubagentLaunchInputs,
  piInputs: PiLaunchInputs,
  codexInputs: CodexLaunchInputs,
): HarnessLaunch {
  const registry = getHarnessRegistry();
  // The family the registry knows for this id, not its spelling: a derived
  // harness reads its base's family, so a variant of codex is handed codex's
  // request (trust included) without the registry saying it came from codex.
  switch (registry.family(harnessType)) {
    case "pi":
      return { ...sharedInputs, family: "pi", ...piInputs };
    case "opencode":
      return { ...sharedInputs, family: "opencode" };
    case "codex":
      return { ...sharedInputs, family: "codex", ...codexInputs };
    case "claude":
      return { ...sharedInputs, family: "claude" };
    case undefined: {
      if (registry.get(harnessType) === undefined) {
        throw new Error(`no harness registered for "${harnessType}"`);
      }
      return { ...sharedInputs, family: "plugin" };
    }
  }
}

/**
 * The harness's argv, from the id that owns the pane and the request this launch
 * carries. The registry narrows a built-in's launch to its own family request and
 * hands a plugin the shared inputs, so one family's argv cannot be built from
 * another family's inputs and no caller branches on origin.
 */
function buildHarnessArgs(
  harnessId: AnyHarnessId,
  launch: HarnessLaunch,
): string[] {
  return getHarnessRegistry().require(harnessId).buildArgs(launch);
}

/**
 * The environment names the active multiplexer supplies to a custom launcher of
 * this kind. The multiplexer sets them itself, so a configured entry for one
 * cannot be carried: it would overwrite the identity the multiplexer needs to
 * recognize the process.
 */
interface MultiplexerReservations {
  readonly name: string;
  readonly names: readonly string[];
}

/**
 * The multiplexer's reservations for a launch of this kind, or undefined when no
 * multiplexer hosts it — a plan built outside a live session reserves nothing.
 */
function multiplexerReservations(
  pane: PaneControl | undefined,
  agentKind: AgentMultiplexerKind | undefined,
): MultiplexerReservations | undefined {
  if (pane === undefined) return undefined;
  return {
    name: pane.kind,
    names:
      agentKind === undefined
        ? []
        : Object.keys(pane.launchEnvironment?.(agentKind) ?? {}),
  };
}

/**
 * The variables one launch carries, lowest to highest: the harness's own
 * defaults, the machine's table for this harness, the agent's own family table
 * over it, and the variables the harness's launch inherits from this process —
 * with the names the resolved family, the harness, or the active multiplexer
 * reserves dropped from the two configured tables.
 *
 * The harness's own declarations are read from the harness and never inferred
 * from a family, and the reserved set is not consulted for them: a name is
 * reserved because configuration may not supply it, not because the harness's
 * process may not. That is what lets a derived harness point a base family's
 * config directory at a variant's own directory while the user's config for that
 * name stays refused.
 */
function resolveLaunchEnv(
  defaults: Readonly<Record<string, string>> | undefined,
  configured: EnvOverrides | undefined,
  overrides: EnvOverrides | undefined,
  inherited: Readonly<Record<string, string>> | undefined,
  reserved: readonly string[],
  multiplexer: MultiplexerReservations | undefined,
  warn: (message: string) => void,
  harness: AnyHarnessId,
): EnvOverrides | undefined {
  const merged = mergeEnv(configured, overrides);
  const carried =
    merged === undefined
      ? undefined
      : trustedEnv(dropReserved(merged, reserved, multiplexer, warn, harness));
  const own = ownEnvOverrides(inherited, "inherited", warn, harness);
  // Defaults are the harness's statement about its own process, so they sit
  // below configuration and are never filtered by a reservation: a configured
  // name is the user's and can be refused, a default is the harness's.
  return mergeEnv(
    mergeEnv(ownEnvOverrides(defaults, "default", warn, harness), carried),
    own,
  );
}

/**
 * One configured env table without the names this launch reserves, warning per
 * drop. The warning names the owner: a harness and a multiplexer are different
 * systems, and only one of them explains the refusal.
 */
function dropReserved(
  merged: EnvOverrides,
  reserved: readonly string[],
  multiplexer: MultiplexerReservations | undefined,
  warn: (message: string) => void,
  harness: AnyHarnessId,
): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(merged)) {
    if (reserved.includes(name)) {
      warn(
        `Ignoring environment variable ${name} for ${harness}: it is reserved by the ${harness} harness and cannot be overridden`,
      );
      continue;
    }
    if (multiplexer?.names.includes(name)) {
      warn(
        `Ignoring environment variable ${name} for ${harness}: it is reserved by the ${multiplexer.name} multiplexer and cannot be overridden`,
      );
      continue;
    }
    kept[name] = value;
  }
  return kept;
}

/** Why an entry cannot be carried by the shell, as a clause the warning below spells out. */
const ENV_PROBLEM_TEXT: Record<EnvProblem, string> = {
  name: "not a valid environment variable name",
  reserved: "reserved",
  "not-string": "not a string",
  control: "carrying a control character",
};

/**
 * A table the harness declares about its own process — the variables it
 * inherits, or the defaults its launches carry — as one this layer can merge,
 * dropping whatever the shell could not read. `undefined` when it declares none
 * or every entry was dropped, so a launch with nothing to hand over stages no
 * file rather than an empty one.
 */
function ownEnvOverrides(
  entries: Readonly<Record<string, string>> | undefined,
  layer: "inherited" | "default",
  warn: (message: string) => void,
  harness: AnyHarnessId,
): EnvOverrides | undefined {
  if (entries === undefined) return undefined;
  const kept = sanitizeEnv(entries, {
    reserved: [],
    report: (name, problem) =>
      warn(
        `Ignoring ${layer} environment variable ${name} for ${harness}: it is ${ENV_PROBLEM_TEXT[problem]} and cannot be carried`,
      ),
  });
  return Object.keys(kept).length === 0 ? undefined : kept;
}

/**
 * The environment variable names this launch may not override: the resolved
 * family's own table plus any names declared by a plugin harness. A plugin ID
 * has no family, so its declaration constitutes its entire list.
 */
function familyReservations(
  family: HarnessFamily | undefined,
  registered: HarnessEnvReservations | undefined,
): readonly string[] {
  return [
    ...(family === undefined ? [] : RESERVED_ENV_VARS_BY_FAMILY[family]),
    ...(registered === undefined ? [] : reservedEnvVarsOf(registered)),
  ];
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
  const harnessType = options.harness;
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
  const family = getHarnessRegistry().family(harnessType);
  let toolSelection: ToolSelection = { kind: "default" };
  try {
    // Exactly one harness launches a spawn, so exactly one family's slice
    // decides: its names are already in that family's vocabulary. A family the
    // template does not name — a plugin's own family especially — launches
    // unfiltered, never with another family's list, and never translated.
    const filter =
      family === undefined ? undefined : agentConfig?.toolsByFamily?.[family];
    if (filter?.tools === false) {
      toolSelection = { kind: "none" };
    } else if (Array.isArray(filter?.tools)) {
      toolSelection = {
        kind: "include",
        names: resolveToolCliEntries(filter.tools, "tools"),
      };
    } else if (filter?.excludeTools?.length) {
      toolSelection = {
        kind: "exclude",
        names: resolveToolCliEntries(filter.excludeTools, "excludeTools"),
      };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    notifyLaunchConfigurationError(ctx, message);
  }

  const registered = getHarnessRegistry().get(harnessType);
  const env = resolveLaunchEnv(
    registered?.defaultEnv?.(),
    store.harnessEnv(harnessType),
    family === undefined ? undefined : agentConfig?.envByFamily?.[family],
    registered?.inheritedEnv?.(),
    familyReservations(family, registered),
    multiplexerReservations(options.pane, registered?.agentMultiplexerKind),
    bufferNotify,
    harnessType,
  );

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
  // Owner-only, like the files above: variables staged here are often credentials.
  const envFile = stageLaunchEnv(subagentEnvFileFor(agentId), env);

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
  // An empty prompt is no task: nothing is staged for it, and the harness is
  // handed no task to deliver, so the agent opens with its editor empty.
  const hasTask = prompt.trim() !== "";
  // Throws on failure: a launch with a task must not proceed without its file.
  if (hasTask) writeResultFile(taskFile, prompt);

  const forkSessionFile = options.fork
    ? resolveParentSessionFile(ctx)
    : undefined;
  if (options.fork && forkSessionFile === undefined) {
    bufferNotify(
      "Fork session is enabled, but no parent session file is available; launching without --fork",
    );
  }

  // The harness owns the argv — including how the task rides, and how the
  // level is spelled — because the CLI surface is the harness's, not the
  // orchestrator's. One request is built here, keyed by family, and the argv is
  // built from that same object: pi's flags only ever reach a pi-family
  // harness, and codex's trust only reaches codex.
  const sharedInputs: SubagentLaunchInputs = {
    subagentId: agentId,
    systemPromptFile: systemFile,
    taskFile: hasTask ? taskFile : null,
    resultFile,
    modelKey: modelChoiceKey(options.modelChoice) ?? null,
    thinking: options.modelChoice?.thinking ?? null,
    toolSelection,
    envFile,
    continuation: options.continuation ?? null,
  };
  const piInputs: PiLaunchInputs = {
    forkSessionFile: forkSessionFile ?? null,
    skills: skillMode,
    extensions: extMode,
    projectTrusted: options.projectTrusted !== false,
  };
  const codexInputs: CodexLaunchInputs = {
    projectTrusted: options.projectTrusted !== false,
  };
  const launch = buildLaunchRequest(
    harnessType,
    sharedInputs,
    piInputs,
    codexInputs,
  );
  const piArgs = buildHarnessArgs(harnessType, launch);

  for (const msg of warnings) {
    ctx.ui.notify(`[cowboy] ${msg}`, "warning");
  }

  return {
    name: agentId,
    cwd: effectiveCwd,
    systemPrompt,
    piArgs,
    launch,
    harness: harnessType,
  };
}

/**
 * model-precedence.ts — model resolution with explicit precedence.
 * Precedence chain (highest to lowest): agent-specific layers first, then the
 * generic defaults, then the parent.
 *   1. sessionOverrides[subagentType]  (session per-type override)
 *   2. config.agent[subagentType]      (config per-type override)
 *   3. agentConfig?.model              (agent config / agent template)
 *   4. sessionOverrides["default"]     (session default)
 *   5. the launching harness's default (pi's family: agent.default at any layer;
 *      any other harness: agent.defaultModelByHarness[harness], session first)
 *   6. parentModelId                   (inherit from parent; null when the parent has no model)
 *
 * The tool's per-call `model` parameter sits above this chain: when set, the
 * chain is not consulted; when unset, the chain decides.
 */

import type { ThinkingLevel } from "../types.js";
import { isPiFamilyHarness, type HarnessId } from "../agents/harness.js";
import type { SystemPromptMode } from "../agents/types.js";
import type {
  WorktreeCheckoutType,
  WorktreeMaterialization,
} from "../spawn/worktree-policy.js";

export interface SubagentsConfig {
  agent: {
    default: string | null;
    /** Default: "general-purpose". Global config only (not a model key). */
    defaultAgentType?: string;
    /** Default: "default". Global config only (not a model key). */
    defaultOrchestrator?: string;
    /** System prompt mode: replace (default), inherit parent, or custom file. */
    systemPromptMode?: SystemPromptMode;
    /** Default: true. */
    includeContextFiles?: boolean;
    /** Undefined = inherit from agent config. */
    defaultThinking?: ThinkingLevel;
    loadSkillsImplicitly?: boolean;
    loadExtensionsImplicitly?: boolean;
    /** When true, skip the embedded default agent at registration. */
    disableDefaultAgents?: boolean;
    /** When false, the Cowboy tools are inactive and no completion nudges are sent. Global config only. */
    extensionEnabled?: boolean;
    /** When false, the 🤠 presence marker is not drawn. Global config only. */
    showActiveIndicator?: boolean;
    /** When true, the herd may step to a neighbouring cell. Default false. Global config only. */
    grazingEnabled?: boolean;
    /** Relative values resolve against the repo root. */
    worktreeRoot?: string;
    /** "copy-on-write" (default) shares ignored state; "checkout" leaves git's classic checkout in place. */
    worktreeMaterialization?: WorktreeMaterialization;
    /** "clean" (default) keeps only a dirty parent's ignored state; "dirty" starts the worktree with its WIP. */
    worktreeCheckoutType?: WorktreeCheckoutType;
    /** Harness that agents launch under unless their template sets `harness_type`. Default: "pi". Global config only. */
    harnessType?: HarnessId;
    /**
     * The default model per harness, keyed by harness id: the pi family reads
     * `default` instead (one binary, one default), so only a non-pi harness has
     * an entry. A missing or null entry means that harness has no default.
     */
    defaultModelByHarness?: Record<string, string | null>;
    [agentType: string]:
      | string
      | null
      | undefined
      | boolean
      | number
      | Record<string, string | null>;
  };
  concurrency: {
    default: number;
    providers?: Record<string, number>;
    models?: Record<string, number>;
  };
}

/** Not persisted — cleared on session_start. */
export interface SessionModelOverrides {
  default: string | null;
  [agentType: string]: string | null | undefined;
}

interface ResolveModelOptions {
  subagentType: string;
  agentConfig?: { model?: string };
  config: Pick<SubagentsConfig, "agent">;
  /**
   * The launching harness's default, flattened across the layers that carry one
   * (session over project over global). The caller flattens it because which
   * harness launches — and therefore which key is read — is resolved the way
   * the launch resolves it, post-availability-fallback.
   */
  harnessDefault: string | null;
  /** Null when the parent session has no model: nothing further to inherit. */
  parentModelId: string | null;
  sessionOverrides?: SessionModelOverrides;
}

type ModelSource =
  | "session-per-type"
  | "session-default"
  | "config-per-type"
  | "harness-default"
  | "agent-template"
  | "parent";

/**
 * The default model one harness's spawns use. The pi family runs one binary, so
 * it reads the one default every layer already writes; any other harness reads
 * its own key, and an absent or null entry means it has no default. The session
 * layer sits above the merged file layers and is the caller's to apply.
 */
export function harnessDefaultModel(
  agent: Pick<SubagentsConfig["agent"], "default" | "defaultModelByHarness">,
  harnessId: HarnessId,
): string | null {
  if (isPiFamilyHarness(harnessId)) return agent.default ?? null;
  const configured = agent.defaultModelByHarness?.[harnessId];
  return isValidModelValue(configured) ? configured : null;
}

/**
 * Reports which chain position won, for callers that need the winning layer
 * (the Model settings menu's provenance tags). First non-empty value wins;
 * parentModelId is the final fallback. A null model means the whole chain
 * is unset and the parent has no model to inherit.
 */
export function resolveModelSource(options: ResolveModelOptions): {
  model: string | null;
  source: ModelSource;
} {
  const {
    subagentType,
    agentConfig,
    config,
    harnessDefault,
    parentModelId,
    sessionOverrides,
  } = options;

  // Models are always strings; the index signature also admits the scalar keys.
  // A model pinned for this agent type (session, config, or template) beats
  // any generic default; the generic defaults are consulted only when the
  // type itself has no model anywhere.
  const candidates: Array<[ModelSource, string | null | undefined]> = [
    ["session-per-type", sessionOverrides?.[subagentType]],
    [
      "config-per-type",
      config.agent[subagentType] as string | null | undefined,
    ],
    ["agent-template", agentConfig?.model],
    ["session-default", sessionOverrides?.["default"]],
    ["harness-default", harnessDefault],
  ];
  for (const [source, value] of candidates) {
    if (isValidModelValue(value)) return { model: value, source };
  }
  return { model: parentModelId, source: "parent" };
}

/** Model-only projection of resolveModelSource(). Null when nothing resolves. */
export function resolveModel(options: ResolveModelOptions): string | null {
  return resolveModelSource(options).model;
}

/** Null/undefined/empty read as unset. */
function isValidModelValue(value: string | null | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

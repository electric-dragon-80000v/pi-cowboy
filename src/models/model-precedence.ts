/**
 * model-precedence.ts — model resolution with explicit precedence.
 * Precedence chain (highest to lowest): agent-specific layers first, then the
 * generic defaults, then the parent.
 *   1. sessionOverrides[subagentType]  (session per-type override)
 *   2. config.agent[subagentType]      (config per-type override)
 *   3. agentConfig?.model              (agent config / agent template)
 *   4. sessionOverrides["default"]     (session global default)
 *   5. config.agent["default"]         (config global default)
 *   6. parentModelId                   (inherit from parent; null when the parent has no model)
 *
 * The tool's per-call `model` parameter sits above this chain: when set, the
 * chain is not consulted; when unset, the chain decides.
 */

import type { ThinkingLevel } from "../types.js";
import type { HarnessId } from "../agents/harness.js";
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
    [agentType: string]: string | null | undefined | boolean | number;
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
  /** Null when the parent session has no model: nothing further to inherit. */
  parentModelId: string | null;
  sessionOverrides?: SessionModelOverrides;
}

type ModelSource =
  | "session-per-type"
  | "session-default"
  | "config-per-type"
  | "config-default"
  | "agent-template"
  | "parent";

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
  const { subagentType, agentConfig, config, parentModelId, sessionOverrides } =
    options;

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
    ["config-default", config.agent["default"]],
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

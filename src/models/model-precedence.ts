/**
 * model-precedence.ts — model and thinking resolution with explicit precedence.
 * Model precedence chain (highest to lowest): agent-specific layers first, then
 * the generic defaults, then the parent.
 *   1. sessionOverrides[subagentType]  (session per-type override)
 *   2. config.agent[subagentType]      (config per-type override)
 *   3. agentConfig?.modelsByFamily[family] (the agent config / agent template,
 *      read only for the launching harness's family)
 *   4. sessionOverrides["default"]     (the pi family's session default — the
 *      only layer here written from pi's catalogue)
 *   5. the launching harness's default (pi's family: agent.default at any layer;
 *      any other harness: agent.defaultModelByHarness[harness], session first)
 *   6. parentModelId                   (inherit from parent; the pi family only,
 *      because a parent session runs pi and its key is therefore pi's
 *      vocabulary — nothing may carry that key to another harness)
 *
 * The tool's per-call `model` parameter sits above this chain: when set, the
 * chain is not consulted; when unset, the chain decides.
 *
 * A model key names an entry in one harness's catalogue, so every layer that
 * carries a key is read only by a launch whose harness can resolve it: step 3
 * reads the launching harness's family entry and nothing else, step 4 is pi's
 * session default and is therefore pi's alone, and step 6 is gated the same way.
 * A key written for pi contributes nothing to an opencode launch, which falls
 * through to its own default.
 *
 * Thinking resolves through the same layers, shorter by the two pi-only steps:
 * a thinking token names a level in one harness's vocabulary, so it never
 * inherits from the parent (a parent session runs pi), and the per-type
 * session override is a thinking map of its own rather than the model map:
 *   1. sessionThinking[subagentType]        (session per-type override)
 *   2. config.agent.thinking[subagentType]  (config per-type override)
 *   3. agentConfig?.thinkingByFamily[family] (the agent template, read only for
 *      the launching harness's family)
 *   4. the launching harness's default (pi's family: agent.defaultThinking at
 *      any layer; any other harness: agent.defaultThinkingByHarness[harness])
 *   5. no layer names a level — the run asks for none, and the harness's own
 *      default applies.
 *
 * The chain does not rewrite a level to suit the model: a token is one
 * harness's vocabulary, and only that harness can say what it accepts, so the
 * winner is carried as written and a harness that knows its own closed
 * vocabulary warns (without refusing) about a token outside it.
 */

import type { ThinkingLevel } from "../types.js";
import {
  isPiFamilyHarness,
  type AnyHarnessId,
  type HarnessFamily,
} from "../agents/harness.js";
import type {
  ModelsByFamily,
  SystemPromptMode,
  ThinkingByFamily,
} from "../agents/types.js";
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
    /** Undefined = inherit from agent config. The pi family's default level. */
    defaultThinking?: ThinkingLevel;
    /**
     * The default thinking token per harness, keyed by harness id: the pi family
     * reads `defaultThinking` instead (one binary, one default), so only a
     * non-pi harness has an entry. The token is in that harness's own
     * vocabulary. A missing or null entry means that harness has no default.
     */
    defaultThinkingByHarness?: Record<string, string | null>;
    /**
     * Per-type thinking tokens, keyed by agent type, each in the vocabulary of
     * the harness that type launches under. A key names no harness, so the
     * token it holds is only meaningful for that type's own launch.
     */
    thinking?: Record<string, string | null>;
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
    harnessType?: AnyHarnessId;
    /**
     * The default model per harness, keyed by harness id: the pi family reads
     * `default` instead (one binary, one default), so only a non-pi harness has
     * an entry. A missing or null entry means that harness has no default. The
     * key set is open — a plugin harness's id is as valid as a built-in's — and
     * sparse, so it is a plain record.
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
    harnesses?: Partial<Record<AnyHarnessId, number>>;
    providers?: Partial<Record<string, number>>;
    models?: Partial<Record<string, number>>;
  };
  /** The multiplexer the session runs, by id. Machine-level: a project file never sets it. Default: the built-in `herdr`. */
  multiplexer: string;
}

/** Not persisted — cleared on session_start. */
export interface SessionModelOverrides {
  /** The pi family's default, written from pi's catalogue; no other harness reads it. */
  default: string | null;
  /** Per agent type, written from the catalogue of the harness that type launches under. */
  [agentType: string]: string | null | undefined;
}

/**
 * The session's per-type thinking tokens, in the vocabulary of the harness each
 * type launches under. A sibling of `SessionModelOverrides` rather than a field
 * on it: that map's per-type keys are model keys, and a model key is always a
 * string, so one map cannot hold both vocabularies without lying about one.
 */
export interface SessionThinkingOverrides {
  [agentType: string]: string | null | undefined;
}

interface ResolveModelOptions {
  subagentType: string;
  /**
   * The built-in family whose template model step 3 reads. Undefined for a plugin
   * harness, whose family is its own id: an id the template's family-keyed table
   * does not define, so it contributes no model.
   */
  harnessFamily?: HarnessFamily;
  /** The agent config's model keys, each under the family whose catalogue defines it. */
  agentConfig?: { modelsByFamily?: ModelsByFamily };
  config: Pick<SubagentsConfig, "agent">;
  /**
   * The launching harness's default, flattened across the layers that carry one
   * (session over project over global). The caller flattens it because which
   * harness launches — and therefore which key is read — is resolved the way
   * the launch resolves it, post-availability-fallback.
   */
  harnessDefault: string | null;
  /**
   * The parent session's model key — pi's vocabulary, since a parent session
   * runs pi. Read by the pi family alone; null when the parent has no model.
   */
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
  harnessId: AnyHarnessId,
): string | null {
  if (isPiFamilyHarness(harnessId)) return agent.default ?? null;
  const configured = agent.defaultModelByHarness?.[harnessId];
  return isNamedValue(configured) ? configured : null;
}

/**
 * The first layer that names a value, with that layer's name. Both chains are
 * a ranked list of layers, and this is the one walk over them: the ranking
 * belongs to each chain, the fall-through is shared.
 */
function firstResolved<K extends string>(
  candidates: ReadonlyArray<readonly [K, string | null | undefined]>,
): { value: string; source: K } | undefined {
  for (const [source, value] of candidates) {
    if (isNamedValue(value)) return { value, source };
  }
  return undefined;
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
    harnessFamily,
    config,
    harnessDefault,
    parentModelId,
    sessionOverrides,
  } = options;

  // Models are always strings; the index signature also admits the scalar keys.
  // A model pinned for this agent type (session, config, or template) beats
  // any generic default; the generic defaults are consulted only when the
  // type itself has no model anywhere.
  // A plugin harness has no built-in family, so its step-3 model is never read
  // from another family's — an unset entry, not a cross-read.
  const templateModel =
    harnessFamily === undefined
      ? undefined
      : agentConfig?.modelsByFamily?.[harnessFamily];
  const candidates: Array<[ModelSource, string | null | undefined]> = [
    ["session-per-type", sessionOverrides?.[subagentType]],
    [
      "config-per-type",
      config.agent[subagentType] as string | null | undefined,
    ],
    ["agent-template", templateModel],
    // The session default is pi's, so only a pi-family launch may read it: any
    // other harness carries a key of its own catalogue or falls through.
    [
      "session-default",
      harnessFamily === "pi" ? sessionOverrides?.["default"] : undefined,
    ],
    ["harness-default", harnessDefault],
  ];
  const resolved = firstResolved(candidates);
  if (resolved) return { model: resolved.value, source: resolved.source };
  // The parent's key is pi's, so only a pi-family launch can inherit it: any
  // other harness's launch must carry a key of its own catalogue or none.
  return {
    model: harnessFamily === "pi" ? parentModelId : null,
    source: "parent",
  };
}

/** Model-only projection of resolveModelSource(). Null when nothing resolves. */
export function resolveModel(options: ResolveModelOptions): string | null {
  return resolveModelSource(options).model;
}

/**
 * The default thinking token one harness's spawns use. The pi family reads the
 * one default every layer already writes; any other harness reads its own key,
 * in its own vocabulary, and an absent or null entry means it has none. The
 * session layer sits above the merged file layers and is the caller's to apply.
 */
export function harnessDefaultThinking(
  agent: Pick<
    SubagentsConfig["agent"],
    "defaultThinking" | "defaultThinkingByHarness"
  >,
  harnessId: AnyHarnessId,
): string | null {
  const configured = isPiFamilyHarness(harnessId)
    ? agent.defaultThinking
    : agent.defaultThinkingByHarness?.[harnessId];
  return isNamedValue(configured) ? configured : null;
}

/**
 * pi's own default thinking level. A level no layer names reads as this one on
 * a model that supports it: pi's child would have used it anyway, so a menu
 * that showed "inherit" would be describing a level the run never runs at.
 */
export const DEFAULT_THINKING_LEVEL: ThinkingLevel = "medium";

interface ResolveThinkingOptions {
  subagentType: string;
  /**
   * The built-in family whose template token step 3 reads. Undefined for a
   * plugin harness, whose family is its own id and therefore keys no template
   * table — it contributes no token rather than another family's.
   */
  harnessFamily?: HarnessFamily;
  /** The agent config's thinking tokens, each under the family whose vocabulary defines it. */
  agentConfig?: { thinkingByFamily?: ThinkingByFamily };
  config: Pick<SubagentsConfig, "agent">;
  /**
   * The launching harness's default token, flattened across the layers that
   * carry one (session over project over global). The caller flattens it
   * because which harness launches is resolved the way the launch resolves it.
   */
  harnessDefault: string | null;
  sessionThinking?: SessionThinkingOverrides;
}

/** The chain position that named a thinking token. */
export type ThinkingSource =
  "session-per-type" | "config-per-type" | "agent-template" | "harness-default";

/**
 * The winning token and the position that named it. Undefined when no layer
 * names one: the run asks for no level and the harness's own default applies,
 * so resolving one here would send an override nobody asked for.
 */
export function resolveThinkingSource(
  options: ResolveThinkingOptions,
): { value: string; source: ThinkingSource } | undefined {
  const {
    subagentType,
    agentConfig,
    harnessFamily,
    config,
    harnessDefault,
    sessionThinking,
  } = options;

  // A token names a level in one harness's vocabulary, so the template step
  // reads the launching family's entry and nothing else — the same rule the
  // model chain applies to model keys.
  const templateThinking =
    harnessFamily === undefined
      ? undefined
      : agentConfig?.thinkingByFamily?.[harnessFamily];
  return firstResolved<ThinkingSource>([
    ["session-per-type", sessionThinking?.[subagentType]],
    ["config-per-type", config.agent.thinking?.[subagentType]],
    ["agent-template", templateThinking],
    ["harness-default", harnessDefault],
  ]);
}

/** The level a spawn runs at, or undefined when no layer names one. */
export function resolveThinking(
  options: ResolveThinkingOptions,
): string | undefined {
  return resolveThinkingSource(options)?.value;
}

/**
 * Null/undefined/empty read as unset, for a model key and a thinking token
 * alike. Exported because a presence read must agree with the chain's: a layer
 * whose entry this predicate rejects never wins.
 */
export function isNamedValue(
  value: string | null | undefined,
): value is string {
  return typeof value === "string" && value.length > 0;
}

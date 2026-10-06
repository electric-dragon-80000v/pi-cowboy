/**
 * model-groups.ts — group agent types by resolved model for the Model settings menu.
 * A type gets a row only with an explicit per-type override (template-only and
 * inherited types stay hidden); rows group under the resolved model, tagged
 * with the winning layer, ordered alphabetically by model id.
 * Exports: buildModelGroups, hasExplicitPerTypeOverride.
 */

import {
  clampThinkingLevel,
  type Api,
  type Model,
} from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "../types.js";
import type {
  SubagentsConfig,
  SessionModelOverrides,
} from "./model-precedence.js";
import { resolveModelSource } from "./model-precedence.js";

export interface AgentTypeModelConfig {
  model?: string;
  thinkingLevel?: ThinkingLevel;
}

interface ModelGroupsInput {
  /** All registered agent type names, in UI listing order. */
  types: readonly string[];
  agentConfigs: Readonly<Record<string, AgentTypeModelConfig | undefined>>;
  /** Merged config.agent (project over global). */
  config: SubagentsConfig["agent"];
  sessionOverrides: SessionModelOverrides;
  /** Provenance for [project] tags. */
  hasProjectModelKey: (key: string) => boolean;
  /** Null when the parent session has no model: nothing further to inherit. */
  parentModelId: string | null;
  /** pi's defaultThinkingLevel setting. */
  piDefaultThinking?: ThinkingLevel;
  /** Registry lookup for clamping. */
  findModel: (modelId: string) => Model<Api> | undefined;
}

interface ModelGroupRow {
  type: string;
  /** Clamped to the group model's supported levels. */
  thinking: ThinkingLevel;
  /** Winning layer: "[session]", "[project]", or "" for global. */
  tag: string;
}

interface ModelGroup {
  /** Null when nothing resolves: no layer sets a model and the parent has none. Rendered as "(no model)" at the view boundary. */
  modelId: string | null;
  rows: ModelGroupRow[];
}

type ModelGroups = ModelGroup[];

/** Mirrors pi's DEFAULT_THINKING_LEVEL. */
const PI_FALLBACK_THINKING_LEVEL: ThinkingLevel = "medium";

export function buildModelGroups(input: ModelGroupsInput): ModelGroups {
  const {
    types,
    agentConfigs,
    config,
    sessionOverrides,
    hasProjectModelKey,
    parentModelId,
  } = input;

  const byModel = new Map<string | null, ModelGroupRow[]>();
  for (const type of types) {
    const cfg = agentConfigs[type];
    const { model: resolved, source } = resolveModelSource({
      subagentType: type,
      agentConfig: cfg,
      config: { agent: config },
      parentModelId,
      sessionOverrides,
    });
    // Only explicit per-type overrides are listed, including empty-string keys.
    // An empty-string key never wins the precedence chain, so a listed row
    // can still resolve to null when the parent has no model either.
    if (!hasExplicitPerTypeOverride(sessionOverrides, config, type)) continue;

    // Tag = the winning layer.
    const tag =
      source === "session-per-type" || source === "session-default"
        ? "[session]"
        : hasProjectModelKey(type)
          ? "[project]"
          : "";

    const rows = byModel.get(resolved) ?? [];
    rows.push({
      type,
      thinking: displayThinking(cfg, resolved, input),
      tag,
    });
    byModel.set(resolved, rows);
  }

  return (
    [...byModel.entries()]
      // The inherited group (null) sorts first, ahead of every model id.
      .sort((a, b) =>
        a[0] === b[0]
          ? 0
          : a[0] === null
            ? -1
            : b[0] === null
              ? 1
              : a[0] < b[0]
                ? -1
                : 1,
      )
      .map(([modelId, modelRows]) => ({ modelId, rows: modelRows }))
  );
}

/** The listing rule, shared with the menu's "Override another type..." list. */
export function hasExplicitPerTypeOverride(
  sessionOverrides: SessionModelOverrides,
  agentConfig: SubagentsConfig["agent"],
  type: string,
): boolean {
  return (
    sessionOverrides[type] != null || typeof agentConfig[type] === "string"
  );
}

/**
 * Precedence: agent-template thinking > defaultThinking > pi's
 * defaultThinkingLevel > medium, clamped to the model's supported levels.
 */
function displayThinking(
  cfg: AgentTypeModelConfig | undefined,
  modelId: string | null,
  input: ModelGroupsInput,
): ThinkingLevel {
  const base =
    cfg?.thinkingLevel ??
    input.config.defaultThinking ??
    input.piDefaultThinking ??
    PI_FALLBACK_THINKING_LEVEL;
  // Null inherits with no model to clamp against, so the base level stands.
  const model = modelId != null ? input.findModel(modelId) : undefined;
  return model ? clampThinkingLevel(model, base) : base;
}

/**
 * model-groups.ts — group agent types by resolved model for the Model settings menu.
 * A type gets a row only with an explicit per-type override (template-only and
 * inherited types stay hidden); rows group under the resolved model, tagged
 * with the winning layer, ordered alphabetically by model id.
 * Exports: buildModelGroups, hasExplicitPerTypeOverride.
 */

import type { ModelsByFamily, ThinkingByFamily } from "../agents/types.js";
import type { HarnessFamily } from "../agents/harness.js";
import type {
  SubagentsConfig,
  SessionModelOverrides,
  SessionThinkingOverrides,
} from "./model-precedence.js";
import {
  DEFAULT_THINKING_LEVEL,
  resolveModelSource,
  resolveThinking,
} from "./model-precedence.js";

export interface AgentTypeModelConfig {
  modelsByFamily?: ModelsByFamily;
  thinkingByFamily?: ThinkingByFamily;
}

interface ModelGroupsInput {
  /** All registered agent type names, in UI listing order. */
  types: readonly string[];
  agentConfigs: Readonly<Record<string, AgentTypeModelConfig | undefined>>;
  /** Merged config.agent (project over global). */
  config: SubagentsConfig["agent"];
  sessionOverrides: SessionModelOverrides;
  /** The launching harness's default for one type, flattened across its layers. */
  harnessDefaultFor: (type: string) => string | null;
  /**
   * The built-in family that launches one type: which family's template model
   * step 3 reads. Undefined for a plugin harness, whose own id keys no table.
   */
  harnessFamilyFor: (type: string) => HarnessFamily | undefined;
  /** Provenance for [project] tags. */
  hasProjectModelKey: (key: string) => boolean;
  /** Null when the parent session has no model: nothing further to inherit. */
  parentModelId: string | null;
  /** The session's per-type thinking tokens, in each type's own harness vocabulary. */
  sessionThinking: SessionThinkingOverrides;
  /** The launching harness's default thinking token for one type, flattened across its layers. */
  harnessDefaultThinkingFor: (type: string) => string | null;
}

interface ModelGroupRow {
  type: string;
  /** The level as the chain resolved it; null = no level, rendered as "inherit". */
  thinking: string | null;
  /** Winning layer: "[session]", "[project]", or "" for global. */
  tag: string;
}

interface ModelGroup {
  /** Null when nothing resolves: no layer sets a model and the parent has none. Rendered as "(no model)" at the view boundary. */
  modelId: string | null;
  rows: ModelGroupRow[];
}

type ModelGroups = ModelGroup[];

export function buildModelGroups(input: ModelGroupsInput): ModelGroups {
  const {
    types,
    agentConfigs,
    config,
    sessionOverrides,
    harnessDefaultFor,
    harnessFamilyFor,
    hasProjectModelKey,
    parentModelId,
  } = input;

  const byModel = new Map<string | null, ModelGroupRow[]>();
  for (const type of types) {
    const cfg = agentConfigs[type];
    const { model: resolved, source } = resolveModelSource({
      subagentType: type,
      harnessFamily: harnessFamilyFor(type),
      agentConfig: cfg,
      config: { agent: config },
      harnessDefault: harnessDefaultFor(type),
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
    rows.push({ type, thinking: displayThinking(type, cfg, input), tag });
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
 * The level the row shows: the chain's winner. When no layer names one, only a
 * pi-family launch has a level to show — pi runs the default this screen would
 * otherwise have to guess. Another harness has no default here: its own binary
 * picks one, or applies none, so the row shows no level rather than a token the
 * launch never sends.
 */
function displayThinking(
  type: string,
  cfg: AgentTypeModelConfig | undefined,
  input: ModelGroupsInput,
): string | null {
  const family = input.harnessFamilyFor(type);
  const resolved = resolveThinking({
    subagentType: type,
    harnessFamily: family,
    agentConfig: cfg,
    config: { agent: input.config },
    harnessDefault: input.harnessDefaultThinkingFor(type),
    sessionThinking: input.sessionThinking,
  });
  if (resolved !== undefined) return resolved;
  return family === "pi" ? DEFAULT_THINKING_LEVEL : null;
}

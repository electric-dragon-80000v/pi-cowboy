/**
 * model-groups.ts — group agent types by resolved model for the Model settings menu.
 * A type gets a row when it carries an explicit per-type override of either
 * dimension (template-only and inherited types stay hidden); rows group under
 * the resolved model, tagged with the winning layer, ordered alphabetically by
 * model id.
 * Exports: buildModelGroups, hasExplicitPerTypeOverride.
 */

import type { ModelsByFamily, ThinkingByFamily } from "../agents/types.js";
import type { HarnessFamily } from "../agents/harness.js";
import {
  DEFAULT_THINKING_LEVEL,
  resolveModelSource,
  resolveThinkingSource,
  type SessionModelOverrides,
  type SessionThinkingOverrides,
  type SubagentsConfig,
  type ThinkingSource,
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
  /** Whether the project layer names a thinking token for one type, for its tag. */
  hasProjectThinkingKey: (type: string) => boolean;
}

interface ModelGroupRow {
  type: string;
  /** The level as the chain resolved it; null = no level, rendered as "inherit". */
  thinking: string | null;
  /**
   * The layer that named the level: " [session]", " [project]", or "" when the
   * global file or nothing at all named it. A level a template, a harness
   * default, or pi's own fallback supplied has no layer to name, exactly as the
   * model column treats one.
   */
  thinkingTag: string;
  /** Winning layer of the model key: " [session]", " [project]", or "" for global. */
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
    if (
      !hasExplicitPerTypeOverride(
        sessionOverrides,
        config,
        type,
        input.sessionThinking,
      )
    )
      continue;

    // Tag = the winning layer.
    const tag =
      source === "session-per-type" || source === "session-default"
        ? "[session]"
        : hasProjectModelKey(type)
          ? "[project]"
          : "";

    const { level: thinking, source: thinkingSource } = displayedThinking({
      type,
      agentConfig: cfg,
      harnessFamily: harnessFamilyFor(type),
      config,
      harnessDefault: input.harnessDefaultThinkingFor(type),
      sessionThinking: input.sessionThinking,
    });
    // The tag names the layer the level itself came from, so a null mask at a
    // file layer — or a level a template or harness default supplied — stays
    // untagged rather than claiming a layer that named no level.
    const thinkingTag =
      thinkingSource === "session-per-type"
        ? " [session]"
        : thinkingSource === "config-per-type" &&
            input.hasProjectThinkingKey(type)
          ? " [project]"
          : "";

    const rows = byModel.get(resolved) ?? [];
    rows.push({ type, thinking, thinkingTag, tag });
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

/**
 * The listing rule, shared with the menu's "Override another type..." list: a
 * type is listed when either dimension carries an explicit override. `null`
 * reads as unset on both sides — the session maps hold a null for every type
 * that sets none, and a config entry's null is a mask rather than a value.
 */
export function hasExplicitPerTypeOverride(
  sessionOverrides: SessionModelOverrides,
  agentConfig: SubagentsConfig["agent"],
  type: string,
  sessionThinking: SessionThinkingOverrides,
): boolean {
  return (
    sessionOverrides[type] != null ||
    typeof agentConfig[type] === "string" ||
    sessionThinking[type] != null ||
    typeof agentConfig.thinking?.[type] === "string"
  );
}

/** The pieces of a row's thinking read, shared by the list and the type sheet. */
export interface ThinkingDisplayInput {
  type: string;
  /** The type's own template, whose level the chain reads when config names none. */
  agentConfig: AgentTypeModelConfig | undefined;
  harnessFamily: HarnessFamily | undefined;
  config: SubagentsConfig["agent"];
  /** The launching harness's default, flattened across its layers. */
  harnessDefault: string | null;
  sessionThinking: SessionThinkingOverrides;
}

/**
 * The level a launch sends and the chain position that named it. When no layer
 * names one, only a pi-family launch has a level to send — pi runs its own
 * default, which no layer named. Another harness has none here: its binary
 * picks one, or applies none, so the row shows no level rather than a token the
 * launch never sends.
 */
export function displayedThinking(input: ThinkingDisplayInput): {
  level: string | null;
  /** Undefined when the level is pi's own default rather than a named layer. */
  source: ThinkingSource | undefined;
} {
  const resolved = resolveThinkingSource({
    subagentType: input.type,
    harnessFamily: input.harnessFamily,
    agentConfig: input.agentConfig,
    config: { agent: input.config },
    harnessDefault: input.harnessDefault,
    sessionThinking: input.sessionThinking,
  });
  if (resolved !== undefined) {
    return { level: resolved.value, source: resolved.source };
  }
  return {
    level: input.harnessFamily === "pi" ? DEFAULT_THINKING_LEVEL : null,
    source: undefined,
  };
}

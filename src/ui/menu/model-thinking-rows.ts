/**
 * model-thinking-rows.ts — the Model Settings screen's thinking defaults.
 *
 * The pi row writes the family's one `agent.defaultThinking` scalar (and its
 * one `"pi"` session slot); every other harness row writes its own entry in
 * `defaultThinkingByHarness`. `thinkingOfferingForType` is the screen's one read
 * of a model's control, so a row and the picker it opens always agree.
 *
 * Exports: thinkingOfferingForType, buildPiDefaultThinkingRow,
 * buildHarnessDefaultThinkingRow.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { SettingItem } from "@earendil-works/pi-tui";
import type { ConfigStore } from "../../config/config-store.js";
import type { AnyHarnessId, ModelEntry } from "../../agents/harness.js";
import type { HarnessModelOptions } from "../../agents/harness/harness-registry.js";
import {
  thinkingOfferingFor,
  type ThinkingOffering,
} from "../../models/thinking-offering.js";
import { ThinkingLevelSchema } from "../../types.js";
import { findModelInRegistry } from "../../utils.js";
import { getHarnessRegistry } from "../../shell.js";
import type { Theme } from "../types.js";
import type { Notify } from "./helpers.js";
import { createThinkingSelectSubmenu } from "./submenus/thinking-select.js";

/**
 * The thinking control one model offers, read from the lists this menu tree
 * loaded and — for the pi family — from pi's own catalogue entry.
 */
export function thinkingOfferingForType(input: {
  readonly harnessId: AnyHarnessId;
  /** Null when the type names no model, so the chain's default answers. */
  readonly modelKey: string | null;
  readonly entries: HarnessModelOptions;
  readonly registry: Parameters<typeof findModelInRegistry>[1];
  readonly parentModel: Model<Api> | undefined;
}): ThinkingOffering {
  return thinkingOfferingFor({
    harnessId: input.harnessId,
    modelKey: input.modelKey ?? "",
    entries: input.entries.get(input.harnessId) ?? [],
    piModel: findModelInRegistry(
      input.modelKey ?? "",
      input.registry,
      input.parentModel,
    ),
  });
}

/**
 * A thinking default's display value. Tags mark the winning non-global layer
 * (session > project); untagged means global won, and "inherit" means no layer
 * names a level — the harness's own default applies.
 */
function thinkingRowValue(
  sessionValue: string | null,
  effectiveValue: string | null,
  hasProjectValue: boolean,
): string {
  if (sessionValue != null) return `${sessionValue} [session]`;
  if (effectiveValue == null) return "inherit";
  return hasProjectValue ? `${effectiveValue} [project]` : effectiveValue;
}

/** What one thinking-default row reads from the screen hosting it. */
interface ThinkingDefaultRowOptions {
  ctx: ExtensionCommandContext;
  store: ConfigStore;
  theme: Theme;
}

/**
 * The pi family's default thinking level, under pi's default model. The family
 * runs one binary, so its file layers write the one `agent.defaultThinking`
 * scalar and its session layer writes the one `"pi"` slot every pi-family id
 * reads.
 */
export function buildPiDefaultThinkingRow(
  options: ThinkingDefaultRowOptions,
): SettingItem {
  const { ctx, store, theme } = options;
  const levels = store.harnessDefaultThinkingLevels("pi");
  const effective = store.defaultThinkingForHarness("pi");
  const label = "Pi Default Thinking";
  const notify: Notify = (message, type) => ctx.ui.notify(message, type);

  const writeFile = (
    target: "global" | "project",
    token: string | null,
  ): void => {
    if (token === null) {
      store.mutate.agent.setDefaultThinking(undefined, target);
      return;
    }
    const parsed = ThinkingLevelSchema.safeParse(token);
    if (parsed.success) {
      store.mutate.agent.setDefaultThinking(parsed.data, target);
    }
  };

  return {
    id: "piDefaultThinking",
    label,
    currentValue: thinkingRowValue(
      levels.session ? effective : null,
      effective,
      levels.project,
    ),
    description:
      "Thinking level applied when a pi-family agent template and the per-type overrides name none.",
    submenu: createThinkingSelectSubmenu({
      theme,
      ctx,
      // One scalar serves every pi-family model, so its levels are the schema's.
      offering: { kind: "closed", levels: [...ThinkingLevelSchema.options] },
      current: effective,
      projectOffered: store.isProjectWritable,
      showClear: levels.session || levels.global || levels.project,
      availableLevels: levels,
      onSet: (target, token) => {
        if (target === "session") {
          store.mutate.agent.setHarnessDefaultThinking("pi", token, "session");
        } else {
          writeFile(target, token);
        }
        notify(
          token === null
            ? `${label} cleared (${target})`
            : `${label} set to ${token} (${target})`,
          "info",
        );
      },
      onClear: (target) => {
        if (target === "all") {
          store.mutate.agent.clearHarnessDefaultThinking("pi", "all");
          store.mutate.agent.setDefaultThinking(undefined, "global");
          store.mutate.agent.setDefaultThinking(undefined, "project");
        } else if (target === "session") {
          store.mutate.agent.clearHarnessDefaultThinking("pi", "session");
        } else {
          store.mutate.agent.setDefaultThinking(undefined, target);
        }
        notify(`${label} cleared (${target})`, "info");
      },
    }),
  };
}

/** One harness's default thinking token, below its default model row. */
export function buildHarnessDefaultThinkingRow(
  options: ThinkingDefaultRowOptions & {
    harnessId: AnyHarnessId;
    entries: readonly ModelEntry[];
  },
): SettingItem {
  const { ctx, store, theme, harnessId, entries } = options;
  const label = `${getHarnessRegistry().displayName(harnessId)} Default Thinking`;
  const notify: Notify = (message, type) => ctx.ui.notify(message, type);
  const levels = store.harnessDefaultThinkingLevels(harnessId);
  const effective = store.defaultThinkingForHarness(harnessId);
  const offering = thinkingOfferingFor({
    harnessId,
    // No default model means the launch runs this harness's own default, whose
    // list no single entry answers for.
    modelKey: store.defaultModelForHarness(harnessId) ?? "",
    entries,
    piModel: undefined,
  });

  return {
    id: `harnessThinking:${harnessId}`,
    label,
    currentValue: thinkingRowValue(
      levels.session ? effective : null,
      effective,
      levels.project,
    ),
    description: `Thinking level used when an agent launches under ${harnessId} and no per-type override or template level applies.`,
    submenu: createThinkingSelectSubmenu({
      theme,
      ctx,
      offering,
      current: effective,
      projectOffered: store.isProjectWritable,
      showClear: levels.session || levels.global || levels.project,
      availableLevels: levels,
      onSet: (target, token) => {
        if (token === null) {
          store.mutate.agent.clearHarnessDefaultThinking(harnessId, target);
        } else {
          store.mutate.agent.setHarnessDefaultThinking(
            harnessId,
            token,
            target,
          );
        }
        notify(
          token === null
            ? `${label} cleared (${target})`
            : `${label} set to ${token} (${target})`,
          "info",
        );
      },
      onClear: (target) => {
        store.mutate.agent.clearHarnessDefaultThinking(harnessId, target);
        notify(`${label} cleared (${target})`, "info");
      },
    }),
  };
}

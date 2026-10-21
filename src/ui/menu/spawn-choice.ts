/**
 * spawn-choice.ts — the model and thinking level one spawn names.
 *
 * The two travel together because a level means what the model's harness says
 * it means: the list comes from that harness's own model entry, and a token is
 * kept only when the selected model can take it. `choice` answers in the shape
 * the coordinator reads, so the wizard never re-derives a harness's vocabulary.
 *
 * Exports: spawnChoices, SpawnChoice, THINKING_LEVEL_ROW_ID.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { SettingItem } from "@earendil-works/pi-tui";
import { isPiFamilyHarness, type AnyHarnessId } from "../../agents/harness.js";
import type { HarnessModelOptions } from "../../agents/harness/harness-registry.js";
import { thinkingOfferingFor } from "../../models/thinking-offering.js";
import type { ModelChoice } from "../../types.js";
import { findModelInRegistry, modelChoiceName } from "../../utils.js";
import type { Theme } from "../types.js";
import { createInputSubmenu } from "./submenus/numeric-input.js";
import { createLevelPickerSubmenu } from "./submenus/target-select.js";

/** The id the wizard's row carries, so its onChange and this row agree. */
export const THINKING_LEVEL_ROW_ID = "thinkingLevel";

/** The custom-token row's id; no level can take it, so it cannot collide. */
const CUSTOM_THINKING_ID = "__custom__";

/**
 * What the spawn names, or what pi's lookup could not find. A pi key the
 * session's registry no longer lists is the one case the caller must report:
 * every other harness is its own authority on the keys it accepts.
 */
export type SpawnChoice =
  | { readonly kind: "none" }
  | { readonly kind: "missing"; readonly modelKey: string }
  | { readonly kind: "chosen"; readonly modelChoice: ModelChoice };

/**
 * The invocation fields one choice implies. Both are read off the choice, so no
 * caller keeps a copy of a name or a level its choice already carries.
 */
export function choiceInvocation(choice: ModelChoice | undefined): {
  modelName?: string;
  thinkingLevel?: string;
} {
  return {
    modelName: modelChoiceName(choice),
    thinkingLevel: choice?.thinking ?? undefined,
  };
}

/** What every choice question is asked against: this menu tree's model lists. */
export interface SpawnChoiceContext {
  readonly entries: HarnessModelOptions;
  /** pi's catalogue lookup, as the session provides it. */
  readonly registry: Parameters<typeof findModelInRegistry>[1];
  /** The parent session's model; it answers for a pi key the registry lost. */
  readonly parentModel: Model<Api> | undefined;
}

export interface SpawnChoiceMaker {
  /**
   * The token this spawn keeps for `(harness, model)`: dropped when the model
   * has no control or enforces a closed list without it. An advisory list is
   * not a vocabulary the harness enforces, so a token outside it survives.
   */
  clamp(
    harnessId: AnyHarnessId,
    modelKey: string,
    token: string | undefined,
  ): string | undefined;
  /** The "Thinking level" row, its list following this spawn's model. */
  row(
    harnessId: AnyHarnessId,
    modelKey: string,
    current: string | undefined,
    view: { readonly ctx: ExtensionCommandContext; readonly theme: Theme },
  ): SettingItem;
  /** The choice the coordinator runs, or the pi key it could not resolve. */
  choice(
    harnessId: AnyHarnessId,
    modelKey: string,
    thinking: string | undefined,
  ): SpawnChoice;
}

export function spawnChoices(context: SpawnChoiceContext): SpawnChoiceMaker {
  const { entries, registry, parentModel } = context;

  /** The model's thinking control, in the launching harness's vocabulary. */
  const offeringOf = (harnessId: AnyHarnessId, modelKey: string) =>
    thinkingOfferingFor({
      harnessId,
      modelKey,
      entries: entries.get(harnessId) ?? [],
      piModel: findModelInRegistry(modelKey, registry, parentModel),
    });

  /** The lines the row offers: the model's levels, a free token, then Inherit. */
  const levelRow = (
    offering: ReturnType<typeof offeringOf>,
    current: string | undefined,
    view: { ctx: ExtensionCommandContext; theme: Theme },
  ): SettingItem["submenu"] => {
    if (offering.kind === "none") return undefined;
    const items: SettingItem[] = offering.levels.map((level) => ({
      id: level,
      label:
        level === "off"
          ? "Off"
          : level.charAt(0).toUpperCase() + level.slice(1),
      currentValue: current === level ? "(current)" : "",
    }));
    if (offering.kind === "advisory") {
      items.push({
        id: CUSTOM_THINKING_ID,
        label: "Custom token...",
        currentValue: "",
        description:
          "A level or variant this model advertises beyond its own list.",
      });
    }
    items.push({
      id: "inherit",
      label: "Inherit",
      currentValue: current === undefined ? "(current)" : "",
      description: "Leave the level to the template and configured defaults.",
    });
    return createLevelPickerSubmenu({
      theme: view.theme,
      items,
      onPick: (id, subDone) => {
        if (id === CUSTOM_THINKING_ID) {
          // A blank answer closes the input with no change.
          return createInputSubmenu(view.ctx)(current ?? "", subDone);
        }
        // A row completes with its own id, so the wizard's onChange takes it as
        // the token — and "inherit" as the answer that clears one.
      },
    });
  };

  return {
    clamp(harnessId, modelKey, token) {
      if (token === undefined) return undefined;
      const offering = offeringOf(harnessId, modelKey);
      if (offering.kind === "none") return undefined;
      return offering.kind === "advisory" || offering.levels.includes(token)
        ? token
        : undefined;
    },
    row(harnessId, modelKey, current, view) {
      const offering = offeringOf(harnessId, modelKey);
      return {
        id: THINKING_LEVEL_ROW_ID,
        label: "Thinking level",
        currentValue: current ?? "inherit",
        description:
          offering.kind === "none"
            ? "This model takes no thinking level."
            : "Reasoning effort for this spawn, from the selected harness's own list",
        submenu: levelRow(offering, current, view),
      };
    },
    choice(harnessId, modelKey, thinking) {
      if (modelKey === "") {
        if (thinking === undefined) return { kind: "none" };
        // A level without a model: a pi child runs the parent's model at it, a
        // foreign child its own default — "inherit" would name the parent's pi
        // model, which that harness cannot run.
        return {
          kind: "chosen",
          modelChoice: isPiFamilyHarness(harnessId)
            ? { inherit: true, thinking }
            : { levelOnly: true, thinking },
        };
      }
      const modelChoice: ModelChoice | undefined = isPiFamilyHarness(harnessId)
        ? piChoice(modelKey, thinking, registry)
        : foreignChoice(harnessId, modelKey, thinking, entries);
      if (modelChoice === undefined) return { kind: "missing", modelKey };
      return { kind: "chosen", modelChoice };
    },
  };
}

/** pi's own catalogue answers for the pi family; undefined when it lost the key. */
function piChoice(
  modelKey: string,
  thinking: string | undefined,
  registry: SpawnChoiceContext["registry"],
): ModelChoice | undefined {
  const model = findModelInRegistry(modelKey, registry, undefined);
  if (model === undefined) return undefined;
  return {
    model,
    key: `${model.provider}/${model.id}`,
    thinking: thinking ?? null,
  };
}

/** A foreign key is carried as written: that harness accepts what it lists. */
function foreignChoice(
  harnessId: AnyHarnessId,
  modelKey: string,
  thinking: string | undefined,
  entries: HarnessModelOptions,
): ModelChoice {
  const entry = (entries.get(harnessId) ?? []).find(
    (candidate) => candidate.key === modelKey,
  );
  return {
    harness: harnessId,
    key: modelKey,
    name: entry?.label ?? modelKey,
    thinking: thinking ?? null,
  };
}

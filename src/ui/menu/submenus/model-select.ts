/** model-select.ts — level picker, then model search (ADR-0008), and the paired model + thinking picker. Create inside ctx.ui.custom to capture the theme. */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type { ThinkingOffering } from "../../../models/thinking-offering.js";
import type { Theme } from "../../types.js";
import { SearchableSelectDialog } from "../../../ui/searchable-select.js";
import { SwappableView } from "../screen-host.js";
import { buildModelOptions } from "../helpers.js";
import { createThinkingValuePicker } from "./thinking-select.js";
import {
  buildLevelItems,
  createClearPickerSubmenu,
  createLevelPickerSubmenu,
  type AvailableLevels,
  type SetTarget,
  type TargetChoice,
} from "./target-select.js";

interface ModelSelectSubmenuBase {
  /** The models the harness this row configures can run; its picker offers these alone. */
  modelOptions: readonly string[];
  /**
   * Keys this picker merges ahead of `modelOptions` — pi's configured models on
   * pi's own rows. A row for any other harness passes none: its list is the
   * whole offering.
   */
  mergedModels: readonly string[];
  /** Project target availability (untrusted/malformed projects hide the entry). */
  projectOffered: boolean;
  theme: Theme;
  /** Effective model for pre-selecting the current value in the picker. */
  currentModel?: string | null;
  /** Opt-in availability for the nested clear picker; see target-select. */
  availableLevels?: AvailableLevels;
  onSet: (
    target: "session" | "global" | "project",
    model: string | null,
  ) => void;
}

/**
 * The "Clear..." entry and its handler go together: offering the row without
 * something to run on selection would throw on pick.
 */
type ModelSelectClearOptions =
  | {
      /** Offer the nested "Clear..." flow. */
      showClear: true;
      /** Clear the key at the picked layer. */
      onClear: (target: TargetChoice) => void;
    }
  | { showClear: false; onClear?: never };

type ModelSelectSubmenuOptions = ModelSelectSubmenuBase &
  ModelSelectClearOptions;

export function createModelSelectSubmenu(
  options: ModelSelectSubmenuOptions,
): (currentValue: string, done: (selectedValue?: string) => void) => Component {
  // Null pre-selects the (none) row; a model id pre-selects its row.
  const currentModel = options.currentModel ?? null;

  const onClear = options.showClear === true ? options.onClear : undefined;
  return createLevelPickerSubmenu({
    theme: options.theme,
    items: buildLevelItems({
      offered: { session: true, global: true, project: options.projectOffered },
      includeClear: onClear !== undefined,
    }),
    onPick: (id, subDone, completePicker) => {
      if (id === "clear") {
        return createClearPickerSubmenu({
          theme: options.theme,
          projectOffered: options.projectOffered,
          availableLevels: options.availableLevels,
          onClear: (target) => onClear?.(target),
        })("", subDone);
      }
      const target = id as "session" | "global" | "project";
      return new SearchableSelectDialog(
        buildModelOptions(
          options.modelOptions,
          currentModel,
          options.mergedModels,
        ),
        currentModel,
        {
          onSelect: (modelValue) => {
            options.onSet(target, modelValue);
            // The library forwards only a DEFINED value, so the null (none)
            // row must complete the level picker explicitly.
            if (modelValue == null) completePicker();
            else subDone(modelValue);
          },
          onCancel: () => subDone(),
        },
        options.theme,
      );
    },
  });
}

export interface ModelThinkingSubmenuOptions {
  /** The models the harness offers, exactly as `createModelSelectSubmenu` takes them. */
  modelOptions: readonly string[];
  mergedModels: readonly string[];
  projectOffered: boolean;
  theme: Theme;
  /** The custom-token input's notification sink. */
  ctx: ExtensionCommandContext;
  /** The model in force, pre-selected in the search dialog. */
  currentModel: string | null;
  /** The level in force, pre-selected in the level list. */
  currentThinking: string | null;
  /** Offer the nested "Clear..." flow (removes both halves at the layer). */
  showClear: boolean;
  /**
   * Filters the nested clear picker to the layers carrying either half. A
   * layer can hold a thinking token without a model key, so the caller passes
   * the union of both.
   */
  availableLevels?: AvailableLevels;
  /** The thinking control `modelKey` offers, in its harness's vocabulary. */
  offeringFor: (modelKey: string) => ThinkingOffering;
  /** Write the pair at one layer; a null token leaves no level there. */
  onSet: (target: SetTarget, model: string, token: string | null) => void;
  /** Remove both halves at the picked layer. */
  onClear: (target: TargetChoice) => void;
}

/**
 * The model picker and the level picker it leads to, as one submenu: a model
 * and the reasoning it runs at are one setting, so the layer is asked for once
 * and the pair is written together. The model is held until the level is
 * picked, because a cancel at the level step must leave the layer untouched.
 *
 * A model with no thinking control (`kind: "none"`) has no level to ask for;
 * its pair is the model alone, so the layer's old token goes with the write.
 * The (none) row clears the pair at the layer instead of writing anything.
 */
export function createModelThinkingSubmenu(
  options: ModelThinkingSubmenuOptions,
): (currentValue: string, done: (selectedValue?: string) => void) => Component {
  const currentModel = options.currentModel ?? null;

  return createLevelPickerSubmenu({
    theme: options.theme,
    items: buildLevelItems({
      offered: { session: true, global: true, project: options.projectOffered },
      includeClear: options.showClear,
    }),
    onPick: (id, subDone, completePicker) => {
      if (id === "clear") {
        return createClearPickerSubmenu({
          theme: options.theme,
          projectOffered: options.projectOffered,
          availableLevels: options.availableLevels,
          onClear: (target) => options.onClear(target),
        })("", subDone);
      }

      const target = id as SetTarget;
      let view: SwappableView;
      const dialog = new SearchableSelectDialog(
        buildModelOptions(
          options.modelOptions,
          currentModel,
          options.mergedModels,
        ),
        currentModel,
        {
          onSelect: (modelValue) => {
            if (modelValue == null) {
              options.onClear(target);
              completePicker();
              return;
            }
            const offering = options.offeringFor(modelValue);
            if (offering.kind === "none") {
              // No level to ask for: the pair is the model alone, and the
              // picked key completes the layer step so the row repaints.
              options.onSet(target, modelValue, null);
              subDone(modelValue);
              return;
            }
            // The pair is written only once the level is picked: the search
            // dialog is replaced in place by the level list it leads to.
            view.activate(
              createThinkingValuePicker({
                theme: options.theme,
                ctx: options.ctx,
                offering,
                current: options.currentThinking,
                onPick: (token) => options.onSet(target, modelValue, token),
              })("", subDone),
            );
          },
          onCancel: () => subDone(),
        },
        options.theme,
      );
      view = new SwappableView(dialog);
      return view;
    },
  });
}

/** model-select-submenu.ts — level picker, then model search (ADR-0008). Create inside ctx.ui.custom to capture the theme. */

import type { Component } from "@earendil-works/pi-tui";
import type { Theme } from "../../types.js";
import { SearchableSelectDialog } from "../../../ui/searchable-select.js";
import { buildModelOptions, extractConfiguredModels } from "../helpers.js";
import { getStore } from "../../../shell.js";
import {
  buildLevelItems,
  createClearPickerSubmenu,
  createLevelPickerSubmenu,
  type AvailableLevels,
  type TargetChoice,
} from "./target-select.js";

interface ModelSelectSubmenuBase {
  modelOptions: string[];
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
  // Null (inherit) pre-selects the inherit row; a model id pre-selects its row.
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
      const store = getStore();
      const configuredModels = extractConfiguredModels(
        store.agentConfigSnapshot(),
      );
      return new SearchableSelectDialog(
        buildModelOptions(options.modelOptions, currentModel, configuredModels),
        currentModel,
        {
          onSelect: (modelValue) => {
            options.onSet(target, modelValue);
            // The library forwards only a DEFINED value, so the null inherit
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

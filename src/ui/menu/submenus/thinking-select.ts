/**
 * thinking-select.ts — the level list for one model, in that model's own
 * vocabulary.
 *
 * The list is the model's offering, so a closed vocabulary offers its levels
 * and an advisory one adds a free-form token; None is always offered because a
 * layer may already hold a token to remove. Every pick completes with a defined
 * value — the token itself, or the None id for a clear — so the host list
 * repaints without a separate refresh callback.
 *
 * The caller has already picked the layer: the Model Settings screen asks for
 * the level right after the model, at the layer the model is about to be
 * written to.
 *
 * Exports: createThinkingValuePicker.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Component, SettingItem } from "@earendil-works/pi-tui";
import type { ThinkingOffering } from "../../../models/thinking-offering.js";
import type { Theme } from "../../types.js";
import { createInputSubmenu } from "./numeric-input.js";
import { createLevelPickerSubmenu } from "./target-select.js";

/** The custom-token row's id; no level can take it, so it cannot collide. */
const CUSTOM_TOKEN_ID = "__custom__";

/**
 * The None row's id. The label names a level a harness might advertise, so the
 * id is a token no level can take.
 */
export const NO_LEVEL_ID = "__none__";

export interface ThinkingValuePickerOptions {
  theme: Theme;
  /** The custom-token input's notification sink. */
  ctx: ExtensionCommandContext;
  /** The levels the model that will run the token offers. */
  offering: ThinkingOffering;
  /** The value in force, for the "(current)" marker; null = no level named. */
  current: string | null;
  /** Write the picked token; null is None, a clear at the caller's layer. */
  onPick: (token: string | null) => void;
}

/** The rows a value picker offers: the model's levels, a free token, then None. */
function valueItems(
  offering: ThinkingOffering,
  current: string | null,
): SettingItem[] {
  const items: SettingItem[] = [];
  if (offering.kind !== "none") {
    for (const level of offering.levels) {
      items.push({
        id: level,
        label:
          level === "off"
            ? "Off"
            : level.charAt(0).toUpperCase() + level.slice(1),
        currentValue: current === level ? "(current)" : "",
      });
    }
    if (offering.kind === "advisory") {
      items.push({
        id: CUSTOM_TOKEN_ID,
        label: "Custom token...",
        currentValue: "",
        description:
          "A level or variant this harness advertises beyond its own list.",
      });
    }
  }
  items.push({
    id: NO_LEVEL_ID,
    label: "None",
    currentValue: current === null ? "(current)" : "",
    description:
      "Use the template, configured default, or parent session's level.",
  });
  return items;
}

/**
 * The level list alone: no target step, because the caller already picked the
 * layer. A row completes with its own id — a level id is the token, and the
 * None id is the defined value that repaints the host list after the clear it
 * performs.
 */
export function createThinkingValuePicker(
  options: ThinkingValuePickerOptions,
): (currentValue: string, done: (selectedValue?: string) => void) => Component {
  return createLevelPickerSubmenu({
    theme: options.theme,
    items: valueItems(options.offering, options.current),
    onPick: (id, pickDone) => {
      if (id === CUSTOM_TOKEN_ID) {
        return createInputSubmenu(options.ctx)(
          options.current ?? "",
          (token) => {
            if (token === undefined) {
              pickDone();
              return;
            }
            options.onPick(token);
            pickDone(token);
          },
        );
      }
      options.onPick(id === NO_LEVEL_ID ? null : id);
    },
  });
}

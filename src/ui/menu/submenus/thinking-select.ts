/**
 * thinking-select.ts — the layered thinking picker: a target first, then the
 * token to write there, and the nested "Clear…" flow (ADR-0008).
 *
 * The value list is the model's own offering, so a closed vocabulary offers its
 * levels and an advisory one adds a free-form token; Inherit is always offered
 * because a layer may already hold a token to remove. Every pick completes with
 * a defined value — the token itself, or "inherit" for a clear — so the host
 * list repaints without a separate refresh callback.
 *
 * Exports: createThinkingSelectSubmenu.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Component, SettingItem } from "@earendil-works/pi-tui";
import type { ThinkingOffering } from "../../../models/thinking-offering.js";
import type { Theme } from "../../types.js";
import { createInputSubmenu } from "./numeric-input.js";
import {
  buildLevelItems,
  createClearPickerSubmenu,
  createLevelPickerSubmenu,
  type AvailableLevels,
  type SetTarget,
  type TargetChoice,
} from "./target-select.js";

/** The custom-token row's id; no level can take it, so it cannot collide. */
const CUSTOM_TOKEN_ID = "__custom__";

export interface ThinkingSelectOptions {
  theme: Theme;
  /** The custom-token input's notification sink. */
  ctx: ExtensionCommandContext;
  /** The levels this setting may be written from, in the model's vocabulary. */
  offering: ThinkingOffering;
  /** The value in force, for the "(current)" marker; null = no level named. */
  current: string | null;
  /** Show the project target (trusted project with a writable config file). */
  projectOffered: boolean;
  /** Offer the nested "Clear…" flow; false when no layer carries the setting. */
  showClear: boolean;
  /** Filters the nested clear picker to the layers that carry the setting. */
  availableLevels: AvailableLevels;
  /** Write the token at the picked layer; null clears it there. */
  onSet: (target: SetTarget, token: string | null) => void;
  onClear: (target: TargetChoice) => void;
}

/** The rows a value picker offers: the model's levels, a free token, then Inherit. */
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
    id: "inherit",
    label: "Inherit",
    currentValue: current === null ? "(current)" : "",
    description: "Leave the level to the next layer that names one.",
  });
  return items;
}

export function createThinkingSelectSubmenu(
  options: ThinkingSelectOptions,
): (currentValue: string, done: (value?: string) => void) => Component {
  const {
    theme,
    ctx,
    offering,
    current,
    projectOffered,
    showClear,
    availableLevels,
  } = options;

  /**
   * The value list for one target. A row completes with its own id: a level id
   * is the token, and "inherit" is the defined value that repaints the host
   * list after the clear it performs.
   */
  const valuePicker = (
    target: SetTarget,
    subDone: (value?: string) => void,
  ): Component =>
    createLevelPickerSubmenu({
      theme,
      items: valueItems(offering, current),
      onPick: (id, pickDone) => {
        if (id === CUSTOM_TOKEN_ID) {
          return createInputSubmenu(ctx)(current ?? "", (token) => {
            if (token === undefined) {
              pickDone();
              return;
            }
            options.onSet(target, token);
            pickDone(token);
          });
        }
        options.onSet(target, id === "inherit" ? null : id);
      },
    })("", subDone);

  return createLevelPickerSubmenu({
    theme,
    items: buildLevelItems({
      offered: { session: true, global: true, project: projectOffered },
      includeClear: showClear,
    }),
    onPick: (id, subDone) => {
      if (id === "clear") {
        return createClearPickerSubmenu({
          theme,
          projectOffered,
          availableLevels,
          onClear: (target) => options.onClear(target),
        })("", subDone);
      }
      return valuePicker(id as SetTarget, subDone);
    },
  });
}

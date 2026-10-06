/**
 * target-select.ts — session/global/project/all picker for layered values (ADR-0008).
 * Project needs the store's project target; "All levels" is clear-only;
 * opt-in availableLevels restricts rows to levels carrying the setting.
 */

import {
  SettingsList,
  type Component,
  type SettingItem,
} from "@earendil-works/pi-tui";
import type { Theme } from "../../types.js";
import { asSubmenuComponent, CLOSED_SUBMENU } from "../screen-host.js";
import { buildSettingsListTheme, withVimKeys } from "../helpers.js";
import { createConfirmSubmenu } from "./confirm.js";

/** The layer a set/clear applies to; "all" clears every layer. */
export type TargetChoice = "session" | "global" | "project" | "all";

/** Layers a set (non-clear) can target. */
export type SetTarget = "session" | "global" | "project";

/** Per-level availability of the setting a clear flow removes. */
export interface AvailableLevels {
  session: boolean;
  global: boolean;
  project: boolean;
}

/** Level entries with set vs clear persistence notes. */
const LEVEL_ENTRIES: Record<
  SetTarget,
  { label: string; setDescription: string; clearDescription: string }
> = {
  session: {
    label: "Session",
    setDescription: "Not saved",
    clearDescription: "Removes from the session",
  },
  global: {
    label: "Global",
    setDescription: "Saves to the global config file",
    clearDescription: "Removes from the global config file",
  },
  project: {
    label: "Project",
    setDescription: "Saves to the project config file",
    clearDescription: "Removes from the project config file",
  },
};

function levelItem(target: SetTarget, clearMode: boolean): SettingItem {
  const entry = LEVEL_ENTRIES[target];
  return {
    id: target,
    label: entry.label,
    currentValue: "",
    description: clearMode ? entry.clearDescription : entry.setDescription,
  };
}

/** Offered level rows plus optional "Clear..."/"All levels" rows. */
export function buildLevelItems(options: {
  /** Which levels get a row. */
  offered: AvailableLevels;
  /** Description wording: set ("Saves to...") vs clear ("Removes from..."). */
  clearMode?: boolean;
  includeClear?: boolean;
  includeAll?: boolean;
}): SettingItem[] {
  const items: SettingItem[] = [];
  if (options.offered.session)
    items.push(levelItem("session", options.clearMode === true));
  if (options.offered.global)
    items.push(levelItem("global", options.clearMode === true));
  if (options.offered.project)
    items.push(levelItem("project", options.clearMode === true));
  if (options.includeClear)
    items.push({ id: "clear", label: "Clear...", currentValue: "" });
  if (options.includeAll)
    items.push({ id: "all", label: "All levels", currentValue: "" });
  return items;
}

/** Level picker; a returned Component chains as its submenu, void completes the pick. */
export function createLevelPickerSubmenu(options: {
  theme: Theme;
  items: SettingItem[];
  /**
   * Apply the pick (row id, chained completion, `completePicker` closing this
   * picker). SettingsList forwards a chained completion only with a DEFINED
   * value, so a valueless finish must call `completePicker` to unwind.
   */
  onPick: (
    id: string,
    done: (selectedValue?: string) => void,
    completePicker: () => void,
  ) => Component | void;
}): (
  currentValue: string,
  done: (selectedValue?: string) => void,
) => Component {
  return (_currentValue, done) => {
    const items = options.items.map((item) => ({
      ...item,
      submenu: (
        _cv: string,
        subDone: (selectedValue?: string) => void,
      ): Component => {
        const next = options.onPick(item.id, subDone, () => done());
        if (next) return next;
        subDone(item.id);
        return CLOSED_SUBMENU;
      },
    }));
    const list = withVimKeys(
      new SettingsList(
        items,
        items.length,
        buildSettingsListTheme(options.theme),
        (_id, value) => done(value),
        () => done(),
      ),
    );
    return asSubmenuComponent(list);
  };
}

interface TargetSelectSubmenuBase {
  theme: Theme;
  /** Show the project entry (trusted project with a valid or absent config file). */
  projectOffered: boolean;
  /** Include the session entry. Default: true. */
  includeSession?: boolean;
  /** Include the "All levels" entry (clears only). Default: false. */
  includeAll?: boolean;
  /**
   * Opt-in level availability (model-settings clear pickers only): when set,
   * each level is offered only if listed, and "All levels" only if at least
   * two are. When omitted, every structurally available level is offered
   * (the other menus' current behavior).
   */
  availableLevels?: AvailableLevels;
  /**
   * Apply the pick. Return a Component to chain into (value input, confirm);
   * return void to close the submenu (the settings list rebuilds).
   */
  onPick: (
    target: TargetChoice,
    done: (selectedValue?: string) => void,
  ) => Component | void;
}

/**
 * The "Clear..." entry and its handler go together: offering the row without
 * something to run on selection would throw on pick.
 */
type TargetSelectClearOptions =
  | {
      /** Append a "Clear..." entry that opens a nested per-level clear picker. */
      showClear: true;
      /** Clear the key at the picked level. */
      onClear: (target: TargetChoice) => void;
    }
  | { showClear?: false; onClear?: never };

type TargetSelectSubmenuOptions = TargetSelectSubmenuBase &
  TargetSelectClearOptions;

export function createTargetSelectSubmenu(
  options: TargetSelectSubmenuOptions,
): (currentValue: string, done: (selectedValue?: string) => void) => Component {
  const avail = options.availableLevels;
  // includeAll marks clear pickers, selecting the "Removes from..." wording.
  const clearMode = options.includeAll === true;
  const sessionOffered =
    (options.includeSession ?? true) && (!avail || avail.session);
  const globalOffered = !avail || avail.global;
  const projectOffered = options.projectOffered && (!avail || avail.project);
  const levelsOffered = [sessionOffered, globalOffered, projectOffered].filter(
    Boolean,
  ).length;
  const onClear = options.showClear === true ? options.onClear : undefined;
  const items = buildLevelItems({
    offered: {
      session: sessionOffered,
      global: globalOffered,
      project: projectOffered,
    },
    clearMode,
    includeClear: onClear !== undefined,
    includeAll: avail ? levelsOffered >= 2 : options.includeAll === true,
  });

  return createLevelPickerSubmenu({
    theme: options.theme,
    items,
    onPick: (id, subDone) => {
      if (id === "clear") {
        return createClearPickerSubmenu({
          theme: options.theme,
          projectOffered: options.projectOffered,
          includeSession: options.includeSession ?? true,
          availableLevels: options.availableLevels,
          onClear: (target) => onClear?.(target),
        })("", subDone);
      }
      return options.onPick(id as TargetChoice, subDone);
    },
  });
}

/** "Clear..." → level picker restricted to levels carrying the setting, plus "All levels". */
export function createClearPickerSubmenu(options: {
  theme: Theme;
  projectOffered: boolean;
  includeSession?: boolean;
  availableLevels?: AvailableLevels;
  onClear: (target: TargetChoice) => void;
}): (
  currentValue: string,
  done: (selectedValue?: string) => void,
) => Component {
  return createTargetSelectSubmenu({
    theme: options.theme,
    projectOffered: options.projectOffered,
    includeSession: options.includeSession ?? true,
    includeAll: true,
    availableLevels: options.availableLevels,
    onPick: (target) => options.onClear(target),
  });
}

/** Clear-all flow: pick a level, then confirm. */
export function createClearAllSubmenu(options: {
  theme: Theme;
  projectOffered: boolean;
  /** Opt-in level availability; see TargetSelectSubmenuOptions.availableLevels. */
  availableLevels?: AvailableLevels;
  /** Confirm prompt, e.g. "Clear all model overrides at the {target} level?" */
  message: (target: TargetChoice) => string;
  onConfirm: (target: TargetChoice) => void;
}): (
  currentValue: string,
  done: (selectedValue?: string) => void,
) => Component {
  return (currentValue, done) =>
    createTargetSelectSubmenu({
      theme: options.theme,
      projectOffered: options.projectOffered,
      includeAll: true,
      availableLevels: options.availableLevels,
      onPick: (target, pickDone) =>
        createConfirmSubmenu({
          message: options.message(target),
          theme: options.theme,
          onConfirm: () => options.onConfirm(target),
        })(currentValue, pickDone),
    })(currentValue, done);
}

/**
 * helpers.ts — menu theme builders, numeric validation, model options,
 * separator-skip, and the searchable pick-list factory.
 */
import type {
  Component,
  SettingItem,
  SettingsListTheme,
} from "@earendil-works/pi-tui";
import type { Theme } from "../types.js";
import type { ActionNotify } from "../action-report.js";
import {
  SearchableSelectDialog,
  type SelectOption,
} from "../searchable-select.js";
import { parseModelKey } from "../../utils.js";
import { SwappableView, type NavigableList } from "./screen-host.js";

export { actionReport } from "../action-report.js";

/** A SettingItem submenu factory, pinned to the library's own contract. */
export type SubmenuFactory = NonNullable<SettingItem["submenu"]>;

/** Notification sink (ctx.ui.notify), so row builders skip the full context. */
export type Notify = ActionNotify;

/** Group header marker. */
const GROUP_HEADER_KIND = "group-header";
type GroupHeaderItem = SettingItem & { kind: typeof GROUP_HEADER_KIND };

/** Create a non-selectable group header row for SettingsList. */
export function headerItem(theme: Theme, label: string): GroupHeaderItem {
  return {
    id: SEPARATOR_ID,
    kind: GROUP_HEADER_KIND,
    label: theme.bold(theme.fg("accent", label)),
    currentValue: "",
  };
}

/** Separator/section-header row id; installSeparatorSkip keeps the cursor off these. */
export const SEPARATOR_ID = "__sep__";

/**
 * Separator-skip row shape: a separator is a SelectOption `value` or
 * SettingItem `id` of SEPARATOR_ID (covers group headers, which carry it as id).
 */
interface NavigableItem {
  /** SelectOption value or SettingItem id that marks a separator row. */
  id?: string;
  value?: string;
}

/** Real selectedIndex storage, off the list's own properties (see NavigableList). */
const rawIndexes = new WeakMap<object, number>();

/**
 * Keep navigation off SEPARATOR_ID rows by overriding selectedIndex with a
 * get/set pair (raw index in rawIndexes). pi-tui writes the index directly
 * on up/down, so the setter intercepts every move: travel direction first,
 * then the opposite, else stay put. Reads list.items (no caller filters).
 * The construction index is sanitized the same way, so a menu starting on a
 * header opens on the first selectable row.
 */
export function installSeparatorSkip<T extends NavigableItem>(
  list: NavigableList<T>,
): void {
  if (!Array.isArray(list.items)) return;
  const isSep = (item: T | undefined) =>
    item?.value === SEPARATOR_ID || item?.id === SEPARATOR_ID;
  // First non-separator past `start` in `step` direction, else out of bounds.
  const firstNonSepFrom = (
    items: readonly T[],
    start: number,
    step: number,
  ): number => {
    let next = start + step;
    while (next >= 0 && next < items.length && isSep(items[next])) next += step;
    return next;
  };
  const inBounds = (items: readonly T[], i: number) =>
    i >= 0 && i < items.length;
  // Seed only: first selectable at or after `start`, else nearest before, else 0.
  const seedIndex = (items: readonly T[], start: number): number => {
    const clamped = Math.max(0, Math.min(start, items.length - 1));
    for (let i = clamped; i < items.length; i += 1) {
      if (!isSep(items[i])) return i;
    }
    for (let i = clamped - 1; i >= 0; i -= 1) {
      if (!isSep(items[i])) return i;
    }
    return 0;
  };
  // Read before defineProperty: after it, the getter returns the unseeded WeakMap entry.
  const initialIndex = list.selectedIndex ?? 0;
  Object.defineProperty(list, "selectedIndex", {
    get() {
      return rawIndexes.get(list);
    },
    set(idx: number) {
      const items = list.items;
      const cur = rawIndexes.get(list) ?? 0;
      const clamped = Math.max(0, Math.min(idx, items.length - 1));
      if (!isSep(items[clamped])) {
        rawIndexes.set(list, clamped);
        return;
      }
      // Landed on a separator: travel direction first, then the opposite.
      const step = idx > cur ? 1 : -1;
      const fwd = firstNonSepFrom(items, clamped, step);
      const back = firstNonSepFrom(items, clamped, -step);
      if (inBounds(items, fwd)) rawIndexes.set(list, fwd);
      else if (inBounds(items, back)) rawIndexes.set(list, back);
      else rawIndexes.set(list, clamped);
    },
    configurable: true,
  });
  rawIndexes.set(list, seedIndex(list.items, initialIndex));
}
/**
 * SelectOptions from "provider/model-id" strings, inherit row first.
 * With currentModel/configuredModels: current, then configured, then the rest.
 */
export function buildModelOptions(
  rawOptions: string[],
  currentModel?: string | null,
  configuredModels?: string[],
): SelectOption[] {
  const items: SelectOption[] = [
    { value: null, label: "(inherits parent)", provider: "" },
  ];

  const parsed: SelectOption[] = [];
  for (const opt of rawOptions) {
    const parsedKey = parseModelKey(opt);
    if (!parsedKey) continue;
    parsed.push({
      value: opt,
      label: parsedKey.modelId,
      provider: parsedKey.provider,
    });
  }

  if (!currentModel && !configuredModels) {
    items.push(...parsed);
    return items;
  }

  const current: SelectOption[] = [];
  const configured: SelectOption[] = [];
  const remaining: SelectOption[] = [];

  const added = new Set<string>();

  if (currentModel) {
    const currentParsed = parseModelKey(currentModel);
    if (currentParsed) {
      current.push({
        value: currentModel,
        label: currentParsed.modelId,
        provider: currentParsed.provider,
      });
      added.add(currentModel);
    }
  }

  for (const modelId of configuredModels ?? []) {
    if (added.has(modelId)) continue;
    const parsedKey = parseModelKey(modelId);
    if (parsedKey) {
      configured.push({
        value: modelId,
        label: parsedKey.modelId,
        provider: parsedKey.provider,
      });
      added.add(modelId);
    }
  }

  for (const item of parsed) {
    if (item.value != null && !added.has(item.value)) {
      remaining.push(item);
    }
  }

  items.push(...current, ...configured, ...remaining);
  return items;
}

/** Deduplicated configured model ids (default + per-type overrides). */
export function extractConfiguredModels(
  agentConfig: Readonly<{
    default: string | null;
    [agentType: string]: string | null | undefined | boolean | number;
  }>,
): string[] {
  const models: string[] = [];

  if (agentConfig.default && typeof agentConfig.default === "string") {
    models.push(agentConfig.default);
  }

  for (const [key, value] of Object.entries(agentConfig)) {
    if (key !== "default" && typeof value === "string" && value.includes("/")) {
      models.push(value);
    }
  }

  return [...new Set(models)];
}

/** Build a SettingsListTheme from a pi-coding-agent Theme. */
export function buildSettingsListTheme(theme: {
  fg(color: string, text: string): string;
  bold(text: string): string;
}): SettingsListTheme {
  return {
    label: (text, selected) => (selected ? theme.fg("accent", text) : text),
    value: (text, selected) =>
      selected ? theme.fg("accent", text) : theme.fg("muted", text),
    description: (text) => theme.fg("dim", text),
    // "→ " matches the 2-space non-selected prefix, so rows don't shift under the cursor.
    cursor: theme.fg("accent", "→ "),
    hint: (text) => theme.fg("dim", text),
  };
}

/**
 * Pure numeric validation. Returns parsed number ≥ min, or undefined.
 */
export function validateNumeric(
  value: string,
  min: number,
): number | undefined {
  const trimmed = value.trim();
  // Accept integers and decimals (e.g. 0.5 for 30 seconds)
  if (!/^\d*\.?\d+$/.test(trimmed)) return undefined;
  const parsed = parseFloat(trimmed);
  if (parsed < min) return undefined;
  return parsed;
}

/** Vim navigation keys, as the arrows pi-tui's lists bind. */
const VIM_ARROWS = new Map<string, string>([
  ["k", "\x1b[A"],
  ["j", "\x1b[B"],
]);

/**
 * j/k as list navigation. pi-tui's lists bind arrows only, so this decorates a
 * list in place (handleInput on the instance; instanceof and plain field reads
 * are untouched): a key goes verbatim to an open submenu — whatever is focused
 * there decides what it means — and becomes an arrow only while this list
 * itself is the focused control.
 */
export function withVimKeys<T extends Component>(list: T): T {
  const inner = list as T & { submenuComponent?: Component | null };
  const handle = inner.handleInput?.bind(inner);
  if (!handle) return list;
  inner.handleInput = (data: string) => {
    const arrow = inner.submenuComponent ? undefined : VIM_ARROWS.get(data);
    handle(arrow ?? data);
  };
  return list;
}

/** SelectListTheme matching buildSettingsListTheme's style. */
export function buildSelectListTheme(theme: {
  fg(color: string, text: string): string;
  bold(text: string): string;
}): import("@earendil-works/pi-tui").SelectListTheme {
  return {
    selectedPrefix: () => theme.fg("accent", "→ "),
    selectedText: (text) => theme.fg("accent", text),
    description: (text) => theme.fg("muted", text),
    scrollInfo: (text) => theme.fg("dim", text),
    noMatch: (text) => theme.fg("dim", text),
  };
}

/**
 * Searchable pick-list submenu over a flat option list. onSelect may return
 * a Component to chain into; returning void leaves closing to done().
 */
export function createSearchableSelect(
  items: SelectOption[],
  callbacks: {
    onSelect: (value: string | null) => Component | void;
    onCancel: () => void;
  },
  theme: Theme,
): Component {
  let view: SwappableView;
  const selector = new SearchableSelectDialog(
    items,
    null,
    {
      onSelect: (value) => {
        const next = callbacks.onSelect(value);
        if (next) view.activate(next);
      },
      onCancel: callbacks.onCancel,
    },
    theme,
  );
  view = new SwappableView(selector);
  return view;
}

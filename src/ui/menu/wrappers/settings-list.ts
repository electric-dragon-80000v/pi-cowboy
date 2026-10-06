/**
 * settings-list-wrapper.ts — title bar and separators around a SettingsList or SelectList.
 * Menus close via Escape, back-arrow, and Ctrl-C.
 */

import {
  type Component,
  isFocusable,
  type SettingItem,
} from "@earendil-works/pi-tui";
import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { installSeparatorSkip, withVimKeys } from "../helpers.js";
import { asListFields } from "../screen-host.js";

interface SettingsListWrapperTheme {
  bold: (text: string) => string;
  fg: (color: ThemeColor, text: string) => string;
}

interface SettingsListWrapperOptions {
  title: string;
  theme: SettingsListWrapperTheme;
  separatorChar?: string;
  /** If true, the wrapped body takes keys verbatim: no j/k mapping, no arrow chrome. */
  passthroughKeys?: boolean;
  onCancel?: () => void;
  /**
   * Called with a rebuild(newItems, focusId) function so the caller can trigger
   * in-place updates; `focusId` leaves the cursor on that row instead of the
   * reset row 0.
   */
  onRebuild?: (
    rebuild: (items: SettingItem[], focusId?: string) => void,
  ) => void;
}

/** Horizontal arrows as main-list keys (→ enters, ← escapes); submenus get them raw. */
const HORIZONTAL_ARROWS = new Map<string, string>([
  ["\x1b[C", "\r"],
  ["\x1bOC", "\r"],
  ["\x1b[D", "\x1b"],
  ["\x1bOD", "\x1b"],
]);

export class SettingsListWrapper implements Component {
  private settingsList: Component;
  private title: string;
  private theme: SettingsListWrapperTheme;
  private separatorChar: string;
  private passthroughKeys: boolean;

  constructor(settingsList: Component, options: SettingsListWrapperOptions) {
    // A list body navigates with j/k; a passthrough body takes keys as they come.
    this.settingsList = options.passthroughKeys
      ? settingsList
      : withVimKeys(settingsList);
    this.title = options.title;
    this.theme = options.theme;
    this.separatorChar = options.separatorChar ?? "─";
    this.passthroughKeys = options.passthroughKeys ?? false;

    const list = asListFields<SettingItem>(this.settingsList);

    // SelectList has no onCancel; wire it so Escape/back-arrow/Ctrl-C close the menu.
    if (options.onCancel && !list.onCancel) {
      const closeMenu = options.onCancel;
      list.onCancel = () => closeMenu();
    }

    // Menus push their own SEPARATOR_ID items; keep the cursor off them.
    if (options.onCancel) {
      installSeparatorSkip(list);
    }

    // Descriptions render from the items, so a bare reset stays correct.
    if (options.onRebuild) {
      const rebuild = (newItems: SettingItem[], focusId?: string): void => {
        list.items = newItems;
        list.filteredItems = newItems;
        list.submenuComponent = null;
        // Ids survive a rebuild that reorders or drops rows; an id that is gone
        // falls back to the reset row.
        const focusIndex = newItems.findIndex((item) => item.id === focusId);
        list.selectedIndex = focusIndex > 0 ? focusIndex : 0;
      };
      options.onRebuild(rebuild);
    }
  }

  invalidate(): void {
    this.settingsList.invalidate();
  }

  private get submenuComponent(): Component | null {
    return asListFields(this.settingsList).submenuComponent ?? null;
  }

  /**
   * Whether a leaf is focused, so this list is not the control receiving keys.
   */
  private get hasSubmenu(): boolean {
    return isFocusable(this.submenuComponent);
  }

  handleInput(data: string): void {
    // An open submenu owns every key: a text field there reads j/k as letters,
    // a list there maps them itself.
    if (this.passthroughKeys || this.hasSubmenu) {
      this.settingsList.handleInput?.(data);
      return;
    }
    const mainListKey = HORIZONTAL_ARROWS.get(data);
    if (mainListKey !== undefined) {
      this.settingsList.handleInput?.(mainListKey);
      return;
    }
    this.settingsList.handleInput?.(data);
  }

  render(width: number): string[] {
    const lines: string[] = [];

    lines.push(this.separatorChar.repeat(width));
    lines.push("");

    const styledTitle = this.theme.bold(this.theme.fg("accent", this.title));
    lines.push("  " + styledTitle);
    lines.push("");

    // Strip pi-tui's trailing hint line; descriptions already cover it.
    const settingsLines = this.settingsList.render(width);
    const hintPattern = /Enter\/Space|Esc to cancel/;
    if (
      settingsLines.length >= 2 &&
      hintPattern.test(settingsLines[settingsLines.length - 1] ?? "")
    ) {
      lines.push(...settingsLines.slice(0, -2));
    } else {
      lines.push(...settingsLines);
    }

    lines.push("");
    lines.push(this.separatorChar.repeat(width));

    return lines;
  }
}

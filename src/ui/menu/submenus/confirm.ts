/** confirm-submenu.ts — yes/no confirm dialogs for destructive menu actions. */

import {
  matchesKey,
  SelectList,
  truncateToWidth,
  type Component,
} from "@earendil-works/pi-tui";
import type { Theme } from "../../types.js";
import { asSubmenuComponent } from "../screen-host.js";
import { buildSelectListTheme, withVimKeys } from "../helpers.js";

interface ConfirmSubmenuOptions {
  message: string;
  /** Theme from pi-coding-agent (fg, bold, italic) */
  theme: Theme;
  onConfirm: () => void;
}

export function createConfirmSubmenu(
  options: ConfirmSubmenuOptions,
): (currentValue: string, done: (selectedValue?: string) => void) => Component {
  return (_currentValue: string, done: (selectedValue?: string) => void) => {
    const items = [
      { value: "Yes", label: "Yes", description: options.message },
      { value: "No", label: "No", description: options.message },
    ];

    const list = withVimKeys(
      new SelectList(items, 5, buildSelectListTheme(options.theme)),
    );

    list.onSelect = (item) => {
      if (item.value === "Yes") {
        options.onConfirm();
        done("Yes");
      } else {
        done();
      }
    };
    list.onCancel = () => done();

    return list;
  };
}

/** Options for the key-driven confirmation dialog. */
export interface KeyConfirmOptions {
  /** The question, shown bold at the top. */
  message: string;
  /** Extra lines spelling out the consequence (may be multi-line). */
  detail?: string;
  theme: Theme;
  onYes: () => void;
  onNo: () => void;
}

/**
 * Key-driven yes/no dialog: Y confirms, N or Escape cancels. Its message and
 * detail are free text, so a destructive action's consequence can be spelled
 * out in full — unlike the single-line row descriptions a SelectList shows.
 */
export function createKeyConfirm(options: KeyConfirmOptions): Component {
  const body: Component = {
    invalidate() {},
    render(width: number): string[] {
      const innerW = Math.max(0, width - 4);
      const line = (text: string) =>
        `  ${truncateToWidth(text, innerW, "...", true)}`;
      const lines = [line(options.theme.bold(options.message))];
      if (options.detail) {
        for (const part of options.detail.split("\n")) lines.push(line(part));
      }
      lines.push(line(options.theme.fg("dim", "Y yes \u00b7 N no")));
      return lines;
    },
    handleInput(data: string) {
      // Y accepts shift+y (a capital Y arrives as the legacy uppercase form).
      if (matchesKey(data, "y") || matchesKey(data, "shift+y")) {
        options.onYes();
        return;
      }
      // Escape and N both mean no; every other key is ignored.
      if (
        matchesKey(data, "n") ||
        matchesKey(data, "shift+n") ||
        matchesKey(data, "escape")
      ) {
        options.onNo();
      }
    },
  };
  // Focusable, so the hosting frame routes every key straight here.
  return asSubmenuComponent(body);
}

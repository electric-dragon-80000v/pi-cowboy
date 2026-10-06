/** confirm-submenu.ts — yes/no confirm dialog for destructive SettingsList rows. */

import { SelectList, type Component } from "@earendil-works/pi-tui";
import type { Theme } from "../../types.js";
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

/**
 * list-fields.ts — the list state pi-tui keeps on the instance but out of its
 * types.
 *
 * The menu's frame, a rebuild and the separator skip read and write these
 * fields, so the boundary is one function instead of a cast at each caller.
 */

import type { Component } from "@earendil-works/pi-tui";

/** The list shape the separator skip navigates: pi-tui's private rows and cursor. */
export interface NavigableList<T = unknown> {
  items: T[];
  selectedIndex: number | null;
}

/**
 * pi-tui's private list fields, which the frame, a rebuild and the separator
 * skip read and write. The library keeps them on the instance but out of its
 * types, so `asListFields` is the single cast marking that boundary.
 */
export interface ListFields<T = unknown> extends NavigableList<T> {
  /** Rows a search-enabled SettingsList filters to; a rebuild writes it too. */
  filteredItems: T[];
  /** The in-place child view showing in place of the rows, or null. */
  submenuComponent: Component | null;
  onCancel?: () => void;
}

/** Read pi-tui's private list fields from the list instance. */
export function asListFields<T = unknown>(list: Component): ListFields<T> {
  return list as unknown as ListFields<T>;
}

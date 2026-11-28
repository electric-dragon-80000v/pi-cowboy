/**
 * submenu-contract.ts — what a `SettingItem.submenu` factory returns to pi-tui.
 *
 * pi-tui renders a factory's return value in place of the list's rows until the
 * factory's `done` runs, so a factory that completes instead of hosting returns
 * CLOSED_SUBMENU, and a hosted screen that should own every key is marked with
 * asSubmenuComponent.
 */

import type { Component, Focusable } from "@earendil-works/pi-tui";

/**
 * Close the submenu a factory is building. pi-tui stores the factory's return
 * value as the row's open submenu and only a falsy one leaves it closed, while
 * `SettingItem.submenu` promises a Component — the cast marks that boundary.
 */
export const CLOSED_SUBMENU = undefined as unknown as Component;

/**
 * Host a screen as a submenu, where it owns every key. Our frame asks
 * `isFocusable` before it remaps j/k or the horizontal arrows, so the child has
 * to carry a `focused` field to claim them; pi-tui's own lists declare none.
 */
export function asSubmenuComponent<T extends Component>(
  screen: T,
): T & Focusable {
  return Object.assign(screen, { focused: true });
}

/**
 * extension-toggle.ts — the persisted state of the on/off switch and the
 * indicator setting, and the on-screen marker they decide.
 */

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { getStore } from "./shell.js";
import {
  hideExtensionIndicator,
  showExtensionIndicator,
} from "./ui/indicator.js";

export function isExtensionEnabled(): boolean {
  return getStore().agent.extensionEnabled;
}

/** The marker needs both: an enabled extension, and the setting left on. */
function isActiveIndicatorShown(): boolean {
  return isExtensionEnabled() && getStore().agent.showActiveIndicator;
}

/** Draw 🤠 while the marker is wanted, and take it down when it is not. */
export function syncExtensionIndicator(ui: ExtensionUIContext): void {
  if (isActiveIndicatorShown()) showExtensionIndicator(ui);
  else hideExtensionIndicator();
}

/**
 * Persists the indicator setting and redraws the marker the new value calls
 * for, so the setting takes effect the moment it is flipped.
 */
export function setShowActiveIndicator(
  ui: ExtensionUIContext,
  show: boolean,
): void {
  getStore().mutate.agent.setShowActiveIndicator(show);
  syncExtensionIndicator(ui);
}

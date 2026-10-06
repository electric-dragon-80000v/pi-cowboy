/**
 * action-report.ts — the three-stage report every slow /cowboy action uses.
 *
 * One shape for all of them: an in-progress line the moment the action is
 * selected, then exactly one terminal line — the success it landed on, or an
 * error naming the reason. Naming the stages in one place keeps them reading
 * alike whether they surface in the spawn wizard, the status menu, or the
 * launch coordinator. The terminal lines carry the same themed ✓ and ✗ the
 * tool-result renderers use, so a landing reads alike wherever it lands.
 */

import { errorMessage } from "../utils.js";
import type { Theme } from "./types.js";

/** Notification sink (ctx.ui.notify) — the surface every stage lands on. */
export type ActionNotify = (
  message: string,
  type?: "info" | "warning" | "error",
) => void;

/** The UI surface the stages call through: the notify sink and the live theme. */
export interface ActionTarget {
  notify: ActionNotify;
  readonly theme: Theme;
}

/** One slow action's in-progress and terminal reports. */
export interface ActionReport {
  /** In-progress: `<message>…`, shown while the work runs. */
  pending(message: string): void;
  /** Terminal success: `✓ <message>`, or a warning when it landed with a caveat. */
  succeeded(message: string, kind?: "info" | "warning"): void;
  /** Terminal failure: `✗ <message>: <reason>`, where `reason` may be a thrown value. */
  failed(message: string, reason: unknown): void;
}

/** Bind the three stages to a UI context. */
export function actionReport(target: ActionTarget): ActionReport {
  const check = target.theme.fg("success", "✓");
  const cross = target.theme.fg("error", "✗");
  return {
    pending: (message) => target.notify(`${message} \u2026`, "info"),
    succeeded: (message, kind = "info") =>
      target.notify(`${check} ${message}`, kind),
    failed: (message, reason) =>
      target.notify(`${cross} ${message}: ${errorMessage(reason)}`, "error"),
  };
}

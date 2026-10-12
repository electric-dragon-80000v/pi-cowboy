/**
 * opencode/permissions.ts — this launch's tool selection as opencode's
 * permission map.
 *
 * Names arrive in opencode's own vocabulary — each family's slice is written in
 * the catalogue that defines it, so a launch reads only its own family's — and
 * become permission keys as written, with no translation.
 *
 * opencode decides whether a tool may run by the last permission rule that
 * matches, taken in the map's own key order, so the order is part of the answer:
 * the catch-all leads and every specific key follows it.
 */

import type { ToolSelection } from "../../harness.js";

export type OpencodePermission = "allow" | "deny";

/** opencode's catch-all permission key; every specific rule follows it. */
const ALL_TOOLS = "*";

/** opencode's permission for asking the user a question. */
const QUESTION = "question";

/**
 * `ToolSelection` -> opencode's permission map.
 *
 * `question` is denied wherever the catch-all allows — nobody can answer an
 * approval in a background pane, and opencode's mini mode would wait for one
 * forever — while a denied catch-all already covers questions.
 */
export function opencodePermissions(
  toolSelection: ToolSelection,
): Record<string, OpencodePermission> {
  const permissions: Record<string, OpencodePermission> = {};
  switch (toolSelection.kind) {
    case "default":
      permissions[ALL_TOOLS] = "allow";
      permissions[QUESTION] = "deny";
      return permissions;
    case "none":
      permissions[ALL_TOOLS] = "deny";
      return permissions;
    case "include":
      permissions[ALL_TOOLS] = "deny";
      for (const name of toolSelection.names) {
        permissions[name] = "allow";
      }
      return permissions;
    case "exclude":
      permissions[ALL_TOOLS] = "allow";
      permissions[QUESTION] = "deny";
      for (const name of toolSelection.names) {
        permissions[name] = "deny";
      }
      return permissions;
  }
}

/**
 * opencode/permissions.ts — pi's tool selection as opencode's permission map.
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
 * pi tool names with no permission of their own in opencode: `write`, `edit`,
 * and `patch` are one `edit` permission there. Every other name passes through
 * unchanged, so a pi tool opencode does not know becomes an inert permission key
 * rather than a silent allow.
 */
const EDIT_PERMISSION_TOOLS = new Set(["write", "patch"]);

function permissionKey(toolName: string): string {
  return EDIT_PERMISSION_TOOLS.has(toolName) ? "edit" : toolName;
}

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
        permissions[permissionKey(name)] = "allow";
      }
      return permissions;
    case "exclude":
      permissions[ALL_TOOLS] = "allow";
      permissions[QUESTION] = "deny";
      for (const name of toolSelection.names) {
        permissions[permissionKey(name)] = "deny";
      }
      return permissions;
  }
}

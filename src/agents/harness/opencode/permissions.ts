/**
 * opencode/permissions.ts — this launch's tool selection as opencode's ordered
 * permission rules.
 *
 * Names arrive in opencode's own vocabulary — each family's slice is written in
 * the catalogue that defines it, so a launch reads only its own family's — and
 * become rule actions as written, with no translation.
 *
 * opencode decides whether a tool may run by the last rule that matches, so the
 * order is part of the answer: the catch-all leads and every specific rule
 * follows it.
 */

import type { ToolSelection } from "../../harness.js";

/** One rule of opencode's ordered permission list. */
export interface OpencodePermissionRule {
  readonly action: string;
  readonly resource: string;
  readonly effect: "allow" | "deny";
}

/** opencode's catch-all action; every specific rule follows it. */
const ALL_TOOLS = "*";

/** Every rule this harness writes matches every resource. */
const ALL_RESOURCES = "*";

/** opencode's permission for asking the user a question. */
const QUESTION = "question";

/** One rule, over every resource. */
function rule(
  action: string,
  effect: "allow" | "deny",
): OpencodePermissionRule {
  return { action, resource: ALL_RESOURCES, effect };
}

/**
 * `ToolSelection` -> opencode's permission rules.
 *
 * `question` is denied wherever the catch-all allows — nobody can answer an
 * approval in a background pane, and opencode's mini mode would wait for one
 * forever — while a denied catch-all already covers questions.
 */
export function opencodePermissions(
  toolSelection: ToolSelection,
): OpencodePermissionRule[] {
  switch (toolSelection.kind) {
    case "default":
      return [rule(ALL_TOOLS, "allow"), rule(QUESTION, "deny")];
    case "none":
      return [rule(ALL_TOOLS, "deny")];
    case "include":
      return [
        rule(ALL_TOOLS, "deny"),
        ...toolSelection.names.map((name) => rule(name, "allow")),
      ];
    case "exclude":
      return [
        rule(ALL_TOOLS, "allow"),
        rule(QUESTION, "deny"),
        ...toolSelection.names.map((name) => rule(name, "deny")),
      ];
  }
}

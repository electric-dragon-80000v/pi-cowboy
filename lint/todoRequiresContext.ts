import type { Rule } from "eslint";

// Name + date format (e.g. baris, 2026-08-16).
const NAME_DATE_PATTERN = /TODO\(\s*[^,)]+\s*,\s*\d{4}-\d{2}-\d{2}\s*\)/;
// Ticket reference format (e.g. #123, PROJ-42).
const TICKET_PATTERN = /TODO\(\s*[#A-Za-z0-9_-]+\s*\)/;

/**
 * Requires TODO comments to carry context — either an author with a date
 * (TODO(name, YYYY-MM-DD)) or a ticket reference — so they can be acted on.
 *
 */
const rule: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Require TODO comments to include context (name/date or ticket reference).",
    },
    messages: {
      todoRequiresContext:
        "TODO comments must include context: TODO(name, YYYY-MM-DD) or a ticket reference.",
    },
    schema: [],
  },
  create(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          const text = comment.value.trim();
          const loc = comment.loc;
          if (!loc) {
            continue;
          }
          // Only treat comments that start with the TODO marker as TODOs,
          // so prose that merely mentions "TODO" is ignored.
          if (!/^TODO\b/.test(text)) {
            continue;
          }
          if (!NAME_DATE_PATTERN.test(text) && !TICKET_PATTERN.test(text)) {
            context.report({
              loc,
              messageId: "todoRequiresContext",
            });
          }
        }
      },
    };
  },
};

export default rule;

/**
 * todo-requires-context — a TODO comment must carry context: a name+date
 * (`TODO(name, YYYY-MM-DD)`) or a ticket reference (`TODO(#id)`).
 *
 * The boundaries under test are the rule's two regexes and the `^TODO\b`
 * marker test: only comments whose trimmed text starts with the marker are
 * TODOs, and the marker is case-sensitive.
 */

import todoRequiresContext from "../../lint/todoRequiresContext.js";
import { runRule } from "./rule-tester.js";

runRule("todo-requires-context", todoRequiresContext, {
  valid: [
    // name + date
    "// TODO(baris, 2026-08-16) pin the clock",
    "// TODO(name, 2026-01-01)",
    // ticket reference
    "// TODO(#123) tracked",
    "// TODO(PROJ-42)",
    "// TODO(author)",
    // a block comment body is trimmed before the marker test
    "/* TODO(#7) block todo */",
    // prose that merely mentions TODO does not start with the marker
    "// the TODO list lives in the tracker",
    "const x = 1; // the TODO list lives elsewhere",
    // `TODO\b` is case-sensitive, so lowercase is not the marker
    "// todo(#1) lowercase is not flagged",
    // `\b` fails when the marker runs into another word character
    "// TODOS are tracked elsewhere",
  ],
  invalid: [
    {
      name: "bare TODO at the start of a line",
      code: "// TODO fix later",
      errors: [
        {
          messageId: "todoRequiresContext",
          line: 1,
          column: 0,
          endColumn: 17,
        },
      ],
    },
    {
      name: "bare TODO with nothing after it",
      code: "// TODO",
      errors: [{ messageId: "todoRequiresContext" }],
    },
    {
      name: "indented TODO reports the comment's own start column",
      code: "  // TODO fix",
      errors: [
        {
          messageId: "todoRequiresContext",
          line: 1,
          column: 2,
          endColumn: 13,
        },
      ],
    },
    {
      name: "TODO on a later line",
      code: "const x = 1;\n// TODO bare",
      errors: [{ messageId: "todoRequiresContext", line: 2, column: 0 }],
    },
    {
      name: "bare TODO in a block comment",
      code: "/* TODO: fix */",
      errors: [
        {
          messageId: "todoRequiresContext",
          line: 1,
          column: 0,
          endColumn: 15,
        },
      ],
    },
    {
      name: "empty parentheses carry no context",
      code: "// TODO()",
      errors: [{ messageId: "todoRequiresContext" }],
    },
    {
      name: "name with a malformed date",
      code: "// TODO(name, 2026-8-16)",
      errors: [{ messageId: "todoRequiresContext" }],
    },
    {
      name: "name with a word date",
      code: "// TODO(name, yesterday)",
      errors: [{ messageId: "todoRequiresContext" }],
    },
    {
      name: "TODO followed by a colon only",
      code: "// TODO: something",
      errors: [{ messageId: "todoRequiresContext" }],
    },
  ],
});

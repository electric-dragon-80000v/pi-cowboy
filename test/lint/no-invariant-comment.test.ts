/**
 * no-invariant-comment — a comment that restates a type-encodable invariant
 * (`must`/`always`/`never`/`invariant`) is flagged so the invariant can be
 * moved into the type.
 *
 * The boundaries under test are the keyword pattern and its word boundary, the
 * continuation rule (a `//` line directly under a non-directive `//` line is
 * prose continuing that comment, not a fresh invariant), the directive
 * exception (a generated `eslint-disable-next-line` does not swallow the line
 * under it), and the fixer: only standalone `//` lines are fixed.
 */

import noInvariantComment from "../../lint/noInvariantComment.js";
import { runRule } from "./rule-tester.js";

const DISABLE =
  "// eslint-disable-next-line lite/no-invariant-comment -- encodes a non-obvious choice; the type can't represent it";

runRule("no-invariant-comment", noInvariantComment, {
  valid: [
    "// a plain note",
    // the keyword must start the comment, not merely appear in it
    "// The user must exist",
    // `\b` fails when the keyword runs into another word character
    "// mustered the courage",
    "// nevermind, we handle it",
    "// Invariants are documented by the type",
    // a continuation line is prose, not a fresh invariant
    "// just a preamble\n// must be careful",
    // a directive is not an invariant comment
    "// eslint-disable-next-line no-invariant-comment",
  ],
  invalid: [
    {
      name: "standalone `must` line is reported and fixed",
      code: "// must be true",
      output: `${DISABLE}\n// must be true`,
      errors: [
        {
          messageId: "noInvariantComment",
          line: 1,
          column: 0,
          endColumn: 15,
        },
      ],
    },
    {
      name: "indentation is reproduced by the fixer",
      code: "  // must be true",
      output: `  ${DISABLE}\n  // must be true`,
      errors: [
        {
          messageId: "noInvariantComment",
          line: 1,
          column: 2,
          endColumn: 17,
        },
      ],
    },
    {
      name: "`always` is a keyword",
      code: "// always run this",
      output: `${DISABLE}\n// always run this`,
      errors: [{ messageId: "noInvariantComment" }],
    },
    {
      name: "`never` is a keyword",
      code: "// never do that",
      output: `${DISABLE}\n// never do that`,
      errors: [{ messageId: "noInvariantComment" }],
    },
    {
      name: "`invariant` is a keyword",
      code: "// invariant: x > 0",
      output: `${DISABLE}\n// invariant: x > 0`,
      errors: [{ messageId: "noInvariantComment" }],
    },
    {
      name: "the match is case-insensitive",
      code: "// MUST be set",
      output: `${DISABLE}\n// MUST be set`,
      errors: [{ messageId: "noInvariantComment" }],
    },
    {
      name: "a trailing comment after code reports but is not fixed",
      code: "const x = 1; // must be <= 2",
      output: null,
      errors: [{ messageId: "noInvariantComment" }],
    },
    {
      name: "a block comment reports but is not fixed",
      code: "/* must be true */",
      output: null,
      errors: [{ messageId: "noInvariantComment" }],
    },
    {
      name: "only the first line of a comment block is reported",
      code: "// must be true\n// must also hold",
      output: `${DISABLE}\n// must be true\n// must also hold`,
      errors: [{ messageId: "noInvariantComment", line: 1, column: 0 }],
    },
    {
      name: "non-adjacent comment lines are both reported",
      code: "// must be true\n\n// must be bold",
      output: `${DISABLE}\n// must be true\n\n${DISABLE}\n// must be bold`,
      errors: [
        { messageId: "noInvariantComment", line: 1, column: 0 },
        { messageId: "noInvariantComment", line: 3, column: 0 },
      ],
    },
    {
      name: "a directive above does not swallow the line it disables",
      code: "// eslint-disable-next-line no-invariant-comment\n// must be true",
      output: `// eslint-disable-next-line no-invariant-comment\n${DISABLE}\n// must be true`,
      errors: [{ messageId: "noInvariantComment", line: 2, column: 0 }],
    },
  ],
});

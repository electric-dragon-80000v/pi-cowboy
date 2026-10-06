/**
 * no-date-now-for-duration — `Date.now()` may not appear on either side of a
 * subtraction, because that measures a duration and the monotonic clock
 * (`performance.now()`) is the right source for one.
 *
 * The boundaries under test are the callee shape (`Date.now`, not
 * `Date["now"]` or `Date.now.call`), the `-` operator, and the single
 * exception: a binary subtraction whose parent is `new Date(...)` produces a
 * wall-clock timestamp, not a duration, and is allowed.
 */

import noDateNowForDuration from "../../lint/noDateNowForDuration.js";
import { runRule } from "./rule-tester.js";

runRule("no-date-now-for-duration", noDateNowForDuration, {
  valid: [
    // a bare reading is not a duration
    "const t = Date.now();",
    // the monotonic clock is the point of the rule
    "const d = performance.now() - start;",
    // only subtraction is flagged
    "const d = Date.now() + 1;",
    "const d = Date.now() * 2;",
    "const d = Date.now();",
    "const d = a - b;",
    // the wall-clock timestamp exception
    "const d = new Date(Date.now() - 1000);",
    "const d = new Date(Date.now() - offset).toISOString();",
    // parentheses do not change the parent
    "const d = new Date((Date.now() - offset));",
    // computed access is not the `Date.now` shape
    'const d = Date["now"]() - start;',
    // not a member of the Date identifier
    "const d = clock.now() - start;",
    "const d = Date.utcNow() - start;",
    // unary is not a binary expression
    "const d = -Date.now();",
  ],
  invalid: [
    {
      name: "Date.now() on the left",
      code: "const d = Date.now() - start;",
      errors: [
        {
          messageId: "usePerformanceNow",
          line: 1,
          column: 10,
          endColumn: 28,
        },
      ],
    },
    {
      name: "Date.now() on the right",
      code: "const d = start - Date.now();",
      errors: [{ messageId: "usePerformanceNow" }],
    },
    {
      name: "a literal subtraction of Date.now()",
      code: "const d = Date.now() - 1000;",
      errors: [{ messageId: "usePerformanceNow" }],
    },
    {
      name: "both sides read the clock",
      code: "const d = Date.now() - Date.now();",
      errors: [{ messageId: "usePerformanceNow" }],
    },
    {
      name: "nested in a call argument",
      code: "measure(Date.now() - startedAt);",
      errors: [{ messageId: "usePerformanceNow" }],
    },
  ],
});

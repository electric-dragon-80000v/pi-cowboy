/**
 * no-expect-in-loops — `expect()` may not run inside a loop, nor inside a
 * `.forEach()` callback.
 *
 * The anchors under test are the five loop statement types and the callback
 * rule: a function is only a `.forEach` callback when its parent is a
 * `.forEach(...)` call, so `for (...) { const f = () => expect(x); }` is still
 * caught (the assert is lexically inside the loop) while `.map(() => expect)`
 * is not.
 */

import noExpectInLoops from "../../lint/noExpectInLoops.js";
import { runRule } from "./rule-tester.js";

runRule("no-expect-in-loops", noExpectInLoops, {
  valid: [
    "expect(1).toBe(1);",
    "function f() { expect(1).toBe(1); }",
    "const f = () => { expect(1).toBe(1); };",
    // a `.map` callback is not a `.forEach` callback
    "[1, 2].map((n) => expect(n).toBe(n));",
    // a `.forEach` with no assertion is fine
    "[1, 2].forEach((n) => { consume(n); });",
    "for (const n of [1, 2]) { consume(n); }",
    "while (ready()) { poll(); }",
    "do { poll(); } while (ready());",
    "for (let i = 0; i < 2; i++) { consume(i); }",
    "for (const k in obj) { consume(k); }",
    // not a call at all
    "const expectToBe = 1;",
  ],
  invalid: [
    {
      name: "inside a for statement",
      code: "for (let i = 0; i < 2; i++) { expect(i).toBe(i); }",
      errors: [{ messageId: "noExpectInLoop", line: 1, column: 30 }],
    },
    {
      name: "inside a for-of statement",
      code: "for (const n of xs) { expect(n).toBe(n); }",
      errors: [{ messageId: "noExpectInLoop" }],
    },
    {
      name: "inside a for-in statement",
      code: "for (const k in obj) { expect(k); }",
      errors: [{ messageId: "noExpectInLoop" }],
    },
    {
      name: "inside a while statement",
      code: "while (ready()) { expect(1); }",
      errors: [{ messageId: "noExpectInLoop" }],
    },
    {
      name: "inside a do-while statement",
      code: "do { expect(1); } while (ready());",
      errors: [{ messageId: "noExpectInLoop" }],
    },
    {
      name: "inside an arrow forEach callback",
      code: "[1, 2].forEach((n) => expect(n).toBe(n));",
      errors: [{ messageId: "noExpectInLoop" }],
    },
    {
      name: "inside a function-expression forEach callback",
      code: "items.forEach(function (n) { expect(n); });",
      errors: [{ messageId: "noExpectInLoop" }],
    },
    {
      name: "nested inside an if within a loop",
      code: "for (const n of xs) { if (n) { expect(n); } }",
      errors: [{ messageId: "noExpectInLoop" }],
    },
    {
      name: "inside a function declared in a loop",
      code: "for (const n of xs) { const f = () => expect(n); }",
      errors: [{ messageId: "noExpectInLoop" }],
    },
  ],
});

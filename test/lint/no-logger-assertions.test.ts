/**
 * no-logger-assertions — assertions on logger calls are forbidden because logs
 * are out-of-band.
 *
 * The boundaries under test are the callee property shape (`toHaveBeenCalled`
 * prefix, case-sensitive, non-computed), the modifier-chain unwrap (only
 * `not`/`resolves`/`rejects`), and the first-argument test: the argument's
 * source text must contain `logger` (case-insensitive).
 */

import noLoggerAssertions from "../../lint/noLoggerAssertions.js";
import { runRule } from "./rule-tester.js";

runRule("no-logger-assertions", noLoggerAssertions, {
  valid: [
    // the asserted value is not the logger
    "expect(foo).toHaveBeenCalled();",
    // the matcher is not a toHaveBeenCalled* call
    "expect(logger).toBe(1);",
    "expect(logger).toEqual(other);",
    // case-sensitive prefix: a lowercase `called` does not match
    "expect(logger).toHaveBeencalled();",
    // a plain logger call is not an assertion
    "logger.info('x');",
    // no argument to inspect
    "expect().toHaveBeenCalled();",
    // a computed matcher is not the static member shape
    "expect(logger)[matcher]();",
    // an unknown modifier is not unwrapped, so the base is not an expect call
    "expect(logger).foo.toHaveBeenCalled();",
    // capitalisation of the argument is up to the regex, but this one has none
    "expect(LOG).toHaveBeenCalled();",
    // the matcher chain hangs off a non-expect base
    "other(logger).toHaveBeenCalled();",
  ],
  invalid: [
    {
      name: "the basic logger assertion",
      code: "expect(logger).toHaveBeenCalled();",
      errors: [
        {
          messageId: "noLoggerAssertion",
          line: 1,
          column: 0,
          endColumn: 33,
        },
      ],
    },
    {
      name: "a logger member",
      code: "expect(logger.info).toHaveBeenCalledWith('x');",
      errors: [{ messageId: "noLoggerAssertion" }],
    },
    {
      name: "through a not modifier",
      code: "expect(logger).not.toHaveBeenCalled();",
      errors: [{ messageId: "noLoggerAssertion" }],
    },
    {
      name: "through a resolves modifier",
      code: "expect(logger).resolves.toHaveBeenCalled();",
      errors: [{ messageId: "noLoggerAssertion" }],
    },
    {
      name: "through a rejects modifier",
      code: "expect(getLogger()).rejects.toHaveBeenCalledTimes(1);",
      errors: [{ messageId: "noLoggerAssertion" }],
    },
    {
      name: "the argument merely contains logger",
      code: "expect(buildLogger()).toHaveBeenCalled();",
      errors: [{ messageId: "noLoggerAssertion" }],
    },
    {
      name: "case-insensitive argument match",
      code: "expect(Logger.child).toHaveBeenCalledWith('a');",
      errors: [{ messageId: "noLoggerAssertion" }],
    },
  ],
});

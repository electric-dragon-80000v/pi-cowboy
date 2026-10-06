/**
 * Shared harness for the `lint/` rule tests.
 *
 * `oxlint/plugins-dev`'s `RuleTester` is the tester the rules actually ship
 * under. Its `run` is typed against oxlint's own ESLint-compatible `Rule`
 * shape, which is not exported and does not unify with the `eslint` package's
 * `Rule.RuleModule` the rule modules are authored against. The two shapes are
 * compatible at runtime — the same objects run under oxlint unmodified — so
 * the type boundary is bridged once here instead of in every test.
 */

import { describe, it } from "vitest";
import { RuleTester } from "oxlint/plugins-dev";
import type { Rule } from "eslint";

RuleTester.describe = describe;
RuleTester.it = it;

export const ruleTester = new RuleTester({
  languageOptions: { parserOptions: { lang: "ts" } },
});

type TesterRule = Parameters<RuleTester["run"]>[1];

export const runRule = (
  name: string,
  rule: Rule.RuleModule,
  tests: RuleTester.TestCases,
): void => {
  ruleTester.run(name, rule as unknown as TesterRule, tests);
};

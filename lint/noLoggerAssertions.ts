import type { Expression, Super } from "estree";
import type { Rule } from "eslint";

/**
 * Disallows asserting on logger calls (e.g. expect(logger.info).toHaveBeenCalled()).
 * Logs are out-of-band and subject to change, so tests must not couple to them.
 *
 */
const rule: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow assertions on logger calls; logs are out-of-band and not part of a stable API.",
    },
    messages: {
      noLoggerAssertion:
        "Do not assert on logger calls. Logs are out-of-band and subject to change.",
    },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        const { callee } = node;
        if (
          callee.type !== "MemberExpression" ||
          callee.computed ||
          callee.property.type !== "Identifier" ||
          !/^toHaveBeenCalled/.test(callee.property.name)
        ) {
          return;
        }

        // Unwrap modifier chains like expect(x).not / .resolves / .rejects
        // so `expect(logger.x).not.toHaveBeenCalled()` is caught too.
        let expectCall: Expression | Super = callee.object;
        while (
          expectCall.type === "MemberExpression" &&
          !expectCall.computed &&
          expectCall.property.type === "Identifier" &&
          ["not", "resolves", "rejects"].includes(expectCall.property.name)
        ) {
          expectCall = expectCall.object;
        }

        if (
          expectCall.type !== "CallExpression" ||
          expectCall.callee.type !== "Identifier" ||
          expectCall.callee.name !== "expect" ||
          expectCall.arguments.length === 0
        ) {
          return;
        }

        const argumentText = context.sourceCode.getText(
          expectCall.arguments[0],
        );
        if (/logger/i.test(argumentText)) {
          context.report({ node, messageId: "noLoggerAssertion" });
        }
      },
    };
  },
};

export default rule;

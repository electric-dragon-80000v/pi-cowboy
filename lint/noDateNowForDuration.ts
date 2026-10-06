import type { Expression, PrivateIdentifier } from "estree";
import type { Rule } from "eslint";

/**
 * Flags Date.now() used in subtraction (a duration/timing pattern). Elapsed
 * time should be measured with the monotonic clock (performance.now()) instead;
 * wall-clock timestamps should use new Date().toISOString().
 *
 */
const rule: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow Date.now() in subtraction; use performance.now() for durations.",
    },
    messages: {
      usePerformanceNow:
        "Use performance.now() (monotonic clock) to measure elapsed time instead of subtracting Date.now().",
    },
    schema: [],
  },
  create(context) {
    const isDateNowCall = (node: Expression | PrivateIdentifier): boolean =>
      node.type === "CallExpression" &&
      node.callee.type === "MemberExpression" &&
      !node.callee.computed &&
      node.callee.object.type === "Identifier" &&
      node.callee.object.name === "Date" &&
      node.callee.property.type === "Identifier" &&
      node.callee.property.name === "now";

    return {
      BinaryExpression(node) {
        if (node.operator !== "-") {
          return;
        }
        if (!(isDateNowCall(node.left) || isDateNowCall(node.right))) {
          return;
        }

        // new Date(Date.now() - offset) is a wall-clock timestamp, not a
        // duration measurement, so it is allowed.
        const parent = node.parent;
        if (
          parent &&
          parent.type === "NewExpression" &&
          parent.callee.type === "Identifier" &&
          parent.callee.name === "Date"
        ) {
          return;
        }

        context.report({ node, messageId: "usePerformanceNow" });
      },
    };
  },
};

export default rule;

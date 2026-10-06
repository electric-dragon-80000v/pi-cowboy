import type { Rule } from "eslint";

const LOOP_TYPES = new Set([
  "ForStatement",
  "ForOfStatement",
  "ForInStatement",
  "WhileStatement",
  "DoWhileStatement",
]);

const FUNCTION_TYPES = new Set([
  "ArrowFunctionExpression",
  "FunctionExpression",
  "FunctionDeclaration",
]);

/**
 * Disallows expect() inside loops and inside .forEach() callbacks.
 * Loop-based assertions collapse every case into a single test, so the
 * parameterized-test style (it.each/test.each) should be used instead.
 *
 */
const rule: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow expect() inside loops; use parameterized tests (it.each/test.each) instead.",
    },
    messages: {
      noExpectInLoop:
        "Do not call expect() inside a loop. Use a parameterized test (it.each/test.each) instead.",
    },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        if (
          node.callee.type !== "Identifier" ||
          node.callee.name !== "expect"
        ) {
          return;
        }

        let current: Rule.Node | null = node.parent;
        while (current) {
          if (LOOP_TYPES.has(current.type)) {
            context.report({ node, messageId: "noExpectInLoop" });
            return;
          }

          // A function node is a .forEach callback when its parent is a call
          // to `.forEach(...)`.
          if (FUNCTION_TYPES.has(current.type)) {
            const parent = current.parent;
            if (
              parent &&
              parent.type === "CallExpression" &&
              parent.callee.type === "MemberExpression" &&
              !parent.callee.computed &&
              parent.callee.property.type === "Identifier" &&
              parent.callee.property.name === "forEach"
            ) {
              context.report({ node, messageId: "noExpectInLoop" });
              return;
            }
          }

          current = current.parent;
        }
      },
    };
  },
};

export default rule;

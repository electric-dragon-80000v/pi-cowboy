import type { Rule } from "eslint";

const INVARIANT_PATTERN = /^\s*(must|always|never|invariant)\b/i;

// A configuration directive, e.g. the `eslint-disable-next-line` this rule's
// own fixer inserts.
const DIRECTIVE_PATTERN =
  /^\s*eslint-(?:disable|enable)(?:-next-line|-line)?\b/;

const DISABLE_TEXT =
  "// eslint-disable-next-line lite/no-invariant-comment -- encodes a non-obvious choice; the type can't represent it";

const rule: Rule.RuleModule = {
  meta: {
    type: "suggestion",
    fixable: "code",
    docs: {
      description:
        "Disallow comments that restate a type-encodable invariant; encode it in the type instead.",
    },
    messages: {
      noInvariantComment:
        "Comment restates an invariant — encode it in the type instead.",
    },
    schema: [],
  },
  create(context) {
    return {
      Program() {
        const comments = context.sourceCode.getAllComments();
        for (let i = 0; i < comments.length; i++) {
          const comment = comments[i];
          const loc = comment.loc;
          const range = comment.range;
          if (!loc || !range) {
            continue;
          }
          // A `//` line directly under another `//` line continues that
          // comment block; only the block's first line can start it. A
          // directive is not prose, so the line under one starts fresh —
          // otherwise a comment this rule's fixer just disabled would be
          // skipped, leaving the directive looking unused.
          const prev = i > 0 ? comments[i - 1] : null;
          if (
            comment.type === "Line" &&
            prev?.type === "Line" &&
            !DIRECTIVE_PATTERN.test(prev.value) &&
            prev.loc?.end.line === loc.start.line - 1
          ) {
            continue;
          }
          if (INVARIANT_PATTERN.test(comment.value)) {
            // Auto-fix only for standalone `//` lines (nothing but
            // whitespace before the comment on its line). Trailing comments
            // after code get no fixer and fall through to a manual disable.
            const line = context.sourceCode.lines[loc.start.line - 1];
            const indent = line.slice(0, loc.start.column);
            const standalone = comment.type === "Line" && /^\s*$/.test(indent);
            context.report({
              loc,
              messageId: "noInvariantComment",
              ...(standalone
                ? {
                    fix(fixer) {
                      return fixer.insertTextBeforeRange(
                        range,
                        `${DISABLE_TEXT}\n${indent}`,
                      );
                    },
                  }
                : {}),
            });
          }
        }
      },
    };
  },
};

export default rule;

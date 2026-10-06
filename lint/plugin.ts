// oxlint loads this barrel through Node's ESM resolver, so the rule imports
// carry explicit `.ts` extensions.
import noDateNowForDuration from "./noDateNowForDuration.ts";
import noExpectInLoops from "./noExpectInLoops.ts";
import noInvariantComment from "./noInvariantComment.ts";
import noLoggerAssertions from "./noLoggerAssertions.ts";
import todoRequiresContext from "./todoRequiresContext.ts";

// The rule modules are typed against `eslint`'s rule shape; oxlint's JS-plugin
// API is ESLint v9-compatible, so the same objects run unmodified.
const plugin = {
  meta: { name: "lite" },
  rules: {
    "no-date-now-for-duration": noDateNowForDuration,
    "no-expect-in-loops": noExpectInLoops,
    "no-invariant-comment": noInvariantComment,
    "no-logger-assertions": noLoggerAssertions,
    "todo-requires-context": todoRequiresContext,
  },
};

export default plugin;

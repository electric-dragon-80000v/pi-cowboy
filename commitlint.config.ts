import type { UserConfig } from "@commitlint/types";

// The rules here are the same conventional-commit grammar
// `@semantic-release/commit-analyzer` derives the version bump from, so a
// message that passes the hook is a message that can be released.
//
// commitlint transpiles this file rather than type-checking it; `npm run
// typecheck` is what checks the `UserConfig` shape.
const config: UserConfig = {
  extends: ["@commitlint/config-conventional"],
};

export default config;

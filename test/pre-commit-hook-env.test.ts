/**
 * pre-commit-hook-env.test.ts — pins the pre-commit hook's git-environment sanitizer to
 * git's own repo-affecting variable list. Two-sided: names come from the git binary at
 * runtime, and the hook's sanitizer text is executed against a leaking environment.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HOOK_PATH = fileURLToPath(
  new URL("../.husky/pre-commit", import.meta.url),
);

const SECTION_HEADER = "# ─── Sanitize the git environment";
const NEXT_SECTION_HEADER = "# ─── ";

/** Identity/date vars git injects into hooks (beyond `--local-env-vars`); left set, fixture commits differ from a plain run. */
const INJECTED_IDENTITY_VARS = [
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_AUTHOR_DATE",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  "GIT_COMMITTER_DATE",
];

/** Sentinel value the sanitizer is executed against. */
const LEAKED_VALUE = "leaked-from-the-surrounding-commit";

/** The hook's sanitize section, verbatim — executing it here cannot drift from the hook. */
function sanitizeSection(): string {
  const lines = readFileSync(HOOK_PATH, "utf8").split("\n");
  const start = lines.findIndex((line) => line.startsWith(SECTION_HEADER));
  const end = lines.findIndex(
    (line, index) => index > start && line.startsWith(NEXT_SECTION_HEADER),
  );
  if (start < 0 || end < 0) {
    throw new Error(
      `could not find the "${SECTION_HEADER}" section in .husky/pre-commit; ` +
        "keep that header and the one that ends the section, or update this test",
    );
  }
  return lines.slice(start + 1, end).join("\n");
}

/** Variable names the section unsets. */
function unsetNames(section: string): string[] {
  const names = section
    .replaceAll("\\\n", " ")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("unset "))
    .flatMap((line) => line.slice("unset ".length).split(/\s+/));
  return [...new Set(names.filter((name) => name.length > 0))];
}

/** Every variable that can point a git command elsewhere, per git itself. */
function localEnvVars(): string[] {
  // Needs no repository, so this works in the hook's exported-copy check too.
  return execFileSync("git", ["rev-parse", "--local-env-vars"], {
    encoding: "utf8",
  })
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

describe("pre-commit hook git environment", () => {
  it("unsets something at all", () => {
    expect(
      unsetNames(sanitizeSection()),
      "no `unset` command found in the hook's sanitize section — the sanitizer is gone",
    ).not.toEqual([]);
  });

  it("unsets every repo-affecting variable git names", () => {
    const names = unsetNames(sanitizeSection());
    const missing = localEnvVars().filter((name) => !names.includes(name));
    expect(
      missing,
      "these can point a fixture's git at another repository; add them to the hook's unset list",
    ).toEqual([]);
  });

  it("unsets the identity/date variables git injects into the hook", () => {
    const names = unsetNames(sanitizeSection());
    const missing = INJECTED_IDENTITY_VARS.filter(
      (name) => !names.includes(name),
    );
    expect(
      missing,
      "git exports the outer commit's identity/date into the hook; leaving these set makes fixture commits differ from a plain `npm test` run",
    ).toEqual([]);
  });

  it("leaves GIT_EDITOR set so a fixture commit cannot open an editor", () => {
    // git sets GIT_EDITOR=: for non-interactive commits; clearing it lets `git commit`
    // without -m launch a real editor and hang the suite.
    expect(
      unsetNames(sanitizeSection()),
      "unsetting GIT_EDITOR lets a fixture `git commit` without -m block on a real editor",
    ).not.toContain("GIT_EDITOR");
  });

  it("actually clears the leaked environment when executed", () => {
    const names = unsetNames(sanitizeSection());
    const script = [
      sanitizeSection(),
      'for name in "$@"; do',
      '  if printenv "$name" > /dev/null 2>&1; then printf "%s\\n" "$name"; fi',
      "done",
    ].join("\n");
    const leakedEnv = Object.fromEntries(
      names.map((name) => [name, LEAKED_VALUE]),
    );

    const survivors = execFileSync(
      "/bin/bash",
      ["-c", script, "--", ...names],
      {
        encoding: "utf8",
        env: { ...process.env, ...leakedEnv },
      },
    )
      .trim()
      .split("\n")
      .filter((line) => line.length > 0);

    expect(
      survivors,
      "the hook names these in its unset list, but its sanitizer does not clear them",
    ).toEqual([]);
  });
});

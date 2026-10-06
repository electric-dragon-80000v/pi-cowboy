import type { Options } from "semantic-release";

// The default preset is `conventional-changelog-angular`, whose header pattern
// (`/^(\w*)(?:\((.*)\))?: (.*)$/`) has no room for the breaking `!` shorthand.
// `@commitlint/config-conventional` accepts `feat!: ...`, so without these two
// patterns a breaking commit passes the hook and then parses as no commit at
// all: no version bump and no changelog entry. They are the patterns
// commitlint's own preset (`conventional-changelog-conventionalcommits`) uses,
// so the grammar the hook enforces is the grammar the release reads.
const commitGrammar = {
  headerPattern: /^(\w*)(?:\((.*)\))?!?: (.*)$/,
  breakingHeaderPattern: /^(\w*)(?:\((.*)\))?!: (.*)$/,
};

// The analysis and changelog steps otherwise fall back to
// `conventional-changelog-angular`, which is the preset semantic-release
// installs alongside them. The `conventionalcommits` preset is deliberately not
// configured: its current major requires conventional-changelog-writer@9 while
// semantic-release's plugins resolve writer@8, so configuring it fails note
// generation outright rather than producing a changelog.
//
// semantic-release loads this through cosmiconfig's TypeScript loader, which
// transpiles it with `typescript.transpileModule` and imports the result, so the
// file is never type-checked at load time; `pnpm run typecheck` is what checks it.
const config: Options = {
  branches: ["main"],
  plugins: [
    ["@semantic-release/commit-analyzer", { parserOpts: commitGrammar }],
    [
      "@semantic-release/release-notes-generator",
      { parserOpts: commitGrammar },
    ],
    ["@semantic-release/changelog", { changelogFile: "CHANGELOG.md" }],
    [
      "@semantic-release/npm",
      {
        // This plugin's part is the version bump: `npmPublish: false` writes the
        // new version into package.json (which is in the release commit below)
        // and stops there. It cannot stage the release instead, because the
        // `npm publish` it runs is refused by a stage-only trusted publisher —
        // staging is the plugin below.
        npmPublish: false,
      },
    ],
    [
      "@semantic-release/exec",
      {
        // Staging, not publishing: the version lands in the registry's staging
        // area and a maintainer releases it by approving it with 2FA. This is
        // the same command `.github/workflows/publish.yml` and a developer's
        // machine run, so every path stages the same artifact.
        publishCmd: "npm stage publish",
      },
    ],
    "@semantic-release/github",
    [
      "@semantic-release/git",
      {
        // The version bump rewrites package.json, and the changelog is
        // generated; those two are the release commit. pnpm-lock.yaml is not in
        // it because the lockfile records no version for the root project, so
        // the bump leaves it byte-identical (verified with
        // `pnpm install --frozen-lockfile` against a bumped manifest).
        assets: ["package.json", "CHANGELOG.md"],
        message:
          "chore(release): ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}",
      },
    ],
  ],
};

export default config;

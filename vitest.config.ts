/**
 * vitest.config.ts — one root config, three projects.
 *
 * The suite is split by what a test needs to be real, not by what it covers:
 *
 *   - `unit`               — every `*.test.ts` file, minus the integration files
 *                            below.
 *   - `integration-no-cow` — every `*.integration.test.ts` file that does not
 *                            need a clone-capable volume: real git repositories
 *                            and real `bash`/`sh`, real `pi` processes headless
 *                            against a localhost stub, and/or real HTTP on
 *                            127.0.0.1. Runs on any filesystem, ext4 included.
 *   - `integration-cow`    — every `*.cow.integration.test.ts` file: the
 *                            copy-on-write materialization tests that only hold
 *                            on a volume where `cp --reflink`/`clonefile`
 *                            really clones (a btrfs loop device in CI). These
 *                            assert a clone, so on a non-clone volume they take
 *                            the fallback path and fail — they are deliberately
 *                            kept out of the run that happens everywhere.
 *
 * The split is carried by the FILE NAME, so a new test lands in the right
 * project by being named correctly — there is no list to keep in sync. A file
 * belongs to exactly one project, so a test that needs a clone-capable volume
 * must live in a `*.cow.integration.test.ts` file and every other integration
 * test in a plain `*.integration.test.ts` file.
 *
 * Both integration projects are declared here, so a bare `vitest run`
 * (`npm test`) still runs the whole suite; `--project unit`,
 * `--project integration-no-cow` and `--project integration-cow` (the
 * `test:unit` / `test:integration-no-cow` / `test:integration-cow` scripts)
 * narrow it, and `test:integration` runs both integration projects together.
 * `test:unit` is the pre-commit gate.
 *
 * This file sits outside tsconfig's `include` (`src`, `test`) and matches the
 * ignore pattern oxlint.config.ts keeps for `*.config.ts` files, so it is
 * neither typechecked nor linted.
 */

import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // ─── Shared root settings (inherited by every project) ─────────────────
    // Vitest's default externals restated at the root, so a project's
    // `exclude` override cannot silently drop `node_modules/` and start
    // collecting third-party tests.
    exclude: configDefaults.exclude,
    projects: [
      {
        // `extends: true` inherits the root settings above (vitest 4 semantics:
        // "the project will inherit all options from the root config"); the
        // project's own `test` block is merged over them, and the root's
        // `projects` list itself is never inherited.
        extends: true,
        test: {
          name: "unit",
          include: ["**/*.test.ts"],
          // The `.integration.test.ts` infix is the whole boundary: this is the
          // only rule that decides which project owns a file, so it must come
          // after vitest's own default externals. It also covers the
          // `.cow.integration.test.ts` files below.
          exclude: [...configDefaults.exclude, "**/*.integration.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          // The filesystem-independent integration set. `exclude` restates the
          // root default before dropping the clone-only files, so it cannot
          // start collecting `node_modules/`.
          name: "integration-no-cow",
          include: ["**/*.integration.test.ts"],
          exclude: [...configDefaults.exclude, "**/*.cow.integration.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "integration-cow",
          include: ["**/*.cow.integration.test.ts"],
        },
      },
    ],
  },
});

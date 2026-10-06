import { defineConfig } from "oxlint";

// Single lint configuration for the whole repo (oxlint auto-discovers this
// file). Type-aware rules run through the `oxlint-tsgolint` sidecar, which
// resolves from this project's node_modules; `tsc --noEmit` remains the type
// gate (`options.typeCheck` is deliberately off — oxlint is the linter, not the
// type checker).
export default defineConfig({
  options: {
    typeAware: true,
  },
  // Declaring `plugins` replaces oxlint's default set, so every plugin in use is
  // named here: `import` (off by default) plus the default-on `unicorn` and
  // `typescript` whose rules this repo relies on.
  plugins: ["import", "unicorn", "typescript"],
  categories: { correctness: "error" },
  env: { builtin: true },
  // Paths resolve against this file. `import-x-js` is an alias because the bare
  // `import` name is reserved for the native plugin.
  jsPlugins: [
    "./lint/plugin.ts",
    { name: "import-x-js", specifier: "eslint-plugin-import-x" },
  ],
  // `lint/` holds the local rule implementations loaded through `jsPlugins`;
  // like any plugin directory it is not itself linted.
  ignorePatterns: [
    "**/build/",
    "**/dist/",
    "**/node_modules/",
    "**/out/",
    "**/coverage/",
    "**/.worktree/",
    "**/.cache/",
    "**/.nyc_output/",
    "**/reports/",
    "**/*.config.js",
    "**/*.config.ts",
    "lint/**",
    "**/vitest.config.ts",
  ],
  rules: {
    "constructor-super": "error",
    "for-direction": "error",
    "getter-return": "error",
    "no-async-promise-executor": "error",
    "no-case-declarations": "error",
    "no-class-assign": "error",
    "no-compare-neg-zero": "error",
    "no-cond-assign": "error",
    "no-const-assign": "error",
    "no-constant-binary-expression": "error",
    "no-constant-condition": "error",
    "no-control-regex": "error",
    "no-debugger": "error",
    "no-delete-var": "error",
    "no-dupe-class-members": "error",
    "no-dupe-else-if": "error",
    "no-dupe-keys": "error",
    "no-duplicate-case": "error",
    "no-empty": "error",
    "no-empty-character-class": "error",
    "no-empty-pattern": "error",
    "no-empty-static-block": "error",
    "no-ex-assign": "error",
    "no-extra-boolean-cast": "error",
    "no-fallthrough": "error",
    "no-func-assign": "error",
    "no-global-assign": "error",
    "no-import-assign": "error",
    "no-invalid-regexp": "error",
    "no-irregular-whitespace": "error",
    "no-loss-of-precision": "error",
    "no-misleading-character-class": "error",
    "no-new-native-nonconstructor": "error",
    "no-nonoctal-decimal-escape": "error",
    "no-obj-calls": "error",
    "no-prototype-builtins": "error",
    "no-redeclare": "error",
    "no-regex-spaces": "error",
    "no-self-assign": "error",
    "no-setter-return": "error",
    "no-shadow-restricted-names": "error",
    "no-sparse-arrays": "error",
    "no-this-before-super": "error",
    "no-unassigned-vars": "error",
    "no-unexpected-multiline": "error",
    "no-unreachable": "error",
    "no-unsafe-finally": "error",
    "no-unsafe-negation": "error",
    "no-unsafe-optional-chaining": "error",
    "no-unused-labels": "error",
    "no-unused-private-class-members": "error",
    "no-unused-vars": "error",
    "no-useless-backreference": "error",
    "no-useless-catch": "error",
    "no-useless-escape": "error",
    "no-with": "error",
    "preserve-caught-error": "error",
    "require-yield": "error",
    "use-isnan": "error",
    "valid-typeof": "error",
    // Nursery rules turned on individually: their category is a moving target of
    // experimental rules, so enabling it would lint with rules nobody chose.
    "no-useless-assignment": "error",
    "import/export": "error",
  },
  overrides: [
    // Import hygiene. The native plugin resolves `.js` specifiers to `.ts`
    // sources through the project's tsconfig, so no resolver settings are
    // needed. `exports-last` and `group-exports` are off: this repo declares
    // exports inline where they are defined rather than in one trailing block.
    {
      files: ["src/**/*.{ts,tsx}", "test/**/*.{ts,tsx}"],
      rules: {
        "import/no-duplicates": "error",
        "import/no-empty-named-blocks": "error",
        "import/no-mutable-exports": "error",
        "import/no-named-as-default": "error",
        "import/no-named-as-default-member": "error",
        // Max 15 value imports (type-only imports don't count): the menus and
        // coordinator legitimately wire many pieces together.
        "import/max-dependencies": [
          "error",
          { max: 15, ignoreTypeImports: true },
        ],
        "import/first": "error",
        // Import ordering has no native equivalent, so it runs through the
        // aliased plugin (`import-x-js/order`, not the reserved `import/order`).
        "import-x-js/order": "error",
        "import/no-dynamic-require": "error",
        "import/no-cycle": "error",
        "import/no-absolute-path": "error",
        // Node built-ins must be imported as namespaces under module: nodenext
        // (`import * as path from "node:path"`), which this rule would
        // otherwise flag.
        "import/no-namespace": [
          "error",
          {
            ignore: [
              "node:path",
              "node:fs",
              "node:os",
              "node:url",
              "node:util",
              "node:child_process",
            ],
          },
        ],
        "import/no-default-export": "error",
      },
    },
    // The pi extension contract requires the entry point to be the default
    // export (pi loads `export default` from the extension module).
    {
      files: ["src/index.ts"],
      rules: {
        "import/no-default-export": "off",
      },
    },
    {
      files: ["**/*.{ts,tsx}"],
      rules: {
        "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
        "typescript/no-explicit-any": "error",
        "typescript/no-floating-promises": "error",
        "typescript/no-unnecessary-condition": [
          "error",
          // `while (true)` is the deliberate shape of the walk and poll loops:
          // their exit is a break or return in the body, not the condition.
          { allowConstantLoopConditions: true },
        ],
        "typescript/switch-exhaustiveness-check": [
          "error",
          // Platform switches here handle the platforms they implement and route
          // everything else to an explicit fail-loud default; enumerating every
          // NodeJS.Platform member would only add noise.
          { considerDefaultExhaustiveForUnions: true },
        ],
        "typescript/prefer-nullish-coalescing": "error",
        "typescript/no-restricted-types": [
          "error",
          {
            types: {
              any: "Use `unknown` and narrow it.",
            },
          },
        ],
        "lite/no-date-now-for-duration": "error",
        "lite/no-expect-in-loops": "error",
        "lite/no-invariant-comment": "warn",
        "lite/no-logger-assertions": "error",
        "lite/todo-requires-context": "error",
      },
      env: { node: true },
    },
    // The repo convention is kebab-case file names (with a few single-word
    // names); camelCase is allowed alongside it. oxlint's rule never inspects
    // directory names, so there is no option to disable that check.
    {
      files: ["**/*.{ts,tsx,js,jsx,mjs,cjs}"],
      rules: {
        "unicorn/filename-case": [
          "error",
          {
            cases: { camelCase: true, kebabCase: true },
          },
        ],
      },
    },
    {
      files: ["**/*.{js,jsx,mjs,cjs}"],
      rules: {
        "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      },
      env: { es2022: true, node: true },
    },
  ],
});

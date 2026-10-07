/**
 * no-host-package-dynamic-import — a package pi supplies to extensions may not
 * be reached through dynamic `import()`.
 *
 * The boundaries under test are the specifier shape (a literal, either the
 * package name itself or a subpath) and the import form (the `ImportExpression`
 * of `import(x)` and the older `CallExpression` on an `Import` callee). A
 * non-literal specifier and a `type` position (`import("...").X` used as a
 * type) are not runtime imports and stay valid.
 */

import noHostPackageDynamicImport from "../../lint/noHostPackageDynamicImport.js";
import { runRule } from "./rule-tester.js";

runRule("no-host-package-dynamic-import", noHostPackageDynamicImport, {
  valid: [
    // static imports are how pi supplies the host packages
    'import { SettingsManager } from "@earendil-works/pi-coding-agent";',
    // a non-host package resolves normally
    'await import("./local.js");',
    'await import("mustache");',
    // a prefix is not the package
    'await import("typeboxer");',
    'await import("@earendil-works/pi-coding-agent-extra");',
    // the specifier is not a literal
    "await import(name);",
    // a type position is erased, not a runtime import
    'type Theme = import("@earendil-works/pi-tui").SelectListTheme;',
  ],
  invalid: [
    {
      name: "the coding-agent barrel",
      code: 'await import("@earendil-works/pi-coding-agent");',
      errors: [{ messageId: "noHostPackageDynamicImport" }],
    },
    {
      name: "a subpath of a host package",
      code: 'await import("@earendil-works/pi-ai/compat");',
      errors: [{ messageId: "noHostPackageDynamicImport" }],
    },
    {
      name: "typebox, by name",
      code: 'await import("typebox");',
      errors: [{ messageId: "noHostPackageDynamicImport" }],
    },
    {
      name: "the legacy namespace",
      code: 'await import("@mariozechner/pi-tui");',
      errors: [{ messageId: "noHostPackageDynamicImport" }],
    },
    {
      name: "a bare import expression",
      code: 'const m = import("@sinclair/typebox/value");',
      errors: [{ messageId: "noHostPackageDynamicImport" }],
    },
  ],
});

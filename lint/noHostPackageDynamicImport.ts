import type { Expression, SpreadElement } from "estree";
import type { Rule } from "eslint";

/**
 * Flags dynamic `import()` of a package pi supplies to extensions. Pi resolves
 * those specifiers through its extension loader (jiti aliases and virtual
 * modules), which rewrites a module's static imports only. A dynamic `import()`
 * is left to Node, and in a packaged extension Node loads the module natively
 * and cannot resolve the specifier, so the call throws at runtime. Import the
 * host package statically instead.
 */

/** Host packages pi supplies through its loader aliases and virtual modules. */
const HOST_PACKAGES = [
  "typebox",
  "@sinclair/typebox",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
  "@mariozechner/pi-ai",
  "@mariozechner/pi-agent-core",
  "@mariozechner/pi-coding-agent",
  "@mariozechner/pi-tui",
];

const rule: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow dynamic import() of a package pi supplies to extensions; import it statically.",
    },
    messages: {
      noHostPackageDynamicImport:
        '`import("{{specifier}}")` is not resolved in an installed extension — import the host package statically instead.',
    },
    schema: [],
  },
  create(context) {
    const isHostPackage = (specifier: string): boolean =>
      HOST_PACKAGES.some(
        (pkg) => specifier === pkg || specifier.startsWith(`${pkg}/`),
      );

    const check = (source: Expression | SpreadElement | undefined): void => {
      if (!source || source.type !== "Literal") {
        return;
      }
      const specifier = source.value;
      if (typeof specifier !== "string" || !isHostPackage(specifier)) {
        return;
      }
      context.report({
        node: source,
        messageId: "noHostPackageDynamicImport",
        data: { specifier },
      });
    };

    return {
      ImportExpression(node) {
        check(node.source);
      },
      // Older parsers model `import(x)` as a call on an `Import` callee.
      CallExpression(node) {
        if ((node.callee as { type: string }).type === "Import") {
          check(node.arguments[0]);
        }
      },
    };
  },
};

export default rule;

/**
 * Defines schema, validation, and defaults for `harness.opencode`.
 *
 * Subagents exclude specific OpenCode root configuration keys by default.
 * `configInclude` re-includes one of those roots whole: each entry must name an
 * excluded root. Keys outside the excluded set are copied unconditionally, so
 * naming one in `configInclude` is rejected as redundant.
 *
 * File reading, filtering, and staging live in user-config.ts.
 */

import type { HarnessConfigCodec } from "../../harness.js";

/**
 * The roots a staged config never copies unless `configInclude` names one.
 *
 * `mcp` is deliberately absent: a subagent that lost the parent's MCP servers
 * would lose tools the parent's workflow depends on, so they are always copied.
 */
export const EXCLUDED_OPENCODE_CONFIG_ROOTS = [
  "agent",
  "agents",
  "autoupdate",
  "experimental",
  "instructions",
  "mode",
  "permission",
  "permissions",
  "plugin",
  "plugins",
  "policies",
  "reference",
  "references",
  "skills",
  "tools",
  "update",
] as const;

const EXCLUDED_ROOTS: ReadonlySet<string> = new Set(
  EXCLUDED_OPENCODE_CONFIG_ROOTS,
);

/** A key `configInclude` may name: one of the roots the staging excludes. */
export type OpencodeConfigRoot =
  (typeof EXCLUDED_OPENCODE_CONFIG_ROOTS)[number];

/** The wording a rejected `configInclude` entry is reported with. */
export const CONFIG_INCLUDE_EXPECTED = `one of: ${EXCLUDED_OPENCODE_CONFIG_ROOTS.join(", ")}`;

/** True when a value names a root the staged config excludes by default. */
export function isOpencodeConfigIncludeRoot(
  value: string,
): value is OpencodeConfigRoot {
  return EXCLUDED_ROOTS.has(value);
}

/** The typed slice OpenCode reads from `harness.opencode`. */
export interface OpencodeConfig {
  readonly configInclude: readonly OpencodeConfigRoot[];
}

/**
 * OpenCode's own config validation. It owns the field names and the valid
 * `configInclude` roots; the registry carries the raw slice and formats the
 * issues this reports.
 *
 * Hand-rolled rather than a zod schema: a bad `configInclude` entry is dropped on
 * its own rather than failing the list, the contract is plain data because a
 * plugin package shares no zod instance with pi-cowboy, and an entry reports
 * with the config layer's own warning wording.
 */
export const opencodeConfigCodec: HarnessConfigCodec<OpencodeConfig> = {
  scope: "global",
  parse({ global }, report) {
    const configInclude: OpencodeConfigRoot[] = [];
    if (global === undefined) return { configInclude };

    const raw = global.configInclude;
    if (raw === undefined) return { configInclude };
    if (!Array.isArray(raw)) {
      report({
        layer: "global",
        keyPath: "configInclude",
        got: raw,
        expected: "array of root keys",
      });
      return { configInclude };
    }

    for (const [index, entry] of raw.entries()) {
      if (typeof entry !== "string" || !isOpencodeConfigIncludeRoot(entry)) {
        report({
          layer: "global",
          keyPath: `configInclude[${index}]`,
          got: entry,
          expected: CONFIG_INCLUDE_EXPECTED,
        });
        continue;
      }
      if (!configInclude.includes(entry)) configInclude.push(entry);
    }
    return { configInclude };
  },
};

/**
 * env-overrides.ts — the one rule an env entry must pass, and the type a table
 * of entries that passed it has.
 *
 * The rule is the same at every layer; the scope is not. A layer reading raw
 * text knows the universal names and, where a template names its family, that
 * family's. A launch knows the family the spawn resolved to, plus the names a
 * plugin harness reserves. Reporting differs too — a config entry is dropped
 * with a warning, a template entry refuses the template — so the rule answers
 * why, and each layer words it in its own report.
 *
 * `EnvOverrides` is what keeps those layers from re-checking one another: only
 * this module builds one, so a function that accepts one is stating that its
 * entries are already carriable.
 */

import {
  hasControlCharacter,
  isEnvVarName,
  isReservedEnvVar,
} from "../harness.js";

declare const envOverridesBrand: unique symbol;

/**
 * A name → value table whose every entry can be carried. The brand is the
 * invariant: a layer handed one never asks again whether a name is legal or a
 * value splittable.
 */
export type EnvOverrides = Readonly<Record<string, string>> & {
  readonly [envOverridesBrand]: true;
};

/** Why one entry cannot be carried, in the names the rules go by. */
export type EnvProblem = "name" | "reserved" | "not-string" | "control";

/**
 * The rule. `reserved` is what the caller knows beyond the universal set: a
 * template's own family table, or nothing at all.
 */
function envProblem(
  name: string,
  value: unknown,
  reserved: readonly string[],
): EnvProblem | null {
  if (!isEnvVarName(name)) return "name";
  if (isReservedEnvVar(name, reserved)) return "reserved";
  if (typeof value !== "string") return "not-string";
  return hasControlCharacter(value) ? "control" : null;
}

/**
 * Walk one raw table, dropping each entry the rule refuses and reporting it.
 * The report is where a layer says what a refusal costs: a warning and a spawn
 * without the variable, or the file that carried it.
 */
export function sanitizeEnv(
  raw: Readonly<Record<string, unknown>>,
  policy: {
    readonly reserved: readonly string[];
    readonly report: (
      name: string,
      problem: EnvProblem,
      value: unknown,
    ) => void;
  },
): EnvOverrides {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    const problem = envProblem(name, value, policy.reserved);
    if (problem !== null) {
      policy.report(name, problem, value);
      continue;
    }
    // `envProblem` answers null only for a string.
    kept[name] = value as string;
  }
  return kept as EnvOverrides;
}

/**
 * Two valid tables make a valid table. `over` wins per variable, so a later
 * layer can replace what an earlier one set without restating the rest.
 */
export function mergeEnv(
  base: EnvOverrides | undefined,
  over: EnvOverrides | undefined,
): EnvOverrides | undefined {
  if (base === undefined) return over;
  if (over === undefined) return base;
  return { ...base, ...over } as EnvOverrides;
}

/**
 * Entries already known good — a literal in a test, or a valid table a caller
 * filtered. A name that cannot be carried here is a bug in the caller, not
 * input to refuse, so it fails loudly rather than being dropped.
 */
export function trustedEnv(
  entries: Readonly<Record<string, string>>,
): EnvOverrides {
  for (const [name, value] of Object.entries(entries)) {
    const problem = envProblem(name, value, []);
    if (problem !== null) {
      throw new Error(`Invalid environment variable ${name}: ${problem}`);
    }
  }
  return entries as EnvOverrides;
}

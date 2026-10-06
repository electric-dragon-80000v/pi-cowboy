/**
 * config-validation.ts — load-time validation for config files.
 * Invalid values are dropped so built-in defaults apply; file bytes are
 * untouched and each drop warns once with file, key, got, and expected.
 */
import { Type, type TSchema } from "typebox";
import { Check } from "typebox/value";
import { HARNESS_IDS } from "../agents/harness.js";
import { isRecord } from "../predicates.js";
import type { RawConfig } from "./config-io.js";

interface KeySpec {
  schema: TSchema;
  expected: string;
}

const MODEL_KEY: KeySpec = {
  schema: Type.Union([Type.String(), Type.Null()]),
  expected: "string or null",
};
const BOOL: KeySpec = { schema: Type.Boolean(), expected: "boolean" };
const NUM: KeySpec = { schema: Type.Number(), expected: "number" };
const SYSTEM_PROMPT_MODE: KeySpec = {
  schema: Type.Union([
    Type.Literal("replace"),
    Type.Literal("inherit"),
    Type.Literal("custom"),
  ]),
  expected: '"replace" | "inherit" | "custom"',
};
const THINKING: KeySpec = {
  schema: Type.Union([
    Type.Literal("off"),
    Type.Literal("minimal"),
    Type.Literal("low"),
    Type.Literal("medium"),
    Type.Literal("high"),
    Type.Literal("xhigh"),
    Type.Literal("max"),
  ]),
  expected: '"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"',
};
const WORKTREE_MATERIALIZATION: KeySpec = {
  schema: Type.Union([Type.Literal("copy-on-write"), Type.Literal("checkout")]),
  expected: '"copy-on-write" | "checkout"',
};
const WORKTREE_CHECKOUT_TYPE: KeySpec = {
  schema: Type.Union([Type.Literal("dirty"), Type.Literal("clean")]),
  expected: '"dirty" | "clean"',
};
const WORKTREE_ROOT: KeySpec = {
  schema: Type.String(),
  expected: "string",
};
/** Built from the harness vocabulary, so a newly added harness is configurable without touching this file. */
const HARNESS: KeySpec = {
  schema: Type.Union(HARNESS_IDS.map((id) => Type.Literal(id))),
  expected: HARNESS_IDS.map((id) => `"${id}"`).join(" | "),
};
/** Empty strings are dropped so read-time fallback applies. */
const NON_EMPTY_STRING: KeySpec = {
  schema: Type.String({ minLength: 1 }),
  expected: "non-empty string",
};

/** An agent key outside the table is a per-type model key. */
const AGENT_KEY_SPECS: Record<string, KeySpec> = {
  default: MODEL_KEY,
  defaultAgentType: NON_EMPTY_STRING,
  defaultOrchestrator: NON_EMPTY_STRING,
  systemPromptMode: SYSTEM_PROMPT_MODE,
  includeContextFiles: BOOL,
  defaultThinking: THINKING,
  loadSkillsImplicitly: BOOL,
  loadExtensionsImplicitly: BOOL,
  disableDefaultAgents: BOOL,
  extensionEnabled: BOOL,
  showActiveIndicator: BOOL,
  grazingEnabled: BOOL,
  worktreeRoot: WORKTREE_ROOT,
  worktreeMaterialization: WORKTREE_MATERIALIZATION,
  worktreeCheckoutType: WORKTREE_CHECKOUT_TYPE,
  harnessType: HARNESS,
};

function describeValue(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  if (typeof value === "object") return "object";
  return typeof value;
}

function formatIncompatibleWarning(
  filePath: string,
  keyPath: string,
  value: unknown,
  expected: string,
): string {
  return (
    `[subagents] Incompatible value in ${filePath}: "${keyPath}" is ${describeValue(value)}, ` +
    `expected ${expected}. Set it again in the /cowboy menu, or edit or delete the file to fix it.`
  );
}

function warnIncompatible(
  filePath: string,
  keyPath: string,
  value: unknown,
  expected: string,
): void {
  console.warn(formatIncompatibleWarning(filePath, keyPath, value, expected));
}

const EXPECTED_OBJECT = "object";

/** Never throws: a missed check reads as invalid so the load survives it. */
function isValidValue(spec: KeySpec, value: unknown): boolean {
  try {
    return Check(spec.schema, value);
  } catch {
    return false;
  }
}

/** Validate one file layer, dropping invalid values. Never throws: bad input reads as empty. */
export function validateRawLayer(raw: unknown, filePath: string): RawConfig {
  const cleaned: RawConfig = {};
  if (!isRecord(raw)) {
    warnIncompatible(filePath, "(config)", raw, EXPECTED_OBJECT);
    return cleaned;
  }

  if (raw.agent !== undefined) {
    if (!isRecord(raw.agent)) {
      warnIncompatible(filePath, "agent", raw.agent, EXPECTED_OBJECT);
    } else {
      const agent = cleanAgentEntries(raw.agent, filePath);
      if (Object.keys(agent).length > 0) cleaned.agent = agent;
    }
  }

  if (raw.concurrency !== undefined) {
    const concurrency = cleanConcurrencySection(raw.concurrency, filePath);
    if (Object.keys(concurrency).length > 0) cleaned.concurrency = concurrency;
  }

  return cleaned;
}

/** An agent key outside the table is a per-type model key. */
function cleanAgentEntries(
  agent: Record<string, unknown>,
  filePath: string,
): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(agent)) {
    if (value === undefined) continue;
    const spec = AGENT_KEY_SPECS[key] ?? MODEL_KEY;
    if (isValidValue(spec, value)) kept[key] = value;
    else warnIncompatible(filePath, `agent.${key}`, value, spec.expected);
  }
  return kept;
}

/** Plain typeof checks: every value here is a bare number. */
function cleanConcurrencySection(
  concurrency: unknown,
  filePath: string,
): NonNullable<RawConfig["concurrency"]> {
  const kept: NonNullable<RawConfig["concurrency"]> = {};
  if (!isRecord(concurrency)) {
    warnIncompatible(filePath, "concurrency", concurrency, EXPECTED_OBJECT);
    return kept;
  }
  if (concurrency.default !== undefined) {
    if (typeof concurrency.default === "number")
      kept.default = concurrency.default;
    else
      warnIncompatible(
        filePath,
        "concurrency.default",
        concurrency.default,
        NUM.expected,
      );
  }
  for (const section of ["providers", "models"] as const) {
    const entries = concurrency[section];
    if (entries === undefined) continue;
    if (!isRecord(entries)) {
      warnIncompatible(
        filePath,
        `concurrency.${section}`,
        entries,
        EXPECTED_OBJECT,
      );
      continue;
    }
    const keptEntries: Record<string, number> = {};
    for (const [key, value] of Object.entries(entries)) {
      if (typeof value === "number") keptEntries[key] = value;
      else
        warnIncompatible(
          filePath,
          `concurrency.${section}.${key}`,
          value,
          NUM.expected,
        );
    }
    if (Object.keys(keptEntries).length > 0) kept[section] = keptEntries;
  }
  return kept;
}

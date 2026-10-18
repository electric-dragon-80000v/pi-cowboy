/**
 * config-validation.ts — load-time validation for config files.
 * Invalid values are dropped so built-in defaults apply; file bytes are
 * untouched and each drop warns once with file, key, got, and expected.
 * Values are kept as written: nothing here trims or rewrites one. The schemas
 * are Zod, and the layer they return is typed from the config shape, so no
 * reader below this boundary handles `unknown`.
 */
import { z } from "zod";
import { HARNESS_IDS, type AnyHarnessId } from "../agents/harness.js";
import type { SubagentsConfig } from "../models/model-precedence.js";
import { isRecord } from "../predicates.js";
import { parsePoolKey } from "../concurrency-pools.js";
import { DEFAULT_MODEL_BY_HARNESS_KEY } from "./types.js";
import type { RawConfig } from "./config-io.js";
import {
  CONCURRENCY_LIMIT_EXPECTED,
  isConcurrencyLimit,
} from "./concurrency-limit.js";

/** One agent key's schema, and the wording a warning names its expected shape with. */
interface KeySpec {
  schema: z.ZodType<string | boolean | null>;
  expected: string;
}

const MODEL_KEY: KeySpec = {
  schema: z.union([z.string(), z.null()]),
  expected: "string or null",
};
const BOOL: KeySpec = { schema: z.boolean(), expected: "boolean" };
const SYSTEM_PROMPT_MODE: KeySpec = {
  schema: z.enum(["replace", "inherit", "custom"]),
  expected: '"replace" | "inherit" | "custom"',
};
const THINKING: KeySpec = {
  schema: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
  expected: '"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"',
};
const WORKTREE_MATERIALIZATION: KeySpec = {
  schema: z.enum(["copy-on-write", "checkout"]),
  expected: '"copy-on-write" | "checkout"',
};
const WORKTREE_CHECKOUT_TYPE: KeySpec = {
  schema: z.enum(["dirty", "clean"]),
  expected: '"dirty" | "clean"',
};
/** A non-empty string with a non-space character; ids and paths are read exactly as written. */
const NON_BLANK_STRING = z
  .string()
  .min(1)
  .refine((value) => /\S/.test(value));
/** The same rule where an agent key table names its expected shape. */
const NON_BLANK: KeySpec = {
  schema: NON_BLANK_STRING,
  expected: "non-empty string",
};
/** Built from the harness vocabulary, so a newly added harness is configurable without touching this file. */
const HARNESS_EXPECTED = HARNESS_IDS.map((id) => `"${id}"`).join(" | ");
/**
 * The per-harness default models. Validated per entry rather than as one value:
 * a key that is not a non-empty harness id is dropped with a warning while every
 * other entry survives, the way a concurrency map is cleaned. The vocabulary is
 * open — a plugin harness's own id is as valid a key as a built-in's — so the
 * check is "a non-empty string", not membership in `HARNESS_IDS`.
 */
const HARNESS_DEFAULT_MODELS_EXPECTED = `an object keyed by a harness id (${HARNESS_EXPECTED} or a plugin's), with string or null values`;

/** An agent key outside the table is a per-type model key. */
const AGENT_KEY_SPECS: Record<string, KeySpec> = {
  default: MODEL_KEY,
  defaultAgentType: NON_BLANK,
  defaultOrchestrator: NON_BLANK,
  systemPromptMode: SYSTEM_PROMPT_MODE,
  includeContextFiles: BOOL,
  defaultThinking: THINKING,
  loadSkillsImplicitly: BOOL,
  loadExtensionsImplicitly: BOOL,
  disableDefaultAgents: BOOL,
  extensionEnabled: BOOL,
  showActiveIndicator: BOOL,
  grazingEnabled: BOOL,
  worktreeRoot: NON_BLANK,
  worktreeMaterialization: WORKTREE_MATERIALIZATION,
  worktreeCheckoutType: WORKTREE_CHECKOUT_TYPE,
  // The harness setting takes any harness id — a built-in's or a plugin's — and
  // so does `harness_type`, on a template and in a tool call. Config cannot
  // check registration (it loads before any plugin does), so the value is shape
  // only here; the session's registry is what decides an id exists.
  harnessType: NON_BLANK,
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

  // Machine-level, so it sits at the top of the file rather than under `agent`.
  if (raw.multiplexer !== undefined) {
    const parsed = NON_BLANK_STRING.safeParse(raw.multiplexer);
    if (parsed.success) {
      cleaned.multiplexer = parsed.data;
    } else {
      warnIncompatible(
        filePath,
        "multiplexer",
        raw.multiplexer,
        NON_BLANK.expected,
      );
    }
  }

  return cleaned;
}

/** An agent key outside the table is a per-type model key. */
function cleanAgentEntries(
  agent: Record<string, unknown>,
  filePath: string,
): Partial<SubagentsConfig["agent"]> {
  const kept: Partial<SubagentsConfig["agent"]> = {};
  for (const [key, value] of Object.entries(agent)) {
    if (value === undefined) continue;
    if (key === DEFAULT_MODEL_BY_HARNESS_KEY) {
      const entries = cleanHarnessDefaultModels(value, filePath);
      if (entries !== undefined) kept[key] = entries;
      continue;
    }
    const spec = AGENT_KEY_SPECS[key] ?? MODEL_KEY;
    const parsed = spec.schema.safeParse(value);
    if (parsed.success) kept[key] = parsed.data;
    else warnIncompatible(filePath, `agent.${key}`, value, spec.expected);
  }
  return kept;
}

/**
 * Per-entry validation of the harness map: a key that is not a non-empty harness
 * id, or a value that is not a model key, warns and is dropped. An empty result
 * reads as absent so the built-in default applies. Never throws.
 */
function cleanHarnessDefaultModels(
  value: unknown,
  filePath: string,
): Record<string, string | null> | undefined {
  const keyPath = `agent.${DEFAULT_MODEL_BY_HARNESS_KEY}`;
  if (!isRecord(value)) {
    warnIncompatible(filePath, keyPath, value, HARNESS_DEFAULT_MODELS_EXPECTED);
    return undefined;
  }
  const kept: Record<string, string | null> = {};
  for (const [harness, model] of Object.entries(value)) {
    if (model === undefined) continue;
    if (!/\S/.test(harness)) {
      warnIncompatible(
        filePath,
        `${keyPath}.${harness}`,
        harness,
        "non-empty harness id",
      );
      continue;
    }
    if (typeof model === "string" || model === null) kept[harness] = model;
    else
      warnIncompatible(
        filePath,
        `${keyPath}.${harness}`,
        model,
        MODEL_KEY.expected,
      );
  }
  return Object.keys(kept).length > 0 ? kept : undefined;
}

/** Zod-checked: a concurrency limit is a positive integer. */
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
    if (isConcurrencyLimit(concurrency.default))
      kept.default = concurrency.default;
    else
      warnIncompatible(
        filePath,
        "concurrency.default",
        concurrency.default,
        CONCURRENCY_LIMIT_EXPECTED,
      );
  }

  const harnesses = concurrency.harnesses;
  if (harnesses !== undefined) {
    if (!isRecord(harnesses)) {
      warnIncompatible(
        filePath,
        "concurrency.harnesses",
        harnesses,
        EXPECTED_OBJECT,
      );
    } else {
      const keptHarnesses: Partial<Record<AnyHarnessId, number>> = {};
      for (const [key, value] of Object.entries(harnesses)) {
        if (!/\S/.test(key)) {
          warnIncompatible(
            filePath,
            `concurrency.harnesses.${key}`,
            key,
            "non-empty harness id",
          );
          continue;
        }
        if (isConcurrencyLimit(value)) keptHarnesses[key] = value;
        else
          warnIncompatible(
            filePath,
            `concurrency.harnesses.${key}`,
            value,
            CONCURRENCY_LIMIT_EXPECTED,
          );
      }
      if (Object.keys(keptHarnesses).length > 0) kept.harnesses = keptHarnesses;
    }
  }

  const sections = {
    providers: {
      // A provider pool key is "<harness>:<provider>"; a bare key means pi.
      level: "provider",
      expected: 'a provider key "provider" or "<harness>:<provider>"',
    },
    models: {
      // A model pool key is "<harness>:<provider>/<model>"; a bare key means pi.
      level: "model",
      expected:
        'a model key "provider/model" or "<harness>:<provider>/<model>"',
    },
  } as const;
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
    const { level, expected } = sections[section];
    const keptEntries: Record<string, number> = {};
    for (const [key, value] of Object.entries(entries)) {
      // A malformed key drops only its own entry: the rest of the map survives.
      if (parsePoolKey(key)?.kind !== level) {
        warnIncompatible(
          filePath,
          `concurrency.${section}.${key}`,
          key,
          expected,
        );
        continue;
      }
      if (isConcurrencyLimit(value)) keptEntries[key] = value;
      else
        warnIncompatible(
          filePath,
          `concurrency.${section}.${key}`,
          value,
          CONCURRENCY_LIMIT_EXPECTED,
        );
    }
    if (Object.keys(keptEntries).length > 0) kept[section] = keptEntries;
  }
  return kept;
}

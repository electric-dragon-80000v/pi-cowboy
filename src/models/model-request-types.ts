/**
 * model-request-types.ts — the vocabulary every model resolver speaks.
 *
 * Provenance is structural: the caller's OPTIONAL `model` param and the
 * `tool_call` listener's `_configuredModel` channel are separate keys with one
 * writer each, so a caller's model can never be mistaken for the injected
 * value (which would silently run a different model).
 *
 * `ResolvedModel` is the one answer shape: a `resolved` member carries the
 * catalog entry the launch is named by, a `foreign` member carries the key
 * alone — a key from another harness's list has no `Model` in this session to
 * carry — a `level` member carries the thinking level a spawn asked for when
 * it names no model, and `none` means the spawn names neither.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { AnyHarnessId } from "../agents/harness.js";
import type { ModelChoice } from "../types.js";

/** The args key the `tool_call` listener injects the configured default under. */
export const CONFIGURED_MODEL_KEY = "_configuredModel";

/**
 * The args key the `tool_call` listener injects the configured thinking level
 * under. Separate from the caller's own `thinking` for the same reason the
 * model's is: a value this extension chose must never be mistaken for one the
 * caller wrote.
 */
export const CONFIGURED_THINKING_KEY = "_configuredThinking";

/** Where a spawn's model came from. */
export type ModelRequest =
  { source: "call"; key: string } | { source: "configured"; key: string };

/** Absent/null/empty/whitespace read as unset. */
export function readModelKey(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

/**
 * The level the caller asked for, or the one the listener injected when the
 * caller named none. The caller's own value always wins: the injected one is a
 * configured default, and a default never overrides an explicit request.
 */
export function readThinkingRequest(
  params: Record<string, unknown>,
): string | undefined {
  return (
    readModelKey(params.thinking) ??
    readModelKey(params[CONFIGURED_THINKING_KEY])
  );
}

/** The caller's own request, or undefined. Read through here, never re-derived from args after the listener ran. */
export function readModelRequest(
  params: Record<string, unknown>,
): ModelRequest | undefined {
  const called = readModelKey(params.model);
  if (called) return { source: "call", key: called };
  const configured = readModelKey(params[CONFIGURED_MODEL_KEY]);
  if (configured) return { source: "configured", key: configured };
  return undefined;
}

/**
 * The model a spawn will run and the thinking level it runs at, or `none` when
 * it names neither. The pi member is the catalog entry the launch is named by;
 * a foreign member is the key alone, because a key from another harness's list
 * has no `Model` in this session to carry.
 *
 * `thinking` is the level the layers asked for, carried as written, or null
 * when no level was asked for. A token belongs to the harness that runs it, so
 * nothing here rewrites it; a harness with a closed vocabulary warns about a
 * token outside it at the point it reads its own list.
 */
export type ResolvedModel =
  | {
      kind: "resolved";
      model: Model<Api>;
      modelKey: string;
      thinking: string | null;
    }
  | {
      kind: "foreign";
      harness: AnyHarnessId;
      modelKey: string;
      /** The display form: the harness list's label for the key, or the key itself. */
      modelName: string;
      thinking: string | null;
    }
  | {
      kind: "level";
      /**
       * The level alone. No layer named a model, so the launch runs the
       * harness's own default model at this level — the level is not a
       * property of a model this resolution failed to find.
       */
      thinking: string;
    }
  | { kind: "none" };

/**
 * The answer for a spawn that names no model: the level alone when one was
 * asked for, nothing at all otherwise. Both families answer this way, because
 * a level is carried as written whether or not a model was resolved with it.
 */
export function withoutModel(
  thinking: string | undefined,
): SpawnModelResolution {
  return {
    resolved:
      thinking === undefined ? { kind: "none" } : { kind: "level", thinking },
    notices: [],
  };
}

/**
 * What a resolution answers: the model the launch will run, and the advisory
 * lines about it that only the caller can show — resolution holds no UI.
 */
export interface SpawnModelResolution {
  readonly resolved: ResolvedModel;
  readonly notices: readonly string[];
}

/** The spawn's model choice — the model and the level it runs at — in the shape every later layer carries, or undefined when the spawn names neither a model nor a level of its own. */
export function modelChoiceFor(
  resolved: ResolvedModel,
): ModelChoice | undefined {
  switch (resolved.kind) {
    case "resolved":
      return {
        model: resolved.model,
        key: resolved.modelKey,
        thinking: resolved.thinking,
      };
    case "foreign":
      return {
        harness: resolved.harness,
        key: resolved.modelKey,
        name: resolved.modelName,
        thinking: resolved.thinking,
      };
    case "level":
      return { levelOnly: true, thinking: resolved.thinking };
    case "none":
      return undefined;
  }
}

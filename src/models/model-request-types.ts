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
 * carry — and `none` means the spawn inherits nothing.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ForeignHarnessId } from "../agents/harness.js";
import type { ModelSelection } from "../types.js";

/** The args key the `tool_call` listener injects the configured default under. */
export const CONFIGURED_MODEL_KEY = "_configuredModel";

/** Where a spawn's model came from. */
export type ModelRequest =
  { source: "call"; key: string } | { source: "configured"; key: string };

/** Absent/null/empty/whitespace read as unset. */
export function readModelKey(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
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
 * The model a spawn will run, or `none` when it inherits nothing. The pi
 * member is the catalog entry the launch is named by; a foreign member is the
 * key alone, because a key from another harness's list has no `Model` in this
 * session to carry.
 */
export type ResolvedModel =
  | { kind: "resolved"; model: Model<Api>; modelKey: string }
  | {
      kind: "foreign";
      harness: ForeignHarnessId;
      modelKey: string;
      /** The display form: the harness list's label for the key, or the key itself. */
      modelName: string;
    }
  | { kind: "none" };

/** The spawn's model in the shape every later layer carries, or undefined when the spawn inherits nothing. */
export function modelSelectionFor(
  resolved: ResolvedModel,
): ModelSelection | undefined {
  switch (resolved.kind) {
    case "resolved":
      return { model: resolved.model, key: resolved.modelKey };
    case "foreign":
      return {
        harness: resolved.harness,
        key: resolved.modelKey,
        name: resolved.modelName,
      };
    case "none":
      return undefined;
  }
}

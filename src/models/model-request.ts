/**
 * model-request.ts — the cowboy_agent tool's model request and its resolution.
 * Provenance is structural: the caller's OPTIONAL `model` param and the
 * `tool_call` listener's `_configuredModel` channel are separate keys with one
 * writer each, so a caller's model can never be mistaken for the injected
 * value (which would silently run a different model).
 *
 * A model key names an entry in one harness's catalogue, so resolution is per
 * harness: the pi family resolves through this session's catalog plus a
 * credential probe, while any other harness carries the key as written — the
 * vocabulary is that harness's, and nothing here can answer for it.
 *
 * The pi family's probe exists because a catalog model with no credential
 * stalls: the child prints its auth error and never settles on its own.
 * Probing first turns that stall into a failed tool call. The probe reads
 * `getProviderAuthStatus(provider).configured` — the same gate the child's
 * session applies at turn start — and it is the only source: no fallback
 * paths. It is a proxy, not a guarantee: it reads this session's in-memory
 * credential status, so a present-but-unusable credential still passes.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import {
  isPiFamilyHarness,
  type ForeignHarnessId,
  type HarnessId,
  type ModelEntry,
} from "../agents/harness.js";
import { isRecord } from "../predicates.js";
import type { ModelSelection } from "../types.js";
import { errorMessage, findModelInRegistry } from "../utils.js";

/** The args key the `tool_call` listener injects the configured default under. */
export const CONFIGURED_MODEL_KEY = "_configuredModel";

/** Where a spawn's model came from. */
type ModelRequest =
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

/**
 * The models one harness can run, listed on demand. Read only for a foreign
 * harness, and never a gate: a list that could not be produced is no answer at
 * all, which is why the caller treats a rejection as an empty one.
 */
export type HarnessModelList = (
  harness: ForeignHarnessId,
) => Promise<readonly ModelEntry[]>;

/** Everything the harness-aware resolution reads. */
export interface SpawnModelDeps {
  /**
   * The harness the launch resolved: it decides whose model vocabulary
   * answers, and whether this session can answer for credentials at all.
   */
  harness: HarnessId;
  /** This session's pi catalog. Read only for a pi-family harness. */
  registry: ModelLookup;
  /** The parent session's model, inherited only by a pi-family launch. */
  parent: Model<Api> | undefined;
  /** The launching harness's own list, for a harness whose keys pi's catalog does not hold. */
  listModels: HarnessModelList;
  /** The user-facing channel the advisory warning goes out on. */
  notify: (message: string) => void;
}

/** Catalog lookup plus credential probe; satisfied by `ctx.modelRegistry`. */
export interface ModelLookup {
  find(provider: string, modelId: string): Model<Api> | undefined;
  /**
   * Typed `unknown` (external boundary): only `{ configured: boolean }` is
   * recognized; anything else is inconclusive, never a refusal.
   */
  getProviderAuthStatus(provider: string): unknown;
}

type CredentialVerdict =
  | { verdict: "usable" }
  | { verdict: "unusable"; reason: string }
  | { verdict: "inconclusive"; reason: string };

function modelKey(model: Model<Api>): string {
  return `${model.provider}/${model.id}`;
}

function resolvedModel(model: Model<Api>): ResolvedModel {
  return { kind: "resolved", model, modelKey: modelKey(model) };
}

/** Matches pi's own wording for a missing credential. */
function missingCredential(provider: string): string {
  return `No API key found for "${provider}"`;
}

/**
 * Only an explicit FALSE reads as `unusable`. A probe that throws or answers
 * an unrecognized shape is `inconclusive` — the probe could not complete, not
 * proof of no credential — and the caller treats it like `usable`.
 */
function probeCredentials(
  registry: ModelLookup,
  model: Model<Api>,
): CredentialVerdict {
  let status: unknown;
  try {
    status = registry.getProviderAuthStatus(model.provider);
  } catch (err) {
    return { verdict: "inconclusive", reason: errorMessage(err) };
  }
  if (!isRecord(status) || typeof status.configured !== "boolean") {
    return {
      verdict: "inconclusive",
      reason: "the registry reported no credential status for the provider",
    };
  }
  return status.configured
    ? { verdict: "usable" }
    : { verdict: "unusable", reason: missingCredential(model.provider) };
}

/** Every pre-spawn refusal states what failed and that nothing ran. */
function refusal(lead: string, reason: string): string {
  return `${lead}: ${reason}. Nothing was spawned.`;
}

/**
 * pi's own resolution, and the one a pi-family launch uses. Runs BEFORE
 * worktree resolution, so a refusal fails the call without spawning anything
 * or touching the in-flight attempt. Catalog rules: `call` is strict (unknown
 * key throws — silently running another model is worse); `configured` keeps
 * the soft fallback to the parent for a key gone from the catalog; no request
 * pins the parent's model. Credentials are never softened, whatever the
 * source: substituting another model would run one nobody asked for.
 * `{ kind: "none" }` means no model to hand the child.
 */
export function resolveModelRequest(
  request: ModelRequest | undefined,
  registry: ModelLookup,
  parent: Model<Api> | undefined,
): ResolvedModel {
  if (!request) {
    if (!parent) return { kind: "none" };
    const probe = probeCredentials(registry, parent);
    if (probe.verdict !== "unusable") return resolvedModel(parent);
    throw new Error(
      refusal(
        `The parent session's model "${modelKey(parent)}" did not resolve credentials in this session`,
        probe.reason,
      ),
    );
  }

  const found =
    request.source === "call"
      ? findModelInRegistry(request.key, registry, undefined)
      : findModelInRegistry(request.key, registry, parent);

  if (!found) {
    if (request.source === "call") {
      throw new Error(
        `Model "${request.key}" is not available in this session. Nothing was spawned.`,
      );
    }
    return { kind: "none" };
  }

  const probe = probeCredentials(registry, found);
  if (probe.verdict !== "unusable") return resolvedModel(found);

  if (request.source === "call") {
    throw new Error(
      refusal(
        `Model "${modelKey(found)}" cannot authenticate in this session`,
        probe.reason,
      ),
    );
  }

  throw new Error(
    refusal(
      `The subagent model "${modelKey(found)}" for this configured default cannot authenticate in this session`,
      probe.reason,
    ),
  );
}

/**
 * The launching harness's model list, read for its own sake only. A list that
 * cannot be produced is no answer at all — never a refusal — because the list
 * is advisory: a spawn must not fail over a listing command that misbehaved.
 */
async function harnessModels(
  deps: SpawnModelDeps,
  harness: ForeignHarnessId,
): Promise<readonly ModelEntry[]> {
  try {
    return await deps.listModels(harness);
  } catch {
    return [];
  }
}

/**
 * Resolve a spawn's model against the harness that will run it.
 *
 * The pi family resolves through this session's catalog and credential probe,
 * exactly as `resolveModelRequest` does. Any other harness carries the key as
 * written: the key is that harness's vocabulary, this session's pi catalog
 * cannot answer for it, and pi's credential probe cannot know another
 * harness's credential state — so neither is consulted. The harness's own list
 * is read only to warn about a key it does not know, never to refuse one: a
 * caller's explicit `model` and the user's configured default are both
 * honoured, not second-guessed.
 */
export async function resolveSpawnModel(
  request: ModelRequest | undefined,
  deps: SpawnModelDeps,
): Promise<ResolvedModel> {
  const { harness } = deps;
  if (isPiFamilyHarness(harness)) {
    return resolveModelRequest(request, deps.registry, deps.parent);
  }

  // A foreign launch inherits nothing. The parent's key is pi's; letting it
  // ride here would run a model on a harness whose catalog does not define it,
  // and nobody asked for that model on this launch.
  if (!request) return { kind: "none" };

  // No credential probe runs here: `getProviderAuthStatus` is pi's own
  // registry, and no answer it gives says anything about another harness's
  // credential state.
  const list = await harnessModels(deps, harness);
  const entry = list.find((candidate) => candidate.key === request.key);
  if (list.length > 0 && !entry) {
    deps.notify(
      `The ${harness} model list does not include "${request.key}"; launching with that key anyway.`,
    );
  }
  return {
    kind: "foreign",
    harness,
    modelKey: request.key,
    modelName: entry?.label ?? request.key,
  };
}

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

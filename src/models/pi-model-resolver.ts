/**
 * pi-model-resolver.ts — the pi family's model resolution: this session's
 * catalog, gated by a credential probe.
 *
 * The probe exists because a catalog model with no credential stalls: the
 * child prints its auth error and never settles on its own. Probing first
 * turns that stall into a failed tool call. The probe reads
 * `getProviderAuthStatus(provider).configured` — the same gate the child's
 * session applies at turn start — and it is the only source: no fallback
 * paths. It is a proxy, not a guarantee: it reads this session's in-memory
 * credential status, so a present-but-unusable credential still passes.
 *
 * Catalog rules: `call` is strict (unknown key throws — silently running
 * another model is worse); `configured` keeps the soft fallback to the parent
 * for a key gone from the catalog; no request pins the parent's model.
 * Credentials are never softened, whatever the source: substituting another
 * model would run one nobody asked for. A thinking level is held to the same
 * rule — pi's vocabulary is validated, and a token outside it is reported,
 * never rewritten.
 *
 * A report is a line in the answer's `notices`, not a call into a UI: only the
 * caller holds a context to show it on.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import { isRecord } from "../predicates.js";
import { ThinkingLevelSchema } from "../types.js";
import { errorMessage, findModelInRegistry } from "../utils.js";
import {
  withoutModel,
  type ModelRequest,
  type SpawnModelResolution,
} from "./model-request-types.js";

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

/**
 * pi's own vocabulary is closed, so a token it does not name is a level the
 * child either rejects or reads as its default. The token is still carried: it
 * is what the caller asked for, and a warning is the whole of what this layer
 * may say about it — no level here is replaced with a different one.
 */
function undeclaredLevelWarning(
  model: Model<Api>,
  thinking: string | undefined,
): string | undefined {
  if (thinking === undefined) return undefined;
  if (ThinkingLevelSchema.safeParse(thinking).success) return undefined;
  return `The thinking level "${thinking}" is not one pi knows (${ThinkingLevelSchema.options.join(", ")}); launching "${modelKey(model)}" with it anyway.`;
}

/** The catalog entry plus the level the layers asked for, carried as written. */
function resolvedModel(
  model: Model<Api>,
  thinking: string | undefined,
): SpawnModelResolution {
  const warning = undeclaredLevelWarning(model, thinking);
  return {
    resolved: {
      kind: "resolved",
      model,
      modelKey: modelKey(model),
      thinking: thinking ?? null,
    },
    notices: warning === undefined ? [] : [warning],
  };
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

/** Everything the pi resolution reads. */
export interface PiModelResolverDeps {
  /** This session's catalog plus the credential probe. */
  registry: ModelLookup;
  /** The parent session's model, pinned when the request names none. */
  parent: Model<Api> | undefined;
  /** The level the layers asked for; undefined means none was asked for. */
  thinking: string | undefined;
}

/**
 * Resolve a request against this session's pi catalog. An answer with no model
 * to hand the child is `none`; a key this session cannot run or authenticate
 * throws.
 */
export function resolvePiModel(
  request: ModelRequest | undefined,
  deps: PiModelResolverDeps,
): SpawnModelResolution {
  const { registry, parent, thinking } = deps;
  if (!request) {
    if (!parent) return withoutModel(thinking);
    const probe = probeCredentials(registry, parent);
    if (probe.verdict !== "unusable") return resolvedModel(parent, thinking);
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
    return withoutModel(thinking);
  }

  const probe = probeCredentials(registry, found);
  if (probe.verdict !== "unusable") return resolvedModel(found, thinking);

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

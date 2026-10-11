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
 * model would run one nobody asked for.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import { isRecord } from "../predicates.js";
import { errorMessage, findModelInRegistry } from "../utils.js";
import type { ModelRequest, ResolvedModel } from "./model-request-types.js";

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
 * Resolve a request against this session's pi catalog. `{ kind: "none" }`
 * means no model to hand the child; a key this session cannot run or
 * authenticate throws.
 */
export function resolvePiModel(
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

/**
 * model-request.ts — the coordinator that routes a spawn's model request to
 * the family that can answer for it, and the module every caller imports.
 *
 * A model key names an entry in one harness's catalogue, so resolution is per
 * harness: the pi family resolves through this session's catalog plus a
 * credential probe (`pi-model-resolver.ts`), while any other harness carries
 * the key as written (`foreign-model-resolver.ts`) — the vocabulary is that
 * harness's, and nothing here can answer for it.
 *
 * This is the only place that knows both families exist. Resolution runs
 * BEFORE worktree resolution, so a refusal fails the call without spawning
 * anything or touching the in-flight attempt.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import { isPiFamilyHarness, type HarnessId } from "../agents/harness.js";
import { resolvePiModel, type ModelLookup } from "./pi-model-resolver.js";
import {
  resolveForeignModel,
  type ForeignModelResolverDeps,
  type HarnessModelList,
} from "./foreign-model-resolver.js";
import type { ModelRequest, ResolvedModel } from "./model-request-types.js";

export * from "./model-request-types.js";
export { resolvePiModel, type ModelLookup } from "./pi-model-resolver.js";
export { type HarnessModelList } from "./foreign-model-resolver.js";

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

/**
 * Resolve a spawn's model against the harness that will run it. The pi family
 * resolves through this session's catalog and credential probe, exactly as
 * `resolvePiModel` does. Any other harness carries the key as written: the key
 * is that harness's vocabulary, this session's pi catalog cannot answer for
 * it, and pi's credential probe cannot know another harness's credential
 * state — so neither is consulted.
 */
export async function resolveSpawnModel(
  request: ModelRequest | undefined,
  deps: SpawnModelDeps,
): Promise<ResolvedModel> {
  const { harness } = deps;
  if (isPiFamilyHarness(harness)) {
    return resolvePiModel(request, deps.registry, deps.parent);
  }

  const foreign: ForeignModelResolverDeps = {
    harness,
    listModels: deps.listModels,
    notify: deps.notify,
  };
  return resolveForeignModel(request, foreign);
}

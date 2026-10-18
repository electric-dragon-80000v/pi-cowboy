/**
 * foreign-model-resolver.ts — a foreign harness's model resolution: the key
 * as written, with the harness's own list read for its advice alone.
 *
 * A foreign launch inherits nothing: the parent's key is pi's, and letting it
 * ride would run a model on a harness whose catalog does not define it. No
 * credential probe runs either — `getProviderAuthStatus` is pi's own registry,
 * and no answer it gives says anything about another harness's credential
 * state.
 *
 * The list is advisory: a spawn must not fail over a listing command that
 * misbehaved, so a list that could not be produced is an empty one, and a key
 * the list does not know is warned about and carried anyway. A caller's
 * explicit `model` and the user's configured default are both honoured, not
 * second-guessed.
 */

import type { AnyHarnessId, ModelEntry } from "../agents/harness.js";
import type { ModelRequest, ResolvedModel } from "./model-request-types.js";

/**
 * The models one harness can run, listed on demand. Read only for a foreign
 * harness, and never a gate: a list that could not be produced is no answer at
 * all, which is why the caller treats a rejection as an empty one.
 */
export type HarnessModelList = (
  harness: AnyHarnessId,
) => Promise<readonly ModelEntry[]>;

/** Everything the foreign resolution reads. */
export interface ForeignModelResolverDeps {
  /** The harness the launch resolved: its vocabulary answers, not pi's. */
  harness: AnyHarnessId;
  /** The launching harness's own list, whose keys this session cannot vouch for. */
  listModels: HarnessModelList;
  /** The user-facing channel the advisory warning goes out on. */
  notify: (message: string) => void;
}

/**
 * The launching harness's model list, read for its own sake only. A list that
 * cannot be produced is no answer at all — never a refusal — because the list
 * is advisory: a spawn must not fail over a listing command that misbehaved.
 */
async function harnessModels(
  deps: ForeignModelResolverDeps,
): Promise<readonly ModelEntry[]> {
  try {
    return await deps.listModels(deps.harness);
  } catch {
    return [];
  }
}

/**
 * Resolve a request against the harness that will run it. The key is that
 * harness's vocabulary, so it is carried as written: pi's catalog cannot answer
 * for it and pi's probe cannot know its credential state.
 */
export async function resolveForeignModel(
  request: ModelRequest | undefined,
  deps: ForeignModelResolverDeps,
): Promise<ResolvedModel> {
  // A foreign launch inherits nothing. The parent's key is pi's; letting it
  // ride here would run a model on a harness whose catalog does not define it,
  // and nobody asked for that model on this launch.
  if (!request) return { kind: "none" };

  // No credential probe runs here: `getProviderAuthStatus` is pi's own
  // registry, and no answer it gives says anything about another harness's
  // credential state.
  const list = await harnessModels(deps);
  const entry = list.find((candidate) => candidate.key === request.key);
  if (list.length > 0 && !entry) {
    deps.notify(
      `The ${deps.harness} model list does not include "${request.key}"; launching with that key anyway.`,
    );
  }
  return {
    kind: "foreign",
    harness: deps.harness,
    modelKey: request.key,
    modelName: entry?.label ?? request.key,
  };
}

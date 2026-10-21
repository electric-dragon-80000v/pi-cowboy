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
 *
 * The thinking level is carried exactly as the layers named it. A harness whose
 * level list is closed may say that the token is not one it knows, and the
 * warning is the whole of its objection: the level is carried, never replaced.
 * What it says lands in the answer's `notices`, for the caller that holds a UI.
 */

import type { AnyHarnessId, ModelEntry } from "../agents/harness.js";
import {
  withoutModel,
  type ModelRequest,
  type SpawnModelResolution,
} from "./model-request-types.js";

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
  /**
   * The level the layers asked for, in this harness's vocabulary. The entry's
   * own levels are read only to warn about a token they do not name.
   */
  thinking: string | undefined;
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
 * The warning for a level the model's closed list does not name, or undefined
 * when there is nothing to say. Only a closed list can say a token is wrong:
 * an advisory list is what the harness advertises, not the whole of what it
 * accepts, so a level outside it is not a mistake.
 */
function undeclaredLevelWarning(
  harness: AnyHarnessId,
  entry: ModelEntry | undefined,
  level: string,
): string | undefined {
  if (entry === undefined) return undefined;
  if (entry.thinkingLevels.kind !== "closed") return undefined;
  const { levels } = entry.thinkingLevels;
  if (levels.includes(level)) return undefined;
  return levels.length === 0
    ? `Model "${entry.key}" (${harness}) does not support thinking levels; launching with "${level}".`
    : `Thinking level "${level}" is not declared by ${harness} model "${entry.key}" (supported: ${levels.join(", ")}); proceeding with "${level}".`;
}

/**
 * Resolve a request against the harness that will run it. The key is that
 * harness's vocabulary, so it is carried as written: pi's catalog cannot answer
 * for it and pi's probe cannot know its credential state.
 */
export async function resolveForeignModel(
  request: ModelRequest | undefined,
  deps: ForeignModelResolverDeps,
): Promise<SpawnModelResolution> {
  // A foreign launch inherits nothing. The parent's key is pi's; letting it
  // ride here would run a model on a harness whose catalog does not define it,
  // and nobody asked for that model on this launch. The level is the spawn's
  // own and rides without a model: the harness's default model runs at it.
  if (!request) return withoutModel(deps.thinking);

  // No credential probe runs here: `getProviderAuthStatus` is pi's own
  // registry, and no answer it gives says anything about another harness's
  // credential state.
  const list = await harnessModels(deps);
  const entry = list.find((candidate) => candidate.key === request.key);
  const notices: string[] = [];
  if (list.length > 0 && !entry) {
    notices.push(
      `The ${deps.harness} model list does not include "${request.key}"; launching with that key anyway.`,
    );
  }
  if (deps.thinking !== undefined) {
    const warning = undeclaredLevelWarning(deps.harness, entry, deps.thinking);
    if (warning !== undefined) notices.push(warning);
  }

  return {
    resolved: {
      kind: "foreign",
      harness: deps.harness,
      modelKey: request.key,
      modelName: entry?.label ?? request.key,
      thinking: deps.thinking ?? null,
    },
    notices,
  };
}

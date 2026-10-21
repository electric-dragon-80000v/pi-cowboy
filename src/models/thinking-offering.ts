/**
 * thinking-offering.ts — the thinking control one model offers, in the
 * vocabulary of the harness that will run it.
 *
 * The answer is one of three shapes: `closed` is a vocabulary the harness
 * enforces (pi's levels, claude's effort names, codex's reasoning efforts), so a
 * consumer drops an outside token; `advisory` is only what the harness
 * advertises (opencode's variants are user-extensible), so a consumer keeps
 * one; `none` is a model that takes no level at all.
 *
 * Exports: ThinkingOffering, thinkingOfferingFor, unionThinkingOffering.
 */

import {
  getSupportedThinkingLevels,
  type Api,
  type Model,
} from "@earendil-works/pi-ai";
import {
  isPiFamilyHarness,
  type AnyHarnessId,
  type ModelEntry,
} from "../agents/harness.js";

/**
 * What a model offers, in the rule its own harness enforces: a closed list of
 * every legal token, an advisory list a token may fall outside of, or no
 * control at all. `none` is a hard stop rather than an empty closed list — a
 * model in that state cannot take any token, so no consumer carries one
 * forward. An advisory list may be empty: nothing could enumerate the tokens,
 * which is not the same as the model refusing them.
 */
export type ThinkingOffering =
  | { readonly kind: "closed"; readonly levels: readonly string[] }
  | { readonly kind: "advisory"; readonly levels: readonly string[] }
  | { readonly kind: "none" };

export interface ThinkingOfferingInput {
  /** The harness that will run the model. */
  harnessId: AnyHarnessId;
  /** The model the launch will name, or "" when it names none. */
  modelKey: string;
  /** The launching harness's entries, as its own list answered them. */
  entries: readonly ModelEntry[];
  /**
   * The pi catalogue entry `modelKey` resolves to, when this session knows it.
   * Its levels are pi's own answer for the entry: a `Model` carries `reasoning`
   * but no level list, so the offering computes them instead of taking a
   * second, hand-built shape.
   */
  piModel: Model<Api> | undefined;
}

export function thinkingOfferingFor(
  input: ThinkingOfferingInput,
): ThinkingOffering {
  const { harnessId, modelKey, entries, piModel } = input;

  // The pi family runs one binary and publishes one level vocabulary, so its
  // answer comes from the model itself rather than from a listed entry.
  if (isPiFamilyHarness(harnessId)) {
    if (piModel === undefined) {
      // A configured key the registry no longer lists: nothing here can
      // enumerate its levels, and pi may still accept it.
      return { kind: "advisory", levels: [] };
    }
    return piModel.reasoning
      ? { kind: "closed", levels: getSupportedThinkingLevels(piModel) }
      : { kind: "none" };
  }

  // A spawn that names no model runs this harness's own default, whose level
  // list this session cannot name: the union of what its models advertise is
  // the closest vocabulary available.
  if (modelKey === "") return unionThinkingOffering(entries);

  const entry = entries.find((candidate) => candidate.key === modelKey);
  if (entry === undefined) {
    // A key the harness no longer lists: that harness, not this session, is
    // the authority on what it accepts.
    return { kind: "advisory", levels: [] };
  }
  if (entry.thinkingLevels.kind === "advisory") {
    return { kind: "advisory", levels: entry.thinkingLevels.levels };
  }
  return entry.thinkingLevels.levels.length === 0
    ? { kind: "none" }
    : { kind: "closed", levels: entry.thinkingLevels.levels };
}

/**
 * The levels a harness's models advertise together, for a launch no single
 * entry answers for. An advisory entry — or no entries at all — leaves the list
 * open, because such a list is not a vocabulary the harness enforces.
 */
export function unionThinkingOffering(
  entries: readonly ModelEntry[],
): ThinkingOffering {
  const levels = [
    ...new Set(entries.flatMap((entry) => entry.thinkingLevels.levels)),
  ];
  const openList =
    entries.length === 0 ||
    entries.some((entry) => entry.thinkingLevels.kind === "advisory");
  if (levels.length === 0 && !openList) return { kind: "none" };
  return openList ? { kind: "advisory", levels } : { kind: "closed", levels };
}

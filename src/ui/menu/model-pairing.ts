/**
 * model-pairing.ts — a model and the thinking level it runs at are one setting,
 * so the Model Settings screen shows them in one cell and writes them through
 * one flow.
 *
 * `thinkingOfferingForModel` is the screen's one read of what a model can take,
 * so the list a row shows and the picker it opens always agree. `pairedRow`
 * renders the pair: the model with its winning layer, then the level with its
 * own, because the two may be written at different layers.
 *
 * Exports: thinkingOfferingForModel, pairedRow.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { AnyHarnessId } from "../../agents/harness.js";
import type { HarnessModelOptions } from "../../agents/harness/harness-registry.js";
import {
  thinkingOfferingFor,
  type ThinkingOffering,
} from "../../models/thinking-offering.js";
import { findModelInRegistry } from "../../utils.js";

/**
 * The thinking control one model offers, read from the lists this menu tree
 * loaded and — for the pi family — from pi's own catalogue entry. A row that
 * names no model passes "", which resolves to the model the launch inherits.
 */
export function thinkingOfferingForModel(input: {
  readonly harnessId: AnyHarnessId;
  /** Null when the row names no model, so the chain's default answers. */
  readonly modelKey: string | null;
  readonly entries: HarnessModelOptions;
  readonly registry: Parameters<typeof findModelInRegistry>[1];
  readonly parentModel: Model<Api> | undefined;
}): ThinkingOffering {
  return thinkingOfferingFor({
    harnessId: input.harnessId,
    modelKey: input.modelKey ?? "",
    entries: input.entries.get(input.harnessId) ?? [],
    piModel: findModelInRegistry(
      input.modelKey ?? "",
      input.registry,
      input.parentModel,
    ),
  });
}

/** One row's pair, already resolved through the precedence chain. */
export interface PairCell {
  /** Null when no layer names a model and nothing is inherited. */
  readonly model: string | null;
  /** Winning layer of the model key: " [session]", " [project]", or "". */
  readonly modelTag: string;
  /** Null when no layer names a level; rendered as "inherit". */
  readonly thinking: string | null;
  /** Winning layer of the level: " [session]", " [project]", or "". */
  readonly thinkingTag: string;
}

/**
 * The row's one value: `model [layer] · level [layer]`. Each half keeps its own
 * tag, because a model and a level can be written at different layers — but a
 * pair written at one layer names that layer once, at the end. An untagged
 * level means no layer named one: the harness's own default applies.
 */
export function pairedRow(cell: PairCell): string {
  const model = cell.model ?? "(none)";
  const thinking = cell.thinking ?? "inherit";
  const modelTag = cell.model ? cell.modelTag : "";
  const thinkingTag = cell.thinking ? cell.thinkingTag : "";
  if (modelTag !== "" && modelTag === thinkingTag) {
    return `${model} · ${thinking}${thinkingTag}`;
  }
  return `${model}${modelTag} · ${thinking}${thinkingTag}`;
}

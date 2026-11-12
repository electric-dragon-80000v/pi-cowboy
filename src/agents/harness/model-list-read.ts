/**
 * model-list-read.ts — how a spawn path reads one harness's model list.
 *
 * The session catalog answers when the session installed one, so a menu picker,
 * a spawn, and a handover share a single read per harness. A caller outside a
 * booted session (a tool run against a bare harness registry) reads the harness
 * directly, which is the same contract the catalog calls.
 *
 * A read that cannot answer carries the line explaining why, and a spawn has
 * nowhere to put it: `harnessModelReader` hands the caller a `listModels`
 * dependency that shows that line on the session's UI and resolves to the
 * entries, so no spawn path has to remember the reporting.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  getHarnessModelCatalogOrNull,
  getHarnessRegistry,
  getPiInstance,
  piModelCatalog,
} from "../../shell.js";
import {
  modelListEntries,
  modelListNotice,
  type AnyHarnessId,
  type ModelEntry,
  type ModelList,
} from "../harness.js";

export async function readHarnessModelList(
  harness: AnyHarnessId,
  ctx: Pick<ExtensionContext, "modelRegistry">,
): Promise<ModelList> {
  const catalog = getHarnessModelCatalogOrNull();
  if (catalog !== null) return await catalog.list(harness);
  return await getHarnessRegistry()
    .require(harness)
    .listModels({
      pi: getPiInstance(),
      modelCatalog: piModelCatalog(ctx.modelRegistry),
    });
}

/**
 * A `listModels` dependency for one spawn: the harness's entries, with its
 * failure line (if any) shown to the human rather than silently dropped.
 */
export function harnessModelReader(
  ctx: Pick<ExtensionContext, "hasUI" | "ui" | "modelRegistry">,
): (harness: AnyHarnessId) => Promise<readonly ModelEntry[]> {
  return async (harness) => {
    const list = await readHarnessModelList(harness, ctx);
    const notice = modelListNotice(list);
    if (notice !== undefined && ctx.hasUI) ctx.ui.notify(notice, "warning");
    return modelListEntries(list);
  };
}

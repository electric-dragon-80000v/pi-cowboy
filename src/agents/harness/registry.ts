/**
 * harness/registry.ts — the one module that knows every harness.
 *
 * It owns the id → implementation lookup, so a caller that holds a
 * `harness_type` resolves it to the harness that launches it, and it owns the
 * listing that spans harnesses, so no caller has to name one.
 */

import type { Availability } from "../../availability.js";
import {
  runnableHarnessIds,
  type Harness,
  type HarnessId,
  type HarnessListModelsRequest,
  type ModelEntry,
} from "../harness.js";
import { buildPiLaunchArgs, piFamilyListModels } from "./pi-compatible.js";
import { pigHarness } from "./pig.js";
import { piBoltHarness } from "./pi-bolt.js";
import { opencodeHarness } from "./opencode.js";

/**
 * Real pi is already the pane shell's `pi`: it is always launchable, and there
 * is nothing to prepare or tear down. Its argv is the family's shared
 * assembly — pi is the family's namesake — and its model list is the family's
 * shared catalog.
 */
const piHarness: Harness = {
  id: "pi",
  available: () => true,
  prepare: async () => {},
  buildArgs: buildPiLaunchArgs,
  listModels: piFamilyListModels,
  teardown: async () => {},
};

/** Keyed by id, so a harness added to `HARNESS_IDS` without an implementation fails to compile. */
const HARNESSES: Record<HarnessId, Harness> = {
  pi: piHarness,
  pig: pigHarness,
  "pi-bolt": piBoltHarness,
  opencode: opencodeHarness,
};

/** The implementation for one harness id. */
export function harnessFor(id: HarnessId): Harness {
  return HARNESSES[id];
}

/**
 * The models every harness this machine can run offers, in `HARNESS_IDS` order
 * and once per key. Each harness answers for itself, so a caller that only
 * needs "what can a spawn be given" never has to name one.
 */
export async function listHarnessModels(
  request: HarnessListModelsRequest,
  availability: Availability<HarnessId>,
): Promise<readonly ModelEntry[]> {
  const lists = await Promise.all(
    runnableHarnessIds(availability).map(async (id) => {
      try {
        return await harnessFor(id).listModels(request);
      } catch {
        // `listModels` is not supposed to throw; one that does costs its own
        // list, never the others'.
        return [];
      }
    }),
  );
  const byKey = new Map<string, ModelEntry>();
  for (const entry of lists.flat()) {
    if (!byKey.has(entry.key)) byKey.set(entry.key, entry);
  }
  return [...byKey.values()];
}

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
} from "../harness.js";
import { buildPiLaunchArgs, piFamilyListModels } from "./pi-compatible.js";
import { pigHarness } from "./pig.js";
import { piBoltHarness } from "./pi-bolt.js";
import { opencodeHarness } from "./opencode/index.js";
import { codexHarness } from "./codex.js";
import { claudeHarness } from "./claude/index.js";

/**
 * Real pi is already the pane shell's `pi`: it is always launchable, and there
 * is nothing to prepare or tear down. Its argv is the family's shared
 * assembly — pi is the family's namesake — and its model list is the family's
 * shared catalog.
 */
const piHarness: Harness<"pi"> = {
  id: "pi",
  agentMuxKind: "pi",
  available: () => true,
  prepare: async () => {},
  buildArgs: buildPiLaunchArgs,
  listModels: piFamilyListModels,
  // The catalog is local: nothing to warm.
  prefetchModels: () => {},
  teardown: async () => {},
};

/** Keyed by id, so a harness added to `HARNESS_IDS` without an implementation fails to compile. */
const HARNESSES: { [K in HarnessId]: Harness<K> } = {
  pi: piHarness,
  pig: pigHarness,
  "pi-bolt": piBoltHarness,
  opencode: opencodeHarness,
  codex: codexHarness,
  claude: claudeHarness,
};

/** The implementation for one harness id, typed to that harness's launch request. */
export function harnessFor<K extends HarnessId>(id: K): Harness<K> {
  return HARNESSES[id];
}

/**
 * The model keys each harness this machine can run offers, keyed by harness.
 * A harness whose list could not be produced is present with an empty list:
 * "no models" belongs to that harness alone and is never filled in from
 * another's.
 */
export type HarnessModelOptions = ReadonlyMap<HarnessId, readonly string[]>;

/**
 * One list per runnable harness, each answering for itself, read once when a
 * menu tree opens so every picker under it selects from the same answer.
 */
export async function listHarnessModelOptions(
  request: HarnessListModelsRequest,
  availability: Availability<HarnessId>,
): Promise<HarnessModelOptions> {
  const entries = await Promise.all(
    runnableHarnessIds(availability).map(
      async (id): Promise<readonly [HarnessId, readonly string[]]> => {
        try {
          const models = await harnessFor(id).listModels(request);
          return [id, models.map((entry) => entry.key)];
        } catch {
          // `listModels` is not supposed to throw; one that does costs its own
          // list, never the others'.
          return [id, []];
        }
      },
    ),
  );
  return new Map(entries);
}

/**
 * The one merged view of the per-harness structure: every harness's keys, once
 * each, in `HARNESS_IDS` order. Only the concurrency menu asks for it — its
 * slots are keyed by model key across harnesses, so it must offer every key a
 * spawn could carry.
 */
export function mergeHarnessModelOptions(
  options: HarnessModelOptions,
): string[] {
  const keys = new Set<string>();
  for (const list of options.values()) {
    for (const key of list) keys.add(key);
  }
  return [...keys];
}

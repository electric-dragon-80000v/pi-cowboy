/**
 * model-list-catalog.ts — one session's shared, deferred harness model lists.
 *
 * A list starts at most once per harness while it is being read: the warm pass
 * and every later consumer join that one promise. Warming is scheduled off the
 * startup path and runs one harness at a time, so no harness's CLI can hold the
 * session's first screen or another harness's read behind it. Only a successful
 * answer is retained, so a failed read leaves the harness cold and the next
 * picker retries instead of pinning an empty row for the session. A reader that
 * throws is answered as its own harness's unavailable list, so a broken foreign
 * CLI never costs another's.
 *
 * `listModels` is asynchronous by contract, and the catalog enforces what that
 * promise means: a harness that instead holds the event loop while it answers is
 * reported, because such a delay would land on whatever the human is looking at.
 */

import { setImmediate } from "node:timers";
import type { Availability } from "../../availability.js";
import { errorMessage } from "../../utils.js";
import type {
  AnyHarnessId,
  HarnessListModelsRequest,
  ModelEntry,
  ModelList,
} from "../harness.js";
import { modelListEntries, modelListNotice } from "../harness.js";
import type {
  HarnessModelOptions,
  HarnessRegistry,
} from "./harness-registry.js";

/**
 * How long a `listModels` call may occupy the event loop before the catalog
 * reports it. A correct implementation welcomes this budget: it starts the work
 * and returns a promise, so the synchronous part is parsing an argv at most.
 */
const BLOCKING_CALL_MS = 100;

export interface HarnessModelCatalog {
  /** The listed answers so far, keyed by the harness that owns them. */
  readonly options: HarnessModelOptions;
  /** The newest failure notice per harness, cleared by a later success. */
  notices(): readonly string[];
  /** The shared answer for one harness, starting its read when still cold. */
  list(harness: AnyHarnessId): Promise<ModelList>;
  /** Await one list and retain its entries for menu readers. */
  loadOptions(harness: AnyHarnessId): Promise<readonly ModelEntry[]>;
  /**
   * Warm every runnable harness's list without blocking anything: the pass is
   * scheduled onto a later turn and reads one harness at a time.
   */
  warm(): void;
}

export function createHarnessModelCatalog(options: {
  readonly registry: HarnessRegistry;
  readonly availability: Availability<AnyHarnessId>;
  readonly request: HarnessListModelsRequest;
}): HarnessModelCatalog {
  /** A read in flight, or the answer a completed read reached. */
  const states = new Map<AnyHarnessId, Promise<ModelList>>();
  const listed = new Map<AnyHarnessId, readonly ModelEntry[]>();
  const failures = new Map<AnyHarnessId, string>();

  /** One harness's `listModels`, classified and reported if it blocks. */
  const start = (harness: AnyHarnessId): Promise<ModelList> => {
    const began = performance.now();
    try {
      const answer = options.registry
        .require(harness)
        .listModels(options.request);
      const held = performance.now() - began;
      if (held >= BLOCKING_CALL_MS) reportBlocking(harness, held);
      return Promise.resolve(answer);
    } catch (error) {
      return Promise.reject(error);
    }
  };

  const read = (harness: AnyHarnessId): Promise<ModelList> => {
    const inFlight = states.get(harness);
    if (inFlight !== undefined) return inFlight;

    const result = start(harness)
      .catch((error): ModelList => ({
        kind: "unavailable",
        notice: `Could not list the ${options.registry.displayName(harness)} models (${errorMessage(error)}).`,
      }))
      .then((answer): ModelList => {
        states.delete(harness);
        const entries = modelListEntries(answer);
        if (entries.length > 0) listed.set(harness, entries);
        const notice = modelListNotice(answer);
        if (notice === undefined) failures.delete(harness);
        else failures.set(harness, notice);
        return answer;
      });
    states.set(harness, result);
    return result;
  };

  const loadOptions = async (
    harness: AnyHarnessId,
  ): Promise<readonly ModelEntry[]> => modelListEntries(await read(harness));

  return {
    options: listed,
    notices: () => [...failures.values()],
    list: read,
    loadOptions,
    warm() {
      // A later turn, never this one: the session finishes booting first.
      setImmediate(() => {
        void (async () => {
          for (const harness of options.registry.runnable(
            options.availability,
          )) {
            await loadOptions(harness);
            // Give the event loop a turn between harnesses, so one slow CLI
            // never queues every other read behind it in the same burst.
            await new Promise((resolve) => setImmediate(resolve));
          }
        })();
      });
    },
  };
}

/** A harness that answered by blocking: say so, naming what it cost. */
function reportBlocking(harness: AnyHarnessId, heldMs: number): void {
  console.warn(
    `[cowboy] the "${harness}" harness held the event loop for ${Math.round(heldMs)}ms while listing its models; ` +
      "listModels must start its work and return a promise instead of blocking.",
  );
}

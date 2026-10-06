/**
 * batch.ts — the batch pipeline every Cowboy batch tool runs.
 *
 * A batch tool handles one or more items of the same kind, and the sequence is
 * the same for all of them: reject a repeated key before touching anything, run
 * the tool's remaining whole-call guards, handle the items one at a time in
 * input order, and return one text block per item next to the per-item
 * outcomes. A tool supplies only its own parts — which parameter it walks, the
 * per-item work, and the rule for a halted batch.
 */

import { successResult, type ToolResult } from "./tool-result.js";

/** Between the per-item blocks of a batch result: one batch reads as one document of item blocks. */
export const BATCH_ITEM_SEPARATOR = "\n\n---\n\n";

/** The array parameter a batch walks. */
export type BatchParam = "agent_ids" | "branches";

/** How an item is named in the duplicate-key error; a tool names its parameter, never its grammar. */
const ITEM_NOUNS: Record<BatchParam, { plural: string }> = {
  agent_ids: { plural: "agent ids" },
  branches: { plural: "branches" },
};

/** One handled item: its outcome for `details`, and the text block for its slot in the batch text. */
export interface BatchItem<TOutcome> {
  outcome: TOutcome;
  text: string;
}

/** One item an outcome halted the batch on, and how every later item is skipped. */
type HaltRule<TOutcome, TUnit> = {
  on: (outcome: TOutcome) => boolean;
  skip: (item: string, haltedBy: string) => TUnit;
};

/**
 * How a tool produces one item's block. Usually the block reads off the outcome
 * alone, and `render` says how; where it carries per-item state the outcome
 * does not — steer's pre-delivery status, merge's raw git message and
 * outside-repo banner — the handler pairs the outcome with its block instead.
 *
 * The pairing shape comes first because inference does not revisit a union
 * member: a pairing tool's spec has to be matched against it before the
 * renderer's `handleItem`, which would otherwise pin the outcome to the pair.
 */
type ItemHandler<TOutcome> =
  | {
      handleItem: (item: string) => Promise<BatchItem<TOutcome>>;
      halt?: HaltRule<TOutcome, BatchItem<TOutcome>>;
    }
  | {
      render: (outcome: TOutcome) => string;
      handleItem: (item: string) => Promise<TOutcome>;
      halt?: HaltRule<TOutcome, TOutcome>;
    };

/** One batch tool's own parts of the pipeline. */
export type BatchSpec<TOutcome, TKey extends string> = ItemHandler<TOutcome> & {
  /** Tool name as the model sees it, which opens the duplicate-key error. */
  toolName: string;
  /** The parameter the tool walks, e.g. `agent_ids`. */
  param: BatchParam;
  /** The whole call's items, in input order. */
  items: readonly string[];
  /** The `details` key the outcomes are returned under, e.g. `agents`. */
  detailsKey: TKey;
  /** The tool's whole-call guards beyond the duplicate check; runs before the first item, so a refusal mutates nothing. */
  prepare?: () => void | Promise<void>;
};

/** A tool's handler in the single shape the batch loop works with. */
interface BatchSteps<TOutcome> {
  handle: (item: string) => Promise<BatchItem<TOutcome>>;
  /** The tool's halt rule in pair form; absent when the tool supplied none. */
  halt:
    | {
        halts: (outcome: TOutcome) => boolean;
        skip: (item: string, haltedBy: string) => BatchItem<TOutcome>;
      }
    | undefined;
}

/**
 * Runs one batch: the duplicate-key guard, the tool's remaining guards, then
 * the items sequentially in input order. Each item contributes exactly one
 * outcome and one text block, so `details` and the text always line up.
 */
export async function runBatch<TOutcome, TKey extends string>(
  spec: BatchSpec<TOutcome, TKey>,
): Promise<ToolResult<Record<TKey, TOutcome[]>>> {
  const { items } = spec;
  rejectRepeatedKeys(items, spec);
  await spec.prepare?.();

  const steps = batchSteps(spec);
  const outcomes: TOutcome[] = [];
  const blocks: string[] = [];
  const record = ({ outcome, text }: BatchItem<TOutcome>): void => {
    outcomes.push(outcome);
    blocks.push(text);
  };

  let haltedBy: string | undefined;
  for (const item of items) {
    const halt = steps.halt;
    if (halt !== undefined && haltedBy !== undefined) {
      record(halt.skip(item, haltedBy));
      continue;
    }
    const handled = await steps.handle(item);
    record(handled);
    if (halt !== undefined && halt.halts(handled.outcome)) haltedBy = item;
  }

  return successResult(blocks.join(BATCH_ITEM_SEPARATOR), {
    [spec.detailsKey]: outcomes,
  } as Record<TKey, TOutcome[]>);
}

/** Flattens a tool's handler into the pair form the loop reads, rendering from the outcome where the tool asked for that. */
function batchSteps<TOutcome>(
  spec: ItemHandler<TOutcome>,
): BatchSteps<TOutcome> {
  if ("render" in spec) {
    const render = spec.render;
    const halt = spec.halt;
    return {
      handle: async (item) => {
        const outcome = await spec.handleItem(item);
        return { outcome, text: render(outcome) };
      },
      halt:
        halt === undefined
          ? undefined
          : {
              halts: (outcome) => halt.on(outcome),
              skip: (item, haltedBy) => {
                const outcome = halt.skip(item, haltedBy);
                return { outcome, text: render(outcome) };
              },
            },
    };
  }
  const halt = spec.halt;
  return {
    handle: spec.handleItem,
    halt:
      halt === undefined
        ? undefined
        : { halts: (o) => halt.on(o), skip: halt.skip },
  };
}

/**
 * A key passed twice throws before the batch touches anything, so no item is ever half-handled.
 * Compared trimmed, because every tool's handler trims the item before acting on it — two spellings
 * of one key are one repeated key, not two distinct ones.
 */
function rejectRepeatedKeys(
  keys: readonly string[],
  { toolName, param }: { toolName: string; param: BatchParam },
): void {
  const canonical = keys.map((key) => key.trim());
  const repeated = canonical.filter(
    (key, index) => canonical.indexOf(key) !== index,
  );
  if (repeated.length === 0) return;
  const noun = ITEM_NOUNS[param];
  throw new Error(
    `${toolName} received duplicate ${noun.plural} in \`${param}\`: ${[...new Set(repeated)].join(", ")}. No item was handled.`,
  );
}

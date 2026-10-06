/**
 * batch.test.ts — the shared batch pipeline: the duplicate-key guard, the
 * tool's own whole-call guards, sequential per-item handling, the halt rule,
 * and the block-joined result.
 *
 * The wording table pins the exact error text each tool throws, so a change to
 * the shared message format or to a parameter's nouns cannot pass unnoticed.
 */

import { describe, expect, it, vi } from "vitest";
import {
  BATCH_ITEM_SEPARATOR,
  runBatch,
  type BatchItem,
} from "../src/agents/batch.js";

/** A spec whose text renders off the outcome: the shape a tool uses when its block is a function of its outcome. */
function renderingSpec(items: readonly string[]) {
  return {
    toolName: "stop_cowboy_agent",
    param: "agent_ids" as const,
    detailsKey: "agents" as const,
    items,
    render: (outcome: string) => `text:${outcome}`,
    handleItem: async (item: string) => `outcome:${item}`,
  };
}

/** A spec whose handler pairs each outcome with its text: the shape a tool uses when the text carries per-item state the outcome does not. */
function pairingSpec(items: readonly string[]) {
  return {
    toolName: "merge_cowboy_branch",
    param: "branches" as const,
    detailsKey: "branches" as const,
    items,
    handleItem: async (item: string): Promise<BatchItem<string>> => ({
      outcome: `outcome:${item}`,
      text: `paired:${item}`,
    }),
  };
}

describe("runBatch — the handling loop", () => {
  it("handles every item in input order and joins the blocks with the batch separator", async () => {
    const handled: string[] = [];
    const spec = renderingSpec(["a", "b"]);
    const result = await runBatch({
      ...spec,
      handleItem: async (item) => {
        handled.push(item);
        return spec.handleItem(item);
      },
    });

    expect(handled).toEqual(["a", "b"]);
    expect(result.content).toEqual([
      { type: "text", text: "text:outcome:a\n\n---\n\ntext:outcome:b" },
    ]);
    expect(result.details).toEqual({
      agents: ["outcome:a", "outcome:b"],
    });
    expect(BATCH_ITEM_SEPARATOR).toBe("\n\n---\n\n");
  });

  it("renders a single item with no separator", async () => {
    const result = await runBatch(renderingSpec(["only"]));

    expect(result.content).toEqual([
      { type: "text", text: "text:outcome:only" },
    ]);
  });

  it("renders each item from its own outcome", async () => {
    const result = await runBatch({
      ...renderingSpec(["a", "b"]),
      render: (outcome) => `<${outcome}>`,
    });

    expect(result.content[0].text).toBe("<outcome:a>\n\n---\n\n<outcome:b>");
  });

  it("keeps the handler's own text when it pairs the text with the outcome", async () => {
    const result = await runBatch(pairingSpec(["a", "b"]));

    expect(result.content[0].text).toBe("paired:a\n\n---\n\npaired:b");
    expect(result.details).toEqual({
      branches: ["outcome:a", "outcome:b"],
    });
  });

  it("returns the outcomes under the tool's own details key", async () => {
    const result = await runBatch({
      ...renderingSpec(["a"]),
      detailsKey: "stops" as const,
    });

    expect(result.details).toEqual({ stops: ["outcome:a"] });
  });
});

describe("runBatch — the duplicate-key guard", () => {
  it("accepts distinct keys", async () => {
    await expect(
      runBatch(renderingSpec(["a", "b", "c"])),
    ).resolves.toBeDefined();
  });

  it("names each repeated key once, in first-occurrence order, before handling anything", async () => {
    const handle = vi.fn(async (item: string) => `outcome:${item}`);

    await expect(
      runBatch({
        ...renderingSpec(["aa", "bb", "aa", "cc", "bb", "aa"]),
        handleItem: handle,
      }),
    ).rejects.toThrow(
      "stop_cowboy_agent received duplicate agent ids in `agent_ids`: aa, bb. No item was handled",
    );
    expect(handle).not.toHaveBeenCalled();
  });

  it("throws the same way for a pairing tool", async () => {
    const handle = vi.fn(async (item: string) => ({
      outcome: item,
      text: item,
    }));

    await expect(
      runBatch({ ...pairingSpec(["x", "x"]), handleItem: handle }),
    ).rejects.toThrow(
      "merge_cowboy_branch received duplicate branches in `branches`: x. No item was handled",
    );
    expect(handle).not.toHaveBeenCalled();
  });

  it("rejects a repeated key whose second spelling only differs by surrounding space", async () => {
    const handle = vi.fn(async (item: string) => ({
      outcome: item,
      text: item,
    }));

    await expect(
      runBatch({ ...pairingSpec([" cow-x ", "cow-x"]), handleItem: handle }),
    ).rejects.toThrow(
      "merge_cowboy_branch received duplicate branches in `branches`: cow-x. No item was handled.",
    );
    expect(handle).not.toHaveBeenCalled();
  });

  it("still accepts distinct keys that share a trimmed prefix", async () => {
    await expect(
      runBatch(renderingSpec(["aa", " aab ", "b"])),
    ).resolves.toBeDefined();
  });

  it.each([
    [
      "stop_cowboy_agent received duplicate agent ids in `agent_ids`: x. No item was handled",
      "stop_cowboy_agent",
      "agent_ids",
    ],
    [
      "cleanup_cowboy_agent received duplicate agent ids in `agent_ids`: x. No item was handled",
      "cleanup_cowboy_agent",
      "agent_ids",
    ],
    [
      "steer_cowboy_agent received duplicate agent ids in `agent_ids`: x. No item was handled",
      "steer_cowboy_agent",
      "agent_ids",
    ],
    [
      "merge_cowboy_branch received duplicate branches in `branches`: x. No item was handled",
      "merge_cowboy_branch",
      "branches",
    ],
  ] as const)(
    "names the offending tool and spells the parameter's nouns: %s",
    async (expected, toolName, param) => {
      await expect(
        runBatch({ ...renderingSpec(["x", "x"]), toolName, param }),
      ).rejects.toThrow(expected);
    },
  );
});

describe("runBatch — the tool's own guards", () => {
  it("runs them after the duplicate guard and before the first item", async () => {
    const handle = vi.fn(async (item: string) => `outcome:${item}`);
    const prepare = vi.fn(() => {
      throw new Error("message is required");
    });

    await expect(
      runBatch({ ...renderingSpec(["a", "a"]), prepare, handleItem: handle }),
    ).rejects.toThrow(
      "stop_cowboy_agent received duplicate agent ids in `agent_ids`: a. No item was handled",
    );
    expect(prepare).not.toHaveBeenCalled();
    expect(handle).not.toHaveBeenCalled();

    await expect(
      runBatch({ ...renderingSpec(["a"]), prepare, handleItem: handle }),
    ).rejects.toThrow("message is required");
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(handle).not.toHaveBeenCalled();
  });

  it("awaits an async guard", async () => {
    const order: string[] = [];
    const result = await runBatch({
      ...renderingSpec(["a"]),
      prepare: async () => {
        await Promise.resolve();
        order.push("prepare");
      },
      handleItem: async (item) => {
        order.push("handle");
        return `outcome:${item}`;
      },
    });

    expect(order).toEqual(["prepare", "handle"]);
    expect(result.details).toEqual({ agents: ["outcome:a"] });
  });
});

describe("runBatch — the halt rule", () => {
  const halves = (outcome: string): boolean => outcome === "outcome:boom";

  it("keeps iterating and handles nothing once an outcome halts, naming the halting item", async () => {
    const handled: string[] = [];
    const spec = renderingSpec(["a", "boom", "c", "d"]);
    const result = await runBatch({
      ...spec,
      handleItem: async (item) => {
        handled.push(item);
        return spec.handleItem(item);
      },
      halt: {
        on: halves,
        skip: (item, haltedBy) => `skipped:${item}:${haltedBy}`,
      },
    });

    expect(handled).toEqual(["a", "boom"]);
    expect(result.details).toEqual({
      agents: ["outcome:a", "outcome:boom", "skipped:c:boom", "skipped:d:boom"],
    });
    expect(result.content[0].text).toBe(
      [
        "text:outcome:a",
        "text:outcome:boom",
        "text:skipped:c:boom",
        "text:skipped:d:boom",
      ].join(BATCH_ITEM_SEPARATOR),
    );
  });

  it("renders a skipped item from the outcome it returns, and pairs it when the handler does", async () => {
    const rendering = await runBatch({
      ...renderingSpec(["a", "boom", "c"]),
      halt: {
        on: halves,
        skip: (item, haltedBy) => `skipped:${item}:${haltedBy}`,
      },
    });
    expect(rendering.content[0].text).toBe(
      ["text:outcome:a", "text:outcome:boom", "text:skipped:c:boom"].join(
        BATCH_ITEM_SEPARATOR,
      ),
    );

    const pairing = await runBatch({
      ...pairingSpec(["a", "boom", "c"]),
      halt: {
        on: halves,
        skip: (item, haltedBy) => ({
          outcome: `skipped:${item}:${haltedBy}`,
          text: `not attempted: ${item} after ${haltedBy}`,
        }),
      },
    });
    expect(pairing.content[0].text).toBe(
      ["paired:a", "paired:boom", "not attempted: c after boom"].join(
        BATCH_ITEM_SEPARATOR,
      ),
    );
    expect(pairing.details.branches).toEqual([
      "outcome:a",
      "outcome:boom",
      "skipped:c:boom",
    ]);
  });

  it("does not halt a batch whose outcomes never match", async () => {
    const handled: string[] = [];
    const spec = renderingSpec(["a", "b"]);
    const result = await runBatch({
      ...spec,
      handleItem: async (item) => {
        handled.push(item);
        return spec.handleItem(item);
      },
      halt: {
        on: halves,
        skip: (item) => `skipped:${item}`,
      },
    });

    expect(handled).toEqual(["a", "b"]);
    expect(result.details).toEqual({ agents: ["outcome:a", "outcome:b"] });
  });

  it("handles every item when the tool supplied no halt rule", async () => {
    const result = await runBatch(renderingSpec(["boom", "b"]));

    expect(result.details).toEqual({
      agents: ["outcome:boom", "outcome:b"],
    });
  });
});

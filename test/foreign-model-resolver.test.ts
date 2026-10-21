/**
 * foreign-model-resolver.test.ts — unit coverage for a foreign harness's
 * model resolution. Pins: the key is carried as written (pi's catalog and
 * probe are never consulted); the parent's pi key is never inherited; the
 * harness's own list is advisory — a non-empty list that lacks the key warns
 * and carries it anyway, an empty or unproducible list says nothing; and the
 * thinking level is carried verbatim, reported only against a closed list.
 *
 * The resolution has no UI: what it wants said comes back in `notices`.
 */

import { describe, expect, it, vi } from "vitest";
import type { ModelEntry } from "../src/agents/harness.js";
import {
  resolveForeignModel,
  type ForeignModelResolverDeps,
} from "../src/models/foreign-model-resolver.js";

/** The foreign resolution's deps, over a list the case controls. */
function foreignDeps(
  overrides: Pick<ForeignModelResolverDeps, "harness"> &
    Partial<ForeignModelResolverDeps>,
): ForeignModelResolverDeps {
  return {
    listModels: async () => [],
    thinking: undefined,
    ...overrides,
  };
}

describe("resolveForeignModel — a foreign harness's own vocabulary", () => {
  const FOREIGN_KEY = "anthropic/claude-3";

  it("carries a caller's key as written and never reads pi's catalog or probe", async () => {
    // The foreign deps carry no pi catalog and no probe to consult: a pi
    // lookup would have refused this key outright, and cannot even be asked.
    const answer = await resolveForeignModel(
      { source: "call", key: FOREIGN_KEY },
      foreignDeps({ harness: "opencode" }),
    );

    expect(answer).toEqual({
      resolved: {
        kind: "foreign",
        harness: "opencode",
        modelKey: FOREIGN_KEY,
        modelName: FOREIGN_KEY,
        thinking: null,
      },
      notices: [],
    });
  });

  it("carries a configured default instead of swapping in the parent's model", async () => {
    const answer = await resolveForeignModel(
      { source: "configured", key: "openai/gpt-4o" },
      foreignDeps({ harness: "opencode" }),
    );

    expect(answer.resolved).toEqual({
      kind: "foreign",
      harness: "opencode",
      modelKey: "openai/gpt-4o",
      modelName: "openai/gpt-4o",
      thinking: null,
    });
  });

  it("inherits nothing: the parent's pi key never reaches a foreign launch", async () => {
    const listModels = vi.fn(async () => [] as readonly ModelEntry[]);

    const answer = await resolveForeignModel(
      undefined,
      foreignDeps({ harness: "opencode", listModels }),
    );

    expect(answer).toEqual({ resolved: { kind: "none" }, notices: [] });
    // Nothing to compare a key against, so the harness's list is not read.
    expect(listModels).not.toHaveBeenCalled();
  });

  it("carries a level with no model, for the harness's own default to run", async () => {
    const answer = await resolveForeignModel(
      undefined,
      foreignDeps({ harness: "codex", thinking: "high" }),
    );

    expect(answer).toEqual({
      resolved: { kind: "level", thinking: "high" },
      notices: [],
    });
  });

  it("warns when the harness's list is non-empty and lacks the key, and carries it anyway", async () => {
    const list: readonly ModelEntry[] = [
      {
        key: "openai/gpt-4o",
        thinkingLevels: { kind: "advisory", levels: [] },
      },
    ];

    const answer = await resolveForeignModel(
      { source: "call", key: FOREIGN_KEY },
      foreignDeps({
        harness: "opencode",
        listModels: async () => list,
      }),
    );

    expect(answer.notices).toEqual([
      `The opencode model list does not include "${FOREIGN_KEY}"; launching with that key anyway.`,
    ]);
    expect(answer.resolved).toMatchObject({
      kind: "foreign",
      modelKey: FOREIGN_KEY,
      modelName: FOREIGN_KEY,
    });
  });

  it("says nothing when the harness's list is empty", async () => {
    const answer = await resolveForeignModel(
      { source: "configured", key: FOREIGN_KEY },
      foreignDeps({ harness: "opencode", listModels: async () => [] }),
    );

    expect(answer.notices).toEqual([]);
    expect(answer.resolved).toMatchObject({
      kind: "foreign",
      modelKey: FOREIGN_KEY,
    });
  });

  it("says nothing when the harness's list could not be produced", async () => {
    const answer = await resolveForeignModel(
      { source: "configured", key: FOREIGN_KEY },
      foreignDeps({
        harness: "opencode",
        listModels: async () => {
          throw new Error("opencode models exploded");
        },
      }),
    );

    expect(answer.notices).toEqual([]);
    expect(answer.resolved).toMatchObject({
      kind: "foreign",
      modelKey: FOREIGN_KEY,
    });
  });

  it("names the model from the matching list entry", async () => {
    const list: readonly ModelEntry[] = [
      {
        key: "openai/gpt-4o",
        label: "gpt-4o",
        thinkingLevels: { kind: "advisory", levels: [] },
      },
    ];

    const answer = await resolveForeignModel(
      { source: "call", key: "openai/gpt-4o" },
      foreignDeps({ harness: "opencode", listModels: async () => list }),
    );

    expect(answer.resolved).toMatchObject({
      modelKey: "openai/gpt-4o",
      modelName: "gpt-4o",
    });
  });
});

describe("resolveForeignModel — the thinking level", () => {
  /** A claude launch of one model whose effort names the case controls. */
  function claudeDeps(
    levels: readonly string[],
    thinking: string | undefined,
  ): ForeignModelResolverDeps {
    return foreignDeps({
      harness: "claude",
      thinking,
      listModels: async () => [
        {
          key: "anthropic/sonnet",
          label: "sonnet",
          thinkingLevels: { kind: "closed", levels },
        },
      ],
    });
  }

  it("carries a level the closed list names", async () => {
    const answer = await resolveForeignModel(
      { source: "call", key: "anthropic/sonnet" },
      claudeDeps(["low", "high"], "high"),
    );

    expect(answer.resolved).toMatchObject({ thinking: "high" });
    expect(answer.notices).toEqual([]);
  });

  it("carries a level the closed list does not name, and reports it — no substitution", async () => {
    const answer = await resolveForeignModel(
      { source: "call", key: "anthropic/sonnet" },
      claudeDeps(["low", "high"], "ultra"),
    );

    expect(answer.resolved).toMatchObject({ thinking: "ultra" });
    expect(answer.notices).toEqual([
      'The thinking level "ultra" is not one the claude model "anthropic/sonnet" declares (low, high); launching with it anyway.',
    ]);
  });

  it("warns that a model with no thinking control declares no levels", async () => {
    const answer = await resolveForeignModel(
      { source: "call", key: "anthropic/sonnet" },
      claudeDeps([], "high"),
    );

    expect(answer.notices).toEqual([
      'The claude model "anthropic/sonnet" has no thinking levels; launching with "high" anyway.',
    ]);
  });

  it("says nothing about an advisory list: a level outside it may still be legal", async () => {
    const answer = await resolveForeignModel(
      { source: "call", key: "openai/gpt-4o" },
      foreignDeps({
        harness: "opencode",
        thinking: "a-custom-variant",
        listModels: async () => [
          {
            key: "openai/gpt-4o",
            thinkingLevels: { kind: "advisory", levels: ["high"] },
          },
        ],
      }),
    );

    expect(answer.resolved).toMatchObject({ thinking: "a-custom-variant" });
    expect(answer.notices).toEqual([]);
  });
});

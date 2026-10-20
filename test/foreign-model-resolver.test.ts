/**
 * foreign-model-resolver.test.ts — unit coverage for a foreign harness's
 * model resolution. Pins: the key is carried as written (pi's catalog and
 * probe are never consulted); the parent's pi key is never inherited; and the
 * harness's own list is advisory — a non-empty list that lacks the key warns
 * and carries it anyway, an empty or unproducible list says nothing.
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
    notify: () => {},
    ...overrides,
  };
}

describe("resolveForeignModel — a foreign harness's own vocabulary", () => {
  const FOREIGN_KEY = "anthropic/claude-3";

  it("carries a caller's key as written and never reads pi's catalog or probe", async () => {
    // The foreign deps carry no pi catalog and no probe to consult: a pi
    // lookup would have refused this key outright, and cannot even be asked.
    const resolved = await resolveForeignModel(
      { source: "call", key: FOREIGN_KEY },
      foreignDeps({ harness: "opencode" }),
    );

    expect(resolved).toEqual({
      kind: "foreign",
      harness: "opencode",
      modelKey: FOREIGN_KEY,
      modelName: FOREIGN_KEY,
    });
  });

  it("carries a configured default instead of swapping in the parent's model", async () => {
    const resolved = await resolveForeignModel(
      { source: "configured", key: "openai/gpt-4o" },
      foreignDeps({ harness: "opencode" }),
    );

    expect(resolved).toEqual({
      kind: "foreign",
      harness: "opencode",
      modelKey: "openai/gpt-4o",
      modelName: "openai/gpt-4o",
    });
  });

  it("inherits nothing: the parent's pi key never reaches a foreign launch", async () => {
    const listModels = vi.fn(async () => [] as readonly ModelEntry[]);

    const resolved = await resolveForeignModel(
      undefined,
      foreignDeps({ harness: "opencode", listModels }),
    );

    expect(resolved).toEqual({ kind: "none" });
    // Nothing to compare a key against, so the harness's list is not read.
    expect(listModels).not.toHaveBeenCalled();
  });

  it("warns when the harness's list is non-empty and lacks the key, and carries it anyway", async () => {
    const notify = vi.fn();
    const list: readonly ModelEntry[] = [
      { key: "openai/gpt-4o", thinkingLevels: [] },
    ];

    const resolved = await resolveForeignModel(
      { source: "call", key: FOREIGN_KEY },
      foreignDeps({
        harness: "opencode",
        listModels: async () => list,
        notify,
      }),
    );

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0]).toBe(
      `The opencode model list does not include "${FOREIGN_KEY}"; launching with that key anyway.`,
    );
    expect(resolved).toMatchObject({
      kind: "foreign",
      modelKey: FOREIGN_KEY,
      modelName: FOREIGN_KEY,
    });
  });

  it("says nothing when the harness's list is empty", async () => {
    const notify = vi.fn();

    const resolved = await resolveForeignModel(
      { source: "configured", key: FOREIGN_KEY },
      foreignDeps({
        harness: "opencode",
        listModels: async () => [],
        notify,
      }),
    );

    expect(notify).not.toHaveBeenCalled();
    expect(resolved).toMatchObject({ kind: "foreign", modelKey: FOREIGN_KEY });
  });

  it("says nothing when the harness's list could not be produced", async () => {
    const notify = vi.fn();

    const resolved = await resolveForeignModel(
      { source: "configured", key: FOREIGN_KEY },
      foreignDeps({
        harness: "opencode",
        listModels: async () => {
          throw new Error("opencode models exploded");
        },
        notify,
      }),
    );

    expect(notify).not.toHaveBeenCalled();
    expect(resolved).toMatchObject({ kind: "foreign", modelKey: FOREIGN_KEY });
  });

  it("names the model from the matching list entry", async () => {
    const list: readonly ModelEntry[] = [
      { key: "openai/gpt-4o", label: "gpt-4o", thinkingLevels: [] },
    ];

    const resolved = await resolveForeignModel(
      { source: "call", key: "openai/gpt-4o" },
      foreignDeps({ harness: "opencode", listModels: async () => list }),
    );

    expect(resolved).toMatchObject({
      modelKey: "openai/gpt-4o",
      modelName: "gpt-4o",
    });
  });
});

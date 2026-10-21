/**
 * model-request.test.ts — unit coverage for the coordinator that routes a
 * spawn's model request to the family that can answer for it. Provenance is
 * pinned here too: the args KEY decides the source (the caller's key wins),
 * read through `readModelRequest` rather than re-derived from args. The pi
 * family's own rules are pinned in pi-model-resolver.test.ts, a foreign
 * harness's in foreign-model-resolver.test.ts; the end-to-end wiring is
 * pinned in model-override.test.ts.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelEntry } from "../src/agents/harness.js";
import {
  CONFIGURED_MODEL_KEY,
  modelChoiceFor,
  readModelKey,
  readModelRequest,
  resolveSpawnModel,
  type SpawnModelDeps,
} from "../src/models/model-request.js";
import {
  OVERRIDE,
  PARENT,
  registry,
  resetModelCatalog,
} from "./helpers/model-catalog.js";

beforeEach(() => {
  resetModelCatalog();
});

describe("readModelKey", () => {
  it("trims a string and reads everything else as unset", () => {
    expect(readModelKey(" a/b ")).toBe("a/b");
    expect(readModelKey("")).toBeUndefined();
    expect(readModelKey("   ")).toBeUndefined();
    expect(readModelKey(null)).toBeUndefined();
    expect(readModelKey(undefined)).toBeUndefined();
    expect(readModelKey(42)).toBeUndefined();
  });
});

describe("readModelRequest", () => {
  it("reads an absent request as undefined", () => {
    expect(readModelRequest({})).toBeUndefined();
    expect(readModelRequest({ model: null })).toBeUndefined();
    expect(readModelRequest({ model: "  " })).toBeUndefined();
  });

  it("tags the caller's param and the listener's channel apart", () => {
    expect(readModelRequest({ model: "override/special-model" })).toEqual({
      source: "call",
      key: "override/special-model",
    });
    expect(readModelRequest({ [CONFIGURED_MODEL_KEY]: "config/x" })).toEqual({
      source: "configured",
      key: "config/x",
    });
  });

  it("lets the caller's own key win over the injected channel", () => {
    expect(
      readModelRequest({
        model: "override/special-model",
        [CONFIGURED_MODEL_KEY]: "config/x",
      }),
    ).toEqual({ source: "call", key: "override/special-model" });
  });

  it("falls back to the configured channel for null/blank caller values", () => {
    expect(
      readModelRequest({ model: null, [CONFIGURED_MODEL_KEY]: "config/x" }),
    ).toEqual({ source: "configured", key: "config/x" });
    expect(
      readModelRequest({ model: "  ", [CONFIGURED_MODEL_KEY]: "config/x" }),
    ).toEqual({ source: "configured", key: "config/x" });
  });
});

describe("modelChoiceFor", () => {
  it("maps a level with no model onto the level-only choice", () => {
    expect(modelChoiceFor({ kind: "level", thinking: "high" })).toEqual({
      levelOnly: true,
      thinking: "high",
    });
    // Neither a model nor a level is still no choice at all.
    expect(modelChoiceFor({ kind: "none" })).toBeUndefined();
  });
});

/** The harness-aware resolution's deps, over a list the case controls. */
function spawnDeps(
  overrides: Pick<SpawnModelDeps, "harness"> & Partial<SpawnModelDeps>,
): SpawnModelDeps {
  return {
    registry,
    parent: PARENT,
    listModels: async () => [],
    thinking: undefined,
    ...overrides,
  };
}

describe("resolveSpawnModel — the pi family keeps pi's rules", () => {
  it.each(["pi", "pig", "pi-bolt"] as const)(
    "reads the catalog and the probe for %s, never a list of its own",
    async (harness) => {
      const listModels = vi.fn(async () => [] as readonly ModelEntry[]);

      expect(
        await resolveSpawnModel(
          { source: "call", key: "override/special-model" },
          spawnDeps({ harness, listModels }),
        ),
      ).toEqual({
        resolved: {
          kind: "resolved",
          model: OVERRIDE,
          modelKey: "override/special-model",
          thinking: null,
        },
        notices: [],
      });
      expect(listModels).not.toHaveBeenCalled();
    },
  );

  it("keeps the parent pin when no request exists", async () => {
    expect(
      await resolveSpawnModel(undefined, spawnDeps({ harness: "pig" })),
    ).toEqual({
      resolved: {
        kind: "resolved",
        model: PARENT,
        modelKey: "parent/parent-1",
        thinking: null,
      },
      notices: [],
    });
  });

  it("refuses a caller key the catalog lacks, exactly as the pi path does", async () => {
    await expect(
      resolveSpawnModel(
        { source: "call", key: "ghost/missing" },
        spawnDeps({ harness: "pi-bolt" }),
      ),
    ).rejects.toThrow(
      'Model "ghost/missing" is not available in this session. Nothing was spawned.',
    );
  });

  it("keeps the configured soft fallback to the parent", async () => {
    expect(
      await resolveSpawnModel(
        { source: "configured", key: "config/vanished" },
        spawnDeps({ harness: "pi" }),
      ),
    ).toEqual({
      resolved: {
        kind: "resolved",
        model: PARENT,
        modelKey: "parent/parent-1",
        thinking: null,
      },
      notices: [],
    });
  });
});

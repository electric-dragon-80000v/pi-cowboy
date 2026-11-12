/**
 * model-list-read.test.ts — how a spawn path reads one harness's model list.
 *
 * The session catalog is the answer when the session installed one; without it
 * the harness is asked directly. Either way a read that cannot answer resolves
 * to no entries and shows its reason, so a spawn never loses a list silently.
 *
 * Mocked boundary: src/shell.js, which is where the catalog and the registry
 * live for the length of a session.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModelList } from "../src/agents/harness.js";
import type { HarnessModelCatalog } from "../src/agents/harness/model-list-catalog.js";

const shell = vi.hoisted(() => ({
  catalog: null as HarnessModelCatalog | null,
  harnessListModels: undefined as
    ((request: unknown) => Promise<ModelList>) | undefined,
  received: [] as unknown[],
}));

vi.mock("../src/shell.js", () => ({
  getHarnessModelCatalogOrNull: () => shell.catalog,
  getHarnessRegistry: () => ({
    require: () => ({
      listModels: (request: unknown) => shell.harnessListModels?.(request),
    }),
  }),
  getPiInstance: () => ({ instance: true }),
  piModelCatalog: () => ({ catalog: true }),
}));

const { harnessModelReader, readHarnessModelList } =
  await import("../src/agents/harness/model-list-read.js");

/** A context that can be asked to show a warning, with the sink it uses. */
function context(hasUI = true): {
  ctx: Pick<ExtensionContext, "hasUI" | "ui" | "modelRegistry">;
  notify: ReturnType<typeof vi.fn>;
} {
  const notify = vi.fn();
  return {
    ctx: {
      hasUI,
      ui: { notify },
      modelRegistry: {},
    } as unknown as Pick<ExtensionContext, "hasUI" | "ui" | "modelRegistry">,
    notify,
  };
}

/** A catalog answering one prepared list, standing in for the session's. */
function catalogOf(list: ModelList): HarnessModelCatalog {
  return {
    options: new Map(),
    notices: () => [],
    list: async () => list,
    loadOptions: async () => [],
    warm: () => {},
  };
}

beforeEach(() => {
  shell.catalog = null;
  shell.harnessListModels = undefined;
  shell.received = [];
});

describe("readHarnessModelList", () => {
  it("takes the catalog's answer when the session installed one", async () => {
    const list: ModelList = {
      kind: "listed",
      entries: [
        {
          key: "opencode/kimi",
          thinkingLevels: { kind: "closed", levels: [] },
        },
      ],
    };
    shell.catalog = catalogOf(list);
    shell.harnessListModels = async () => {
      throw new Error("the harness must not be asked twice");
    };

    await expect(readHarnessModelList("opencode", context().ctx)).resolves.toBe(
      list,
    );
  });

  it("asks the harness itself outside a booted session", async () => {
    const list: ModelList = {
      kind: "listed",
      entries: [
        {
          key: "opencode/kimi",
          thinkingLevels: { kind: "closed", levels: [] },
        },
      ],
    };
    shell.harnessListModels = async (request) => {
      shell.received.push(request);
      return list;
    };

    await expect(readHarnessModelList("opencode", context().ctx)).resolves.toBe(
      list,
    );
    // The harness is handed the session's pi and its catalog, exactly as a
    // menu read would pass them.
    expect(shell.received).toEqual([
      { pi: { instance: true }, modelCatalog: { catalog: true } },
    ]);
  });
});

describe("harnessModelReader", () => {
  it("resolves to the listed entries", async () => {
    shell.catalog = catalogOf({
      kind: "listed",
      entries: [
        {
          key: "opencode/kimi",
          thinkingLevels: { kind: "closed", levels: [] },
        },
        { key: "opencode/glm", thinkingLevels: { kind: "closed", levels: [] } },
      ],
    });
    const { ctx, notify } = context();

    await expect(harnessModelReader(ctx)("opencode")).resolves.toEqual([
      { key: "opencode/kimi", thinkingLevels: { kind: "closed", levels: [] } },
      { key: "opencode/glm", thinkingLevels: { kind: "closed", levels: [] } },
    ]);
    expect(notify).not.toHaveBeenCalled();
  });

  it("shows a failed read's reason and carries on with no entries", async () => {
    shell.catalog = catalogOf({
      kind: "unavailable",
      notice: "Could not list the OpenCode models (boom).",
    });
    const { ctx, notify } = context();

    await expect(harnessModelReader(ctx)("opencode")).resolves.toEqual([]);
    expect(notify).toHaveBeenCalledWith(
      "Could not list the OpenCode models (boom).",
      "warning",
    );
  });

  it("says nothing when the session has no UI to say it on", async () => {
    shell.catalog = catalogOf({
      kind: "unavailable",
      notice: "Could not list the OpenCode models (boom).",
    });
    const { ctx, notify } = context(false);

    await expect(harnessModelReader(ctx)("opencode")).resolves.toEqual([]);
    expect(notify).not.toHaveBeenCalled();
  });
});

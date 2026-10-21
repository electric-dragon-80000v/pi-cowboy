/**
 * config-harness-default-models.test.ts — `agent.defaultModelByHarness` end to
 * end through the config layer: per-entry validation, the layer merge, the
 * store's per-layer setters/clearers, and its session layer.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigStore } from "../src/config/config-store.js";
import {
  isProjectAllowedAgentKey,
  mergeDefaults,
  mergeLayers,
} from "../src/config/config-io.js";
import { validateRawLayer } from "../src/config/config-validation.js";
import type {
  ConfigIO,
  LoadedConfig,
  RawConfig,
} from "../src/config/config-io.js";

afterEach(() => {
  vi.restoreAllMocks();
});

/** In-memory ConfigIO: records every save so persistence is assertable. */
function memoryIO(
  global: RawConfig,
  project: RawConfig | null = null,
  projectStatus: LoadedConfig["projectStatus"] = "loaded",
): { io: ConfigIO; savedGlobal: RawConfig[]; savedProject: RawConfig[] } {
  const savedGlobal: RawConfig[] = [];
  const savedProject: RawConfig[] = [];
  const io: ConfigIO = {
    load: (): LoadedConfig => ({
      global: structuredClone(global),
      project: project === null ? null : structuredClone(project),
      projectStatus,
    }),
    isGlobalWritable: () => true,
    paths: () => ({ global: "config.json" }),
    saveGlobal: (config) => {
      savedGlobal.push(structuredClone(config));
    },
    saveProject: (config) => {
      savedProject.push(structuredClone(config));
    },
  };
  return { io, savedGlobal, savedProject };
}

describe("defaultModelByHarness — file validation", () => {
  it("keeps every harness key in the vocabulary, null values included", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const cleaned = validateRawLayer(
      {
        agent: {
          defaultModelByHarness: {
            opencode: "anthropic/claude-opus-4",
            pig: null,
          },
        },
      },
      "config.json",
    );

    expect(warn).not.toHaveBeenCalled();
    expect(cleaned.agent?.defaultModelByHarness).toEqual({
      opencode: "anthropic/claude-opus-4",
      pig: null,
    });
  });

  it("keeps a harness key the built-in vocabulary does not know, since a plugin harness id is valid", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const cleaned = validateRawLayer(
      {
        agent: {
          defaultModelByHarness: {
            cow: "anthropic/claude-opus-4",
            opencode: "openai/gpt-4o",
          },
        },
      },
      "config.json",
    );

    expect(cleaned.agent?.defaultModelByHarness).toEqual({
      cow: "anthropic/claude-opus-4",
      opencode: "openai/gpt-4o",
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("drops a non-model value with a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const cleaned = validateRawLayer(
      { agent: { defaultModelByHarness: { opencode: 42 } } },
      "config.json",
    );

    expect(cleaned.agent?.defaultModelByHarness).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain(
      "agent.defaultModelByHarness.opencode",
    );
  });

  it("drops a value that is not a map at all, naming the expected shape", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const cleaned = validateRawLayer(
      { agent: { defaultModelByHarness: "openai/gpt-4o" } },
      "config.json",
    );

    expect(cleaned.agent?.defaultModelByHarness).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain("agent.defaultModelByHarness");
  });
});

describe("defaultModelByHarness — layers", () => {
  it("merges per entry, so a project entry never drops a global one", () => {
    const merged = mergeLayers(
      {
        agent: {
          defaultModelByHarness: {
            opencode: "openai/gpt-4",
            pig: "anthropic/claude-3",
          },
        },
      },
      { agent: { defaultModelByHarness: { opencode: "openai/gpt-4o" } } },
    );

    expect(merged.agent?.defaultModelByHarness).toEqual({
      opencode: "openai/gpt-4o",
      pig: "anthropic/claude-3",
    });
  });

  it("is project-writable: it is a model setting", () => {
    expect(isProjectAllowedAgentKey("defaultModelByHarness")).toBe(true);
  });

  it("bakes no default: an absent map reads as every harness unset", () => {
    const store = new ConfigStore(memoryIO({}).io);

    expect(mergeDefaults({}).agent.defaultModelByHarness).toBeUndefined();
    expect(store.defaultModelForHarness("opencode")).toBeNull();
  });
});

describe("defaultModelByHarness — project over global", () => {
  it("resolves the project layer's entry over the global layer's", () => {
    const store = new ConfigStore(
      memoryIO(
        { agent: { defaultModelByHarness: { opencode: "openai/gpt-4" } } },
        {
          agent: {
            defaultModelByHarness: { opencode: "anthropic/claude-opus-4" },
          },
        },
      ).io,
    );

    expect(store.defaultModelForHarness("opencode")).toBe(
      "anthropic/claude-opus-4",
    );
  });

  it("falls through to the global layer for a harness the project omits", () => {
    const store = new ConfigStore(
      memoryIO(
        { agent: { defaultModelByHarness: { opencode: "openai/gpt-4" } } },
        { agent: { defaultModelByHarness: { pig: "anthropic/claude-3" } } },
      ).io,
    );

    expect(store.defaultModelForHarness("opencode")).toBe("openai/gpt-4");
  });

  it("reads the pi family's default from the one `default` key", () => {
    const store = new ConfigStore(
      memoryIO({
        agent: {
          default: "openai/gpt-4",
          defaultModelByHarness: { opencode: "anthropic/claude-opus-4" },
        },
      }).io,
    );

    expect(store.defaultModelForHarness("pi")).toBe("openai/gpt-4");
    expect(store.defaultModelForHarness("pig")).toBe("openai/gpt-4");
    expect(store.defaultModelForHarness("pi-bolt")).toBe("openai/gpt-4");
  });
});

describe("model resolution — the harness default's position", () => {
  const TEMPLATE_MODEL = "template/template-model";
  const OPENCODE_DEFAULT = "openai/gpt-4o";

  /** A store whose global layer carries one configured harness default. */
  function storeWithOpencodeDefault(): ConfigStore {
    return new ConfigStore(
      memoryIO({
        agent: { defaultModelByHarness: { opencode: OPENCODE_DEFAULT } },
      }).io,
    );
  }

  it("resolves the harness default for a spawn under that harness", () => {
    const store = storeWithOpencodeDefault();

    expect(store.modelFor("general-purpose", null, undefined, "opencode")).toBe(
      OPENCODE_DEFAULT,
    );
  });

  it("leaves a pi spawn alone: pi reads the `default` key, not the harness map", () => {
    const store = new ConfigStore(
      memoryIO({
        agent: {
          default: "anthropic/claude-3",
          defaultModelByHarness: { opencode: OPENCODE_DEFAULT },
        },
      }).io,
    );

    expect(store.modelFor("general-purpose", null, undefined, "pi")).toBe(
      "anthropic/claude-3",
    );
    // The pi family runs one binary: pig and pi-bolt resolve pi's default too.
    expect(store.modelFor("general-purpose", null, undefined, "pig")).toBe(
      "anthropic/claude-3",
    );
  });

  it("resolves the parent for a harness with no default of its own", () => {
    const store = storeWithOpencodeDefault();

    expect(
      store.modelFor("general-purpose", "parent/parent-1", undefined, "pi"),
    ).toBe("parent/parent-1");
  });

  it("lets an agent template's model win over the harness default", () => {
    const store = storeWithOpencodeDefault();

    expect(
      store.modelFor(
        "general-purpose",
        null,
        { modelsByFamily: { opencode: TEMPLATE_MODEL } },
        "opencode",
      ),
    ).toBe(TEMPLATE_MODEL);
  });

  it("reads only the launching family's template model", () => {
    const store = storeWithOpencodeDefault();

    // The template's key is written for pi, whose catalogue it names; the
    // opencode launch reads its own family's entry, which the template leaves
    // unset, so it falls through to opencode's configured default.
    expect(
      store.modelFor(
        "general-purpose",
        null,
        { modelsByFamily: { pi: TEMPLATE_MODEL } },
        "opencode",
      ),
    ).toBe(OPENCODE_DEFAULT);
    expect(
      store.modelFor(
        "general-purpose",
        null,
        { modelsByFamily: { pi: TEMPLATE_MODEL } },
        "pi",
      ),
    ).toBe(TEMPLATE_MODEL);
  });

  it("never hands pi's session default to a foreign harness", () => {
    const store = storeWithOpencodeDefault();
    store.mutate.session.setOverride("default", "session/session-model");

    // `/cowboy model` picks from pi's catalogue, so that key is pi's alone: the
    // opencode launch keeps its own configured default.
    expect(store.modelFor("general-purpose", null, undefined, "opencode")).toBe(
      OPENCODE_DEFAULT,
    );
  });

  it("never hands pi's session default to a plugin harness", () => {
    const store = new ConfigStore(
      memoryIO({
        agent: { defaultModelByHarness: { "runner-plugin": OPENCODE_DEFAULT } },
      }).io,
    );
    store.mutate.session.setOverride("default", "session/session-model");

    expect(
      store.modelFor("general-purpose", null, undefined, "runner-plugin"),
    ).toBe(OPENCODE_DEFAULT);
  });

  it("lets the session default win over pi's own configured default", () => {
    const store = new ConfigStore(
      memoryIO({ agent: { default: "anthropic/claude-3" } }).io,
    );
    store.mutate.session.setOverride("default", "session/session-model");

    expect(store.modelFor("general-purpose", null, undefined, "pi")).toBe(
      "session/session-model",
    );
    // The pi family runs one binary, so pig and pi-bolt read the same default.
    expect(store.modelFor("general-purpose", null, undefined, "pig")).toBe(
      "session/session-model",
    );
  });

  it("lets a per-type override win over the harness default", () => {
    const store = new ConfigStore(
      memoryIO({
        agent: {
          auditor: "anthropic/claude-3",
          defaultModelByHarness: { opencode: OPENCODE_DEFAULT },
        },
      }).io,
    );

    expect(store.modelFor("auditor", null, undefined, "opencode")).toBe(
      "anthropic/claude-3",
    );
  });

  it("resolves the session harness default over the configured one", () => {
    const store = storeWithOpencodeDefault();
    store.mutate.agent.setHarnessDefaultModel(
      "opencode",
      "session/session-model",
      "session",
    );

    expect(store.modelFor("general-purpose", null, undefined, "opencode")).toBe(
      "session/session-model",
    );
  });

  it("reads a session null as no session entry: the configured default answers", () => {
    const store = storeWithOpencodeDefault();
    store.mutate.agent.setHarnessDefaultModel("opencode", null, "session");

    expect(store.modelFor("general-purpose", null, undefined, "opencode")).toBe(
      OPENCODE_DEFAULT,
    );
    expect(store.harnessDefaultModelLevels("opencode").session).toBe(false);
  });

  it("reads a null entry as no default, falling through to the parent", () => {
    const store = new ConfigStore(
      memoryIO({
        agent: {
          default: "anthropic/claude-3",
          defaultModelByHarness: { opencode: null },
        },
      }).io,
    );

    expect(
      store.modelFor(
        "general-purpose",
        "parent/parent-1",
        undefined,
        "opencode",
      ),
    ).toBeNull();
  });

  it("never hands the parent's pi key to an opencode launch", () => {
    // The parent session runs pi, so its key names pi's catalogue: nothing but
    // a pi-family launch can inherit it, whatever the chain resolved.
    const store = new ConfigStore(memoryIO({}).io);

    expect(
      store.modelFor(
        "general-purpose",
        "parent/parent-1",
        undefined,
        "opencode",
      ),
    ).toBeNull();
    // The pi family keeps inheriting it — same store, same parent, pi harness.
    expect(
      store.modelFor("general-purpose", "parent/parent-1", undefined, "pi"),
    ).toBe("parent/parent-1");
  });

  it("carries the configured opencode default rather than the parent's model", () => {
    const store = storeWithOpencodeDefault();

    expect(
      store.modelFor(
        "general-purpose",
        "parent/parent-1",
        undefined,
        "opencode",
      ),
    ).toBe(OPENCODE_DEFAULT);
  });
});

describe("defaultModelByHarness — store setters", () => {
  it("persists one harness at the global layer and reads it back", () => {
    const memory = memoryIO({});
    const store = new ConfigStore(memory.io);

    store.mutate.agent.setHarnessDefaultModel(
      "opencode",
      "openai/gpt-4o",
      "global",
    );

    expect(memory.savedGlobal.at(-1)?.agent?.defaultModelByHarness).toEqual({
      opencode: "openai/gpt-4o",
    });
    expect(store.defaultModelForHarness("opencode")).toBe("openai/gpt-4o");
    expect(store.harnessDefaultModelLevels("opencode").global).toBe(true);
  });

  it("writes entry-wise, so one harness never drops another's entry", () => {
    const memory = memoryIO({
      agent: { defaultModelByHarness: { pig: "anthropic/claude-3" } },
    });
    const store = new ConfigStore(memory.io);

    store.mutate.agent.setHarnessDefaultModel(
      "opencode",
      "openai/gpt-4o",
      "global",
    );

    expect(memory.savedGlobal.at(-1)?.agent?.defaultModelByHarness).toEqual({
      pig: "anthropic/claude-3",
      opencode: "openai/gpt-4o",
    });
  });

  it("writes to the project layer when asked, without touching the global file", () => {
    const memory = memoryIO({}, {});
    const store = new ConfigStore(memory.io);

    store.mutate.agent.setHarnessDefaultModel(
      "opencode",
      "openai/gpt-4o",
      "project",
    );

    expect(memory.savedProject.at(-1)?.agent?.defaultModelByHarness).toEqual({
      opencode: "openai/gpt-4o",
    });
    expect(memory.savedGlobal).toEqual([]);
    expect(store.harnessDefaultModelLevels("opencode").project).toBe(true);
    expect(store.harnessDefaultModelLevels("opencode").global).toBe(false);
  });

  it("keeps a session write in memory and out of session overrides' type map", () => {
    const memory = memoryIO({});
    const store = new ConfigStore(memory.io);

    store.mutate.agent.setHarnessDefaultModel(
      "opencode",
      "openai/gpt-4o",
      "session",
    );

    expect(memory.savedGlobal).toEqual([]);
    expect(store.harnessDefaultModelLevels("opencode").session).toBe(true);
    expect(store.defaultModelForHarness("opencode")).toBe("openai/gpt-4o");
  });

  it("clears a session entry at the session layer only", () => {
    const memory = memoryIO({
      agent: { defaultModelByHarness: { opencode: "openai/gpt-4" } },
    });
    const store = new ConfigStore(memory.io);

    store.mutate.agent.setHarnessDefaultModel(
      "opencode",
      "openai/gpt-4o",
      "session",
    );
    store.mutate.agent.clearHarnessDefaultModel("opencode", "session");

    expect(store.harnessDefaultModelLevels("opencode").session).toBe(false);
    // The file layer is untouched, so the global entry shows through again.
    expect(store.defaultModelForHarness("opencode")).toBe("openai/gpt-4");
  });

  it("drops the map entirely when its last entry is cleared", () => {
    const memory = memoryIO({
      agent: { defaultModelByHarness: { opencode: "openai/gpt-4" } },
    });
    const store = new ConfigStore(memory.io);

    store.mutate.agent.clearHarnessDefaultModel("opencode", "global");

    expect(memory.savedGlobal.at(-1)?.agent).not.toHaveProperty(
      "defaultModelByHarness",
    );
    expect(store.harnessDefaultModelLevels("opencode").global).toBe(false);
    expect(store.defaultModelForHarness("opencode")).toBeNull();
  });

  it("keeps the map when another harness still has an entry", () => {
    const memory = memoryIO({
      agent: {
        defaultModelByHarness: {
          opencode: "openai/gpt-4",
          pig: "anthropic/claude-3",
        },
      },
    });
    const store = new ConfigStore(memory.io);

    store.mutate.agent.clearHarnessDefaultModel("opencode", "global");

    expect(memory.savedGlobal.at(-1)?.agent?.defaultModelByHarness).toEqual({
      pig: "anthropic/claude-3",
    });
  });

  it("clears the session's harness defaults with the session's model overrides", () => {
    const memory = memoryIO({});
    const store = new ConfigStore(memory.io);
    store.mutate.agent.setHarnessDefaultModel(
      "opencode",
      "openai/gpt-4o",
      "session",
    );

    store.mutate.agent.clearAllModelOverrides("session");

    expect(store.harnessDefaultModelLevels("opencode").session).toBe(false);
    expect(store.modelSettingsLevels().session).toBe(false);
  });

  it("clears the map with all model overrides, like any other model key", () => {
    const memory = memoryIO({
      agent: {
        defaultModelByHarness: { opencode: "openai/gpt-4" },
        harnessType: "pig",
      },
    });
    const store = new ConfigStore(memory.io);

    store.mutate.agent.clearAllModelOverrides("global");

    const written = memory.savedGlobal.at(-1)?.agent;
    expect(written).not.toHaveProperty("defaultModelByHarness");
    // A non-model key survives the sweep.
    expect(written?.harnessType).toBe("pig");
  });

  it("drops session harness defaults on reload", () => {
    const store = new ConfigStore(memoryIO({}).io);
    store.mutate.agent.setHarnessDefaultModel(
      "opencode",
      "openai/gpt-4o",
      "session",
    );

    store.reload();

    expect(store.harnessDefaultModelLevels("opencode").session).toBe(false);
    expect(store.defaultModelForHarness("opencode")).toBeNull();
  });
});

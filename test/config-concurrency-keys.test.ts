/**
 * config-concurrency-keys.test.ts — harness-qualified concurrency keys end to
 * end through the config layer: per-entry validation (a bad qualifier drops
 * only its own entry), the layer merge, and the store's per-layer getters and
 * mutate API for the new `harnesses` level.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigStore } from "../src/config/config-store.js";
import { mergeLayers } from "../src/config/config-io.js";
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

describe("concurrency keys — file validation", () => {
  it("keeps the harness level, bare keys, and qualified provider/model keys", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const cleaned = validateRawLayer(
      {
        concurrency: {
          default: 3,
          harnesses: { opencode: 2, pig: 1 },
          providers: { anthropic: 4, "opencode:google": 1 },
          models: {
            "anthropic/claude-3": 2,
            "opencode:google/gemini-2": 1,
          },
        },
      },
      "config.json",
    );

    expect(warn).not.toHaveBeenCalled();
    expect(cleaned.concurrency).toEqual({
      default: 3,
      harnesses: { opencode: 2, pig: 1 },
      providers: { anthropic: 4, "opencode:google": 1 },
      models: {
        "anthropic/claude-3": 2,
        "opencode:google/gemini-2": 1,
      },
    });
  });

  it("keeps a qualifier the built-in vocabulary does not know, since a plugin harness id is valid", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const cleaned = validateRawLayer(
      {
        concurrency: {
          models: {
            "cow:foo/bar": 1,
            "opencode:foo/bar": 2,
            "plain/model": 3,
          },
        },
      },
      "config.json",
    );

    // The qualifier vocabulary is open: only the shape (a non-empty id before
    // the first "/") is checked, so a plugin harness's key survives validation.
    expect(cleaned.concurrency?.models).toEqual({
      "cow:foo/bar": 1,
      "opencode:foo/bar": 2,
      "plain/model": 3,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("drops a model key with an empty provider or model half", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const cleaned = validateRawLayer(
      {
        concurrency: {
          models: {
            "opencode:": 1,
            "opencode:foo/": 2,
            "opencode:/bar": 3,
            "ok/model": 4,
          },
        },
      },
      "config.json",
    );

    expect(cleaned.concurrency?.models).toEqual({ "ok/model": 4 });
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it('rejects a model key such as "provider/model" in the providers map', () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const cleaned = validateRawLayer(
      {
        concurrency: {
          providers: { anthropic: 1, "opencode:google/gemini-2": 2 },
        },
      },
      "config.json",
    );

    expect(cleaned.concurrency?.providers).toEqual({ anthropic: 1 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain(
      "concurrency.providers.opencode:google/gemini-2",
    );
  });

  it("keeps a colon inside a model id as part of the key", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const cleaned = validateRawLayer(
      {
        concurrency: {
          models: { "anthropic/claude-3:beta": 1 },
        },
      },
      "config.json",
    );

    expect(warn).not.toHaveBeenCalled();
    expect(cleaned.concurrency?.models).toEqual({
      "anthropic/claude-3:beta": 1,
    });
  });

  it("keeps a harness key the built-in vocabulary does not know, since a plugin harness id is valid", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const cleaned = validateRawLayer(
      { concurrency: { harnesses: { cow: 1, opencode: 2 } } },
      "config.json",
    );

    expect(cleaned.concurrency?.harnesses).toEqual({ cow: 1, opencode: 2 });
    expect(warn).not.toHaveBeenCalled();
  });

  it("drops an empty harness key", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const cleaned = validateRawLayer(
      { concurrency: { harnesses: { "": 1, opencode: 2 } } },
      "config.json",
    );

    expect(cleaned.concurrency?.harnesses).toEqual({ opencode: 2 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain("concurrency.harnesses.");
  });

  it("drops a non-number harness limit", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const cleaned = validateRawLayer(
      { concurrency: { harnesses: { opencode: "two" } } },
      "config.json",
    );

    expect(cleaned.concurrency?.harnesses).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain("concurrency.harnesses.opencode");
  });

  it.each([0, -1, 1.5, Number.NaN])(
    "drops a non-positive-integer default (%s) while keeping the valid entries",
    (bad) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      const cleaned = validateRawLayer(
        {
          concurrency: {
            default: bad,
            harnesses: { opencode: 2 },
          },
        },
        "config.json",
      );

      expect(cleaned.concurrency?.default).toBeUndefined();
      expect(cleaned.concurrency?.harnesses).toEqual({ opencode: 2 });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toContain("concurrency.default");
      expect(warn.mock.calls[0]![0]).toContain("positive integer");
    },
  );

  it("drops a non-positive-integer harness entry and keeps the valid one", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const cleaned = validateRawLayer(
      { concurrency: { harnesses: { pi: 0, opencode: 2 } } },
      "config.json",
    );

    expect(cleaned.concurrency?.harnesses).toEqual({ opencode: 2 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain("concurrency.harnesses.pi");
    expect(warn.mock.calls[0]![0]).toContain("positive integer");
  });

  it("drops non-positive-integer provider and model entries entry-wise", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const cleaned = validateRawLayer(
      {
        concurrency: {
          providers: { anthropic: 0, "opencode:google": 2 },
          models: { "anthropic/claude-3": 1.5, "ok/model": 3 },
        },
      },
      "config.json",
    );

    expect(cleaned.concurrency?.providers).toEqual({ "opencode:google": 2 });
    expect(cleaned.concurrency?.models).toEqual({ "ok/model": 3 });
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0]![0]).toContain("concurrency.providers.anthropic");
    expect(warn.mock.calls[1]![0]).toContain(
      "concurrency.models.anthropic/claude-3",
    );
  });
});

describe("concurrency keys — layer merge", () => {
  it("merges the harness level per entry, project over global", () => {
    const merged = mergeLayers(
      {
        concurrency: {
          harnesses: { opencode: 1, pig: 2 },
          models: { "anthropic/claude-3": 2 },
        },
      },
      {
        concurrency: {
          harnesses: { opencode: 5 },
          models: { "opencode:google/gemini-2": 1 },
        },
      },
    );

    expect(merged.concurrency).toEqual({
      harnesses: { opencode: 5, pig: 2 },
      models: {
        "anthropic/claude-3": 2,
        "opencode:google/gemini-2": 1,
      },
    });
  });
});

describe("concurrency keys — store", () => {
  it("merges the harness level across the session and file layers", () => {
    const { io } = memoryIO({
      concurrency: { harnesses: { opencode: 2 } },
    });
    const store = new ConfigStore(io);

    expect(store.concurrency.harnesses).toEqual({ opencode: 2 });

    store.mutate.concurrency.setHarness("pi", 3, "session");
    expect(store.concurrency.harnesses).toEqual({ opencode: 2, pi: 3 });
    expect(store.sessionConcurrency.harnesses).toEqual({ pi: 3 });
    expect(store.globalConcurrency.harnesses).toEqual({ opencode: 2 });

    store.mutate.concurrency.removeHarness("pi", "session");
    expect(store.concurrency.harnesses).toEqual({ opencode: 2 });
  });

  it("persists a harness limit and re-syncs the running config", () => {
    const { io, savedGlobal } = memoryIO({});
    const store = new ConfigStore(io);

    store.mutate.concurrency.setHarness("opencode", 2);
    expect(savedGlobal.at(-1)?.concurrency).toEqual({
      harnesses: { opencode: 2 },
    });
    expect(store.concurrency.harnesses).toEqual({ opencode: 2 });
  });

  it("keeps a bare pi key and a qualified key as independent entries", () => {
    const { io } = memoryIO({
      concurrency: {
        models: {
          "anthropic/claude-3": 2,
          "opencode:anthropic/claude-3": 3,
        },
      },
    });
    const store = new ConfigStore(io);

    expect(store.concurrency.models).toEqual({
      "anthropic/claude-3": 2,
      "opencode:anthropic/claude-3": 3,
    });

    store.mutate.concurrency.removeModel("anthropic/claude-3", "global");
    expect(store.concurrency.models).toEqual({
      "opencode:anthropic/claude-3": 3,
    });
  });

  it("treats a harness entry as a concurrency setting for the layer flags", () => {
    const { io } = memoryIO({
      concurrency: { harnesses: { opencode: 2 } },
    });
    const store = new ConfigStore(io);

    expect(store.hasGlobalConcurrencySettings).toBe(true);
  });

  it("carries the harness level through clearAll for its own layer", () => {
    const { io, savedGlobal } = memoryIO({
      agent: { extensionEnabled: false },
      concurrency: { harnesses: { opencode: 2 } },
    });
    const store = new ConfigStore(io);

    store.mutate.concurrency.clearAll("global");

    expect(savedGlobal.at(-1)).toEqual({ agent: { extensionEnabled: false } });
  });

  it.each([
    ["setDefault", [0]],
    ["setHarness", ["opencode", 0]],
    ["setProvider", ["anthropic", -2]],
    ["setModel", ["anthropic/claude-3", 1.5]],
  ] as const)(
    "%s rejects a non-positive-integer limit without persisting",
    (method, args) => {
      const { io, savedGlobal } = memoryIO({});
      const store = new ConfigStore(io);

      expect(() => {
        if (method === "setDefault") {
          store.mutate.concurrency.setDefault(args[0]);
        } else if (method === "setHarness") {
          store.mutate.concurrency.setHarness(args[0], args[1]);
        } else if (method === "setProvider") {
          store.mutate.concurrency.setProvider(args[0], args[1]);
        } else {
          store.mutate.concurrency.setModel(args[0], args[1]);
        }
      }).toThrow(RangeError);

      expect(savedGlobal).toHaveLength(0);
      expect(store.concurrency.default).toBe(4);
      expect(store.concurrency.harnesses).toEqual({});
      expect(store.concurrency.providers).toEqual({});
      expect(store.concurrency.models).toEqual({});
    },
  );

  it("rejects a session-targeted bad limit without touching the session layer", () => {
    const { io } = memoryIO({});
    const store = new ConfigStore(io);

    expect(() =>
      store.mutate.concurrency.setHarness("pi", 0, "session"),
    ).toThrow(/positive integer/);
    expect(store.sessionConcurrency.harnesses).toBeUndefined();
    expect(store.concurrency.harnesses).toEqual({});
  });
});

describe("concurrency keys — a whitespace-only harness qualifier", () => {
  it("drops a pool key whose qualifier is only whitespace", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const cleaned = validateRawLayer(
      {
        concurrency: {
          models: { "   :foo/bar": 1, "opencode:foo/bar": 2 },
          providers: { "  :anthropic": 1, opencode: 2 },
        },
      },
      "config.json",
    );

    // A qualifier that is not a non-empty id is no qualifier: the key is dropped
    // rather than attributed to a harness named "   ".
    expect(cleaned.concurrency?.models).toEqual({ "opencode:foo/bar": 2 });
    expect(cleaned.concurrency?.providers).toEqual({ opencode: 2 });
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});

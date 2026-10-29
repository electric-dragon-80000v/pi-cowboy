/**
 * opencode-config.test.ts — OpenCode's own config slice through the generic
 * harness config layer: the codec's validation, the raw shape the file loader
 * keeps, the post-plugin validation pass, and the global-only scope.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigStore } from "../src/config/config-store.js";
import {
  type ConfigIO,
  type LoadedConfig,
  type RawConfig,
} from "../src/config/config-io.js";
import { validateRawLayer } from "../src/config/config-validation.js";
import { probed } from "../src/availability.js";
import {
  opencodeConfigCodec,
  type OpencodeConfig,
} from "../src/agents/harness/opencode/config.js";
import type {
  HarnessConfigCodec,
  HarnessConfigIssue,
  HarnessConfigLayers,
  PluginHarness,
} from "../src/agents/harness.js";
import {
  createHarnessRegistry,
  type HarnessRegistry,
} from "../src/agents/harness/harness-registry.js";
import { loadedStore } from "./helpers/loaded-store.js";

afterEach(() => {
  vi.restoreAllMocks();
});

/** In-memory ConfigIO: the store never touches the filesystem. */
function memoryIO(
  global: RawConfig,
  project: RawConfig | null = null,
): ConfigIO {
  return {
    load: (): LoadedConfig => ({
      global: structuredClone(global),
      project: project === null ? null : structuredClone(project),
      projectStatus: project === null ? "untrusted" : "loaded",
    }),
    isGlobalWritable: () => true,
    paths: () => ({ global: "config.json" }),
    saveGlobal: () => {},
    saveProject: () => {},
  };
}

/** A store over the two raw layers; validating them is a separate step. */
function storeWith(
  global: RawConfig,
  project: RawConfig | null = null,
): ConfigStore {
  return loadedStore(memoryIO(global, project));
}

/** A plugin harness carrying only what the registry validates. */
function pluginHarness(id: string, config: HarnessConfigCodec): PluginHarness {
  return {
    id,
    displayName: id,
    config,
    agentMultiplexerKind: "pi",
    availability: () => ({ status: "available" }),
    prepare: async () => {},
    buildArgs: () => [],
    teardown: async () => {},
    listModels: async () => ({ kind: "listed", entries: [] }),
    prefetchModels: () => {},
  };
}

/** The built-in registry, validated against the store's raw layers. */
function validateStore(
  store: ConfigStore,
  plugins: readonly PluginHarness[] = [],
): HarnessRegistry {
  const registry = createHarnessRegistry();
  for (const plugin of plugins) registry.register(plugin);
  registry.validateConfigs(store.harnessConfigLayers(), (id, issue) =>
    store.reportHarnessConfigIssue(id, issue),
  );
  return registry;
}

/** The codec's value and the issues it reported for one raw slice. */
function parse(
  global: HarnessConfigLayers["global"],
  project?: HarnessConfigLayers["project"],
): { value: OpencodeConfig; issues: HarnessConfigIssue[] } {
  const issues: HarnessConfigIssue[] = [];
  const value = opencodeConfigCodec.parse({ global, project }, (issue) =>
    issues.push(issue),
  );
  return { value, issues };
}

describe("opencodeConfigCodec — validation", () => {
  it("keeps the excluded roots it names", () => {
    const { value, issues } = parse({
      configInclude: ["agent", "experimental", "update", "autoupdate"],
    });

    expect(value).toEqual({
      configInclude: ["agent", "experimental", "update", "autoupdate"],
    });
    expect(issues).toEqual([]);
  });

  it("drops a path whose root is always copied anyway, keeping the rest", () => {
    const { value, issues } = parse({
      configInclude: ["provider", "model", "instructions", "mcp"],
    });

    // Only the excluded roots are valid values: everything else is already
    // copied, so naming it would claim a control the setting does not have.
    expect(value).toEqual({ configInclude: ["instructions"] });
    expect(issues).toHaveLength(3);
    expect(issues[0]?.keyPath).toBe("configInclude[0]");
    // mcp is copied by default, like a provider, so it is not a control either.
    expect(issues[2]?.keyPath).toBe("configInclude[3]");
  });

  it("drops $schema, a nested path, and a non-string entry", () => {
    const { value, issues } = parse({
      configInclude: ["$schema", "experimental.subagent_depth", "tools", 7],
    });

    expect(value).toEqual({ configInclude: ["tools"] });
    expect(issues).toHaveLength(3);
  });

  it("deduplicates repeated roots", () => {
    expect(parse({ configInclude: ["tools", "tools"] }).value).toEqual({
      configInclude: ["tools"],
    });
  });

  it("rejects a non-array include list", () => {
    const { value, issues } = parse({ configInclude: "mcp" });

    expect(value).toEqual({ configInclude: [] });
    expect(issues).toEqual([
      {
        layer: "global",
        keyPath: "configInclude",
        got: "mcp",
        expected: "array of root keys",
      },
    ]);
  });

  it("defaults to including nothing", () => {
    expect(parse(undefined)).toEqual({
      value: { configInclude: [] },
      issues: [],
    });
  });
});

describe("harness config — the generic layer", () => {
  it("keeps each harness slice as raw data, including ids nothing registered", () => {
    const cleaned = validateRawLayer(
      {
        harness: {
          opencode: { configInclude: ["mcp"] },
          "my-plugin": { enabled: true },
        },
      },
      "config.json",
    );

    expect(cleaned.harness).toEqual({
      opencode: { configInclude: ["mcp"] },
      "my-plugin": { enabled: true },
    });
  });

  it("drops a non-object harness map and a non-object slice", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(
      validateRawLayer({ harness: "opencode" }, "config.json").harness,
    ).toBeUndefined();
    expect(
      validateRawLayer(
        { harness: { opencode: "mcp", tools: {} } },
        "config.json",
      ).harness,
    ).toEqual({ tools: {} });
    expect(warn).toHaveBeenCalledTimes(2);
    const messages = warn.mock.calls.map((call) => String(call[0]));
    expect(
      messages.filter((message) => message.includes("/cowboy menu")),
    ).toEqual([]);
    expect(
      messages.filter((message) =>
        message.includes("Edit or delete the key in that file"),
      ),
    ).toHaveLength(2);
  });

  it("defaults a registered harness with no slice", () => {
    const registry = validateStore(storeWith({}));

    expect(registry.config("opencode")).toEqual({
      configInclude: [],
    });
  });

  it("returns the validated global slice", () => {
    const registry = validateStore(
      storeWith({ harness: { opencode: { configInclude: ["tools"] } } }),
    );

    expect(registry.config("opencode")).toEqual({
      configInclude: ["tools"],
    });
  });

  it("uses the built-in registry's own codec", () => {
    const registry = validateStore(
      storeWith({ harness: { opencode: { configInclude: ["tools"] } } }),
    );

    expect(registry.get("opencode")?.config).toBe(opencodeConfigCodec);
  });

  it("ignores a project slice for a global-only codec", () => {
    const registry = validateStore(
      storeWith({}, { harness: { opencode: { configInclude: ["tools"] } } }),
    );

    expect(registry.config("opencode")).toEqual({
      configInclude: [],
    });
  });

  it("hands both layers to a project-scoped codec", () => {
    const seen: Array<{ global: unknown; project: unknown }> = [];
    const codec: HarnessConfigCodec = {
      scope: "project",
      parse: ({ global, project }) => {
        seen.push({ global, project });
        return { seenGlobal: global, seenProject: project };
      },
    };
    const registry = validateStore(
      storeWith(
        { harness: { "my-plugin": { from: "global" } } },
        { harness: { "my-plugin": { from: "project" } } },
      ),
      [pluginHarness("my-plugin", codec)],
    );

    expect(seen).toEqual([
      { global: { from: "global" }, project: { from: "project" } },
    ]);
    expect(registry.config("my-plugin")).toEqual({
      seenGlobal: { from: "global" },
      seenProject: { from: "project" },
    });
  });

  it("unregisters a harness whose codec throws and keeps validating the rest", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const codec: HarnessConfigCodec = {
      scope: "project",
      parse: () => {
        throw new Error("boom");
      },
    };
    const registry = validateStore(storeWith({}), [
      pluginHarness("throwing", codec),
    ]);

    expect(registry.get("throwing")).toBeUndefined();
    expect(registry.ids()).not.toContain("throwing");
    expect(registry.runnable(probed(["pi", "throwing"]))).not.toContain(
      "throwing",
    );
    expect(registry.resolve("throwing", probed(["pi", "throwing"]))).toBe("pi");
    expect(registry.config("opencode")).toEqual({ configInclude: [] });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('Disabling harness "throwing"');
    expect(warn.mock.calls[0][0]).toContain("boom");
  });

  it("warns with the generic key path and falls back to the codec's default", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const registry = validateStore(
      storeWith({ harness: { opencode: { configInclude: "mcp" } } }),
    );

    expect(registry.config("opencode")).toEqual({
      configInclude: [],
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('"harness.opencode.configInclude"');
    expect(warn.mock.calls[0][0]).not.toContain("/cowboy menu");
    expect(warn.mock.calls[0][0]).toContain(
      "Edit or delete the key in that file to fix it.",
    );
  });

  it("names a configured harness slice in the configured vocabulary", () => {
    const store = storeWith(
      { harness: { "my-plugin": { enabled: true } } },
      { harness: { "project-plugin": { enabled: true } } },
    );

    expect(store.configuredHarnessIds()).toEqual(
      expect.arrayContaining(["my-plugin", "project-plugin"]),
    );
  });

  it("leaves a harness with no codec unconfigured", () => {
    const registry = validateStore(storeWith({}));

    expect(registry.config("pi")).toBeUndefined();
  });
});

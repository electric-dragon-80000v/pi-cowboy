/**
 * config-harness-type.test.ts — the default-harness key end to end through the
 * config layer: validation of file values, the built-in default, the store
 * getter/setter, and its exclusion from project files.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigStore } from "../src/config/config-store.js";
import {
  isProjectAllowedAgentKey,
  mergeDefaults,
} from "../src/config/config-io.js";
import { validateRawLayer } from "../src/config/config-validation.js";
import { DEFAULT_HARNESS } from "../src/agents/harness.js";
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
): { io: ConfigIO; savedGlobal: RawConfig[]; savedProject: RawConfig[] } {
  const savedGlobal: RawConfig[] = [];
  const savedProject: RawConfig[] = [];
  const io: ConfigIO = {
    load: (): LoadedConfig => ({
      global: structuredClone(global),
      project: project === null ? null : structuredClone(project),
      projectStatus: project === null ? "untrusted" : "loaded",
    }),
    isGlobalWritable: () => true,
    saveGlobal: (config) => {
      savedGlobal.push(structuredClone(config));
    },
    saveProject: (config) => {
      savedProject.push(structuredClone(config));
    },
  };
  return { io, savedGlobal, savedProject };
}

describe("harnessType — file validation", () => {
  it.each(["pi", "pig", "pi-bolt"])("keeps the valid harness %s", (value) => {
    const cleaned = validateRawLayer(
      { agent: { harnessType: value } },
      "config.json",
    );

    expect(cleaned.agent?.harnessType).toBe(value);
  });

  it("drops an unknown harness with the expected values in the warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const cleaned = validateRawLayer(
      { agent: { harnessType: "cow" } },
      "config.json",
    );

    expect(cleaned.agent?.harnessType).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain(
      'expected "pi" | "pig" | "pi-bolt"',
    );
    expect(warn.mock.calls[0][0]).toContain('"agent.harnessType"');
  });
});

describe("harnessType — defaults", () => {
  it("bakes the built-in default into a raw config without the key", () => {
    expect(mergeDefaults({}).agent.harnessType).toBe(DEFAULT_HARNESS);
  });

  it("resolves the built-in default when the key is absent", () => {
    const store = new ConfigStore(memoryIO({}).io);

    expect(store.agent.harnessType).toBe("pi");
  });

  it("honors an explicit pig harness", () => {
    const store = new ConfigStore(
      memoryIO({ agent: { harnessType: "pig" } }).io,
    );

    expect(store.agent.harnessType).toBe("pig");
  });

  it("falls back to the built-in default for a value the loader could not validate", () => {
    const store = new ConfigStore(
      memoryIO({ agent: { harnessType: "cow" } }).io,
    );

    expect(store.agent.harnessType).toBe(DEFAULT_HARNESS);
  });
});

describe("harnessType — store setter", () => {
  it("persists at the global layer and reads back", () => {
    const memory = memoryIO({});
    const store = new ConfigStore(memory.io);

    store.mutate.agent.setHarnessType("pig");

    expect(memory.savedGlobal.at(-1)?.agent?.harnessType).toBe("pig");
    expect(memory.savedProject).toEqual([]);
    expect(store.agent.harnessType).toBe("pig");
  });

  it("survives clearing all model overrides (it is a non-model key)", () => {
    const memory = memoryIO({});
    const store = new ConfigStore(memory.io);

    store.mutate.agent.setHarnessType("pig");
    store.mutate.agent.clearAllModelOverrides("global");

    expect(memory.savedGlobal.at(-1)?.agent?.harnessType).toBe("pig");
  });

  it("stays out of the project config allowlist", () => {
    expect(isProjectAllowedAgentKey("harnessType")).toBe(false);
  });
});

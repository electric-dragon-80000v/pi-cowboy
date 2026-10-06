/**
 * config-store-extension-enabled.test.ts — the persisted on/off flag and the
 * indicator flags beside it (the 🤠 marker, and whether the pasture is drawn).
 * Pins: default true when absent, global-layer round-trip, exclusion from
 * project files (not a model key), and survival of "clear all model overrides".
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { ConfigStore } from "../src/config/config-store.js";
import { validateRawLayer } from "../src/config/config-validation.js";
import {
  createConfigIO,
  isProjectAllowedAgentKey,
  mergeLayers,
} from "../src/config/config-io.js";
import type {
  ConfigIO,
  LoadedConfig,
  RawConfig,
} from "../src/config/config-io.js";

interface MemoryIO {
  io: ConfigIO;
  savedGlobal: RawConfig[];
  savedProject: RawConfig[];
}

/** In-memory ConfigIO: records every save so persistence is assertable. */
function memoryIO(
  global: RawConfig,
  project: RawConfig | null = null,
): MemoryIO {
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

describe("extensionEnabled — defaults and persistence", () => {
  it("resolves true when the key is absent", () => {
    const store = new ConfigStore(memoryIO({}).io);

    expect(store.agent.extensionEnabled).toBe(true);
  });

  it("loads a disabled extension from the global layer", () => {
    const store = new ConfigStore(
      memoryIO({ agent: { extensionEnabled: false } }).io,
    );

    expect(store.agent.extensionEnabled).toBe(false);
  });

  it("persists a set at the global layer and reads it back", () => {
    const memory = memoryIO({});
    const store = new ConfigStore(memory.io);

    store.mutate.agent.setExtensionEnabled(false);

    const saved = memory.savedGlobal.at(-1);
    expect(saved?.agent?.extensionEnabled).toBe(false);
    // The flag is global-only.
    expect(memory.savedProject).toEqual([]);

    const reloaded = new ConfigStore(memoryIO(saved ?? {}).io);
    expect(reloaded.agent.extensionEnabled).toBe(false);
  });

  it("survives clearing all model overrides (it is a non-model key)", () => {
    const memory = memoryIO({});
    const store = new ConfigStore(memory.io);

    store.mutate.agent.setExtensionEnabled(false);
    store.mutate.agent.clearAllModelOverrides("global");

    expect(memory.savedGlobal.at(-1)?.agent?.extensionEnabled).toBe(false);
  });

  it("is not a project-layer key, and a project file carrying it does not apply", () => {
    expect(isProjectAllowedAgentKey("extensionEnabled")).toBe(false);
    expect(
      mergeLayers({}, { agent: { extensionEnabled: false } }).agent
        ?.extensionEnabled,
    ).toBeUndefined();

    const root = mkdtempSync(join(tmpdir(), "pi-cowboy-extension-enabled-"));
    const projectDir = join(root, ".pi");
    const projectFile = join(projectDir, "pi-cowboy", "config.json");
    mkdirSync(join(projectDir, "pi-cowboy"), { recursive: true });
    writeFileSync(
      projectFile,
      JSON.stringify({
        agent: { extensionEnabled: false, default: "openai/gpt-4" },
      }),
    );
    // The global layer resolves at call time; keep the read off the developer's agent dir.
    vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
    onTestFinished(() => {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    });

    const loaded = createConfigIO(projectDir).load();

    // The project layer keeps its model key; the effective config drops the flag.
    expect(loaded.project?.agent?.default).toBe("openai/gpt-4");
    const effective = mergeLayers({}, loaded.project);
    expect(effective.agent?.extensionEnabled).toBeUndefined();
    // Dropped, so the default stands.
    expect(
      new ConfigStore(memoryIO({}, loaded.project).io).agent.extensionEnabled,
    ).toBe(true);
  });
});

describe("showActiveIndicator — defaults and persistence", () => {
  it("resolves true when the key is absent", () => {
    const store = new ConfigStore(memoryIO({}).io);

    expect(store.agent.showActiveIndicator).toBe(true);
  });

  it("loads a hidden indicator from the global layer", () => {
    const store = new ConfigStore(
      memoryIO({ agent: { showActiveIndicator: false } }).io,
    );

    expect(store.agent.showActiveIndicator).toBe(false);
  });

  it("persists a set at the global layer and reads it back", () => {
    const memory = memoryIO({});
    const store = new ConfigStore(memory.io);

    store.mutate.agent.setShowActiveIndicator(false);

    const saved = memory.savedGlobal.at(-1);
    expect(saved?.agent?.showActiveIndicator).toBe(false);
    // The flag is global-only.
    expect(memory.savedProject).toEqual([]);

    const reloaded = new ConfigStore(memoryIO(saved ?? {}).io);
    expect(reloaded.agent.showActiveIndicator).toBe(false);
  });

  it("survives clearing all model overrides (it is a non-model key)", () => {
    const memory = memoryIO({});
    const store = new ConfigStore(memory.io);

    store.mutate.agent.setShowActiveIndicator(false);
    store.mutate.agent.clearAllModelOverrides("global");

    expect(memory.savedGlobal.at(-1)?.agent?.showActiveIndicator).toBe(false);
  });

  it("keeps a boolean and drops a wrongly-typed value with a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    onTestFinished(() => warn.mockRestore());

    const kept = validateRawLayer(
      { agent: { showActiveIndicator: false } },
      "config.json",
    );
    expect(kept.agent?.showActiveIndicator).toBe(false);

    const cleaned = validateRawLayer(
      { agent: { showActiveIndicator: "off", includeContextFiles: true } },
      "config.json",
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain("agent.showActiveIndicator");
    expect(cleaned.agent).not.toHaveProperty("showActiveIndicator");
    // A valid sibling key survives the per-value drop.
    expect(cleaned.agent?.includeContextFiles).toBe(true);
  });

  it("is not a project-layer key, and a project file carrying it is dropped", () => {
    expect(isProjectAllowedAgentKey("showActiveIndicator")).toBe(false);
    expect(
      mergeLayers({}, { agent: { showActiveIndicator: false } }).agent
        ?.showActiveIndicator,
    ).toBeUndefined();
    // Dropped, so the default stands.
    expect(
      new ConfigStore(
        memoryIO({}, { agent: { showActiveIndicator: false } }).io,
      ).agent.showActiveIndicator,
    ).toBe(true);
  });
});

describe("grazingEnabled — defaults and persistence", () => {
  it("resolves true when the key is absent", () => {
    const store = new ConfigStore(memoryIO({}).io);

    expect(store.agent.grazingEnabled).toBe(true);
  });

  it("loads a drawn pasture from the global layer", () => {
    const store = new ConfigStore(
      memoryIO({ agent: { grazingEnabled: true } }).io,
    );

    expect(store.agent.grazingEnabled).toBe(true);
  });

  it("persists a set at the global layer and reads it back", () => {
    const memory = memoryIO({});
    const store = new ConfigStore(memory.io);

    store.mutate.agent.setGrazingEnabled(true);

    const saved = memory.savedGlobal.at(-1);
    expect(saved?.agent?.grazingEnabled).toBe(true);
    // The flag is global-only.
    expect(memory.savedProject).toEqual([]);

    const reloaded = new ConfigStore(memoryIO(saved ?? {}).io);
    expect(reloaded.agent.grazingEnabled).toBe(true);
  });

  it("survives clearing all model overrides (it is a non-model key)", () => {
    const memory = memoryIO({});
    const store = new ConfigStore(memory.io);

    store.mutate.agent.setGrazingEnabled(true);
    store.mutate.agent.clearAllModelOverrides("global");

    expect(memory.savedGlobal.at(-1)?.agent?.grazingEnabled).toBe(true);
  });

  it("keeps a boolean and drops a wrongly-typed value with a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    onTestFinished(() => warn.mockRestore());

    const kept = validateRawLayer(
      { agent: { grazingEnabled: true } },
      "config.json",
    );
    expect(kept.agent?.grazingEnabled).toBe(true);

    const cleaned = validateRawLayer(
      { agent: { grazingEnabled: "off", includeContextFiles: true } },
      "config.json",
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain("agent.grazingEnabled");
    expect(cleaned.agent).not.toHaveProperty("grazingEnabled");
    // A valid sibling key survives the per-value drop.
    expect(cleaned.agent?.includeContextFiles).toBe(true);
  });

  it("is not a project-layer key, and a project file carrying it is dropped", () => {
    expect(isProjectAllowedAgentKey("grazingEnabled")).toBe(false);
    expect(
      mergeLayers({}, { agent: { grazingEnabled: true } }).agent
        ?.grazingEnabled,
    ).toBeUndefined();
    // Dropped, so the default stands.
    expect(
      new ConfigStore(memoryIO({}, { agent: { grazingEnabled: true } }).io)
        .agent.grazingEnabled,
    ).toBe(true);
  });
});

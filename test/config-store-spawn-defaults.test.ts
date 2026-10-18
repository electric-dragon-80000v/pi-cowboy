/**
 * config-store-spawn-defaults.test.ts — the two configurable spawn defaults.
 * Pins: built-in defaults when absent, global-layer round-trip, blank values
 * rejected at validation so the fallback applies, and exclusion from project
 * files (not model keys) and from "clear all model overrides".
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigStore } from "../src/config/config-store.js";
import {
  isProjectAllowedAgentKey,
  mergeLayers,
} from "../src/config/config-io.js";
import { validateRawLayer } from "../src/config/config-validation.js";
import { DEFAULT_AGENT_TYPE, DEFAULT_ORCHESTRATOR_NAME } from "../src/types.js";
import type {
  ConfigIO,
  LoadedConfig,
  RawConfig,
} from "../src/config/config-io.js";

afterEach(() => {
  vi.restoreAllMocks();
});

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

describe("spawn default settings — defaults and persistence", () => {
  it("resolves the built-in defaults when the keys are absent", () => {
    const store = new ConfigStore(memoryIO({}).io);

    expect(store.agent.defaultAgentType).toBe(DEFAULT_AGENT_TYPE);
    expect(store.agent.defaultOrchestrator).toBe(DEFAULT_ORCHESTRATOR_NAME);
  });

  it("loads configured values", () => {
    const store = new ConfigStore(
      memoryIO({
        agent: {
          defaultAgentType: "code-reviewer",
          defaultOrchestrator: "planner",
        },
      }).io,
    );

    expect(store.agent.defaultAgentType).toBe("code-reviewer");
    expect(store.agent.defaultOrchestrator).toBe("planner");
  });

  it("rejects blank values at validation, so the fallback applies", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = new ConfigStore(
      memoryIO(
        validateRawLayer(
          { agent: { defaultAgentType: "  ", defaultOrchestrator: "" } },
          "config.json",
        ),
      ).io,
    );

    expect(store.agent.defaultAgentType).toBe(DEFAULT_AGENT_TYPE);
    expect(store.agent.defaultOrchestrator).toBe(DEFAULT_ORCHESTRATOR_NAME);
  });

  it("persists a set at the global layer and reads it back", () => {
    const memory = memoryIO({});
    const store = new ConfigStore(memory.io);

    store.mutate.agent.setDefaultAgentType("code-reviewer");
    store.mutate.agent.setDefaultOrchestrator("planner");

    const saved = memory.savedGlobal.at(-1);
    expect(saved?.agent?.defaultAgentType).toBe("code-reviewer");
    expect(saved?.agent?.defaultOrchestrator).toBe("planner");
    // These settings are global-only.
    expect(memory.savedProject).toEqual([]);

    const reloaded = new ConfigStore(memoryIO(saved ?? {}).io);
    expect(reloaded.agent.defaultAgentType).toBe("code-reviewer");
    expect(reloaded.agent.defaultOrchestrator).toBe("planner");
  });

  it("clears a setting back to the built-in fallback when set to undefined", () => {
    const memory = memoryIO({});
    const store = new ConfigStore(memory.io);

    store.mutate.agent.setDefaultAgentType("code-reviewer");
    store.mutate.agent.setDefaultAgentType(undefined);

    const saved = memory.savedGlobal.at(-1);
    expect(saved?.agent).not.toHaveProperty("defaultAgentType");
    expect(store.agent.defaultAgentType).toBe(DEFAULT_AGENT_TYPE);
  });

  it("survives clearing all model overrides (they are non-model keys)", () => {
    const memory = memoryIO({});
    const store = new ConfigStore(memory.io);

    store.mutate.agent.setDefaultAgentType("code-reviewer");
    store.mutate.agent.setDefaultOrchestrator("planner");
    store.mutate.agent.clearAllModelOverrides("global");

    const saved = memory.savedGlobal.at(-1);
    expect(saved?.agent?.defaultAgentType).toBe("code-reviewer");
    expect(saved?.agent?.defaultOrchestrator).toBe("planner");
  });

  it("keeps them out of the project config allowlist (ADR-0008)", () => {
    expect(isProjectAllowedAgentKey("defaultAgentType")).toBe(false);
    expect(isProjectAllowedAgentKey("defaultOrchestrator")).toBe(false);

    // A project layer carrying them drops the keys at merge time.
    const merged = mergeLayers(
      {},
      {
        agent: {
          defaultAgentType: "code-reviewer",
          defaultOrchestrator: "planner",
        },
      },
    );
    expect(merged.agent?.defaultAgentType).toBeUndefined();
    expect(merged.agent?.defaultOrchestrator).toBeUndefined();
  });
});

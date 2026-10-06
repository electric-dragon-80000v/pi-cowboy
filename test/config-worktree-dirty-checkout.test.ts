/**
 * config-worktree-checkout-type.test.ts — the dirty-checkout key end to end
 * through the config layer: validation of file values, the built-in default, the
 * store getter/setter, and its exclusion from project files.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigStore } from "../src/config/config-store.js";
import {
  isProjectAllowedAgentKey,
  mergeDefaults,
} from "../src/config/config-io.js";
import { validateRawLayer } from "../src/config/config-validation.js";
import { DEFAULT_WORKTREE_CHECKOUT_TYPE } from "../src/spawn/worktree-policy.js";
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

describe("worktreeCheckoutType — file validation", () => {
  it.each(["dirty", "clean"])("keeps the valid policy %s", (value) => {
    const cleaned = validateRawLayer(
      { agent: { worktreeCheckoutType: value } },
      "config.json",
    );

    expect(cleaned.agent?.worktreeCheckoutType).toBe(value);
  });

  it("drops an unknown policy with the expected values in the warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const cleaned = validateRawLayer(
      { agent: { worktreeCheckoutType: "copy-on-write" } },
      "config.json",
    );

    expect(cleaned.agent?.worktreeCheckoutType).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('expected "dirty" | "clean"');
    expect(warn.mock.calls[0][0]).toContain('"agent.worktreeCheckoutType"');
  });
});

describe("worktreeCheckoutType — defaults", () => {
  it("bakes the built-in default into a raw config without the key", () => {
    expect(mergeDefaults({}).agent.worktreeCheckoutType).toBe(
      DEFAULT_WORKTREE_CHECKOUT_TYPE,
    );
  });

  it("resolves the built-in default when the key is absent", () => {
    const store = new ConfigStore(memoryIO({}).io);

    expect(store.agent.worktreeCheckoutType).toBe("clean");
  });

  it("resolves a configured clean policy", () => {
    const store = new ConfigStore(
      memoryIO({ agent: { worktreeCheckoutType: "clean" } }).io,
    );

    expect(store.agent.worktreeCheckoutType).toBe("clean");
  });

  it("honors an explicit dirty policy", () => {
    const store = new ConfigStore(
      memoryIO({ agent: { worktreeCheckoutType: "dirty" } }).io,
    );

    expect(store.agent.worktreeCheckoutType).toBe("dirty");
  });

  it("falls back to the built-in default for a value the loader could not validate", () => {
    const store = new ConfigStore(
      memoryIO({ agent: { worktreeCheckoutType: "nonsense" } }).io,
    );

    expect(store.agent.worktreeCheckoutType).toBe(
      DEFAULT_WORKTREE_CHECKOUT_TYPE,
    );
  });
});

describe("worktreeCheckoutType — store setter", () => {
  it("persists at the global layer and reads back", () => {
    const memory = memoryIO({});
    const store = new ConfigStore(memory.io);

    store.mutate.agent.setWorktreeCheckoutType("clean");

    expect(memory.savedGlobal.at(-1)?.agent?.worktreeCheckoutType).toBe(
      "clean",
    );
    expect(memory.savedProject).toEqual([]);
    expect(store.agent.worktreeCheckoutType).toBe("clean");
  });

  it("survives clearing all model overrides (it is a non-model key)", () => {
    const memory = memoryIO({});
    const store = new ConfigStore(memory.io);

    store.mutate.agent.setWorktreeCheckoutType("clean");
    store.mutate.agent.clearAllModelOverrides("global");

    expect(memory.savedGlobal.at(-1)?.agent?.worktreeCheckoutType).toBe(
      "clean",
    );
  });

  it("stays out of the project config allowlist", () => {
    expect(isProjectAllowedAgentKey("worktreeCheckoutType")).toBe(false);
  });
});

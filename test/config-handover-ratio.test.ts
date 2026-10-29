/**
 * config-handover-ratio.test.ts — the global export-loss limit through config.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MAX_EXCLUDED_RATIO } from "../src/agents/handover.js";
import {
  isProjectAllowedAgentKey,
  mergeDefaults,
  type ConfigIO,
  type LoadedConfig,
  type RawConfig,
} from "../src/config/config-io.js";
import { validateRawLayer } from "../src/config/config-validation.js";
import { loadedStore } from "./helpers/loaded-store.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function memoryIO(global: RawConfig): ConfigIO {
  return {
    load: (): LoadedConfig => ({
      global: structuredClone(global),
      project: null,
      projectStatus: "untrusted",
    }),
    isGlobalWritable: () => true,
    paths: () => ({ global: "config.json" }),
    saveGlobal: () => {},
    saveProject: () => {},
  };
}

describe("handoverMaxExcludedRatio", () => {
  it.each([0, 0.25, 0.5, 1])("keeps the valid share %s", (value) => {
    expect(
      validateRawLayer(
        { agent: { handoverMaxExcludedRatio: value } },
        "config.json",
      ).agent?.handoverMaxExcludedRatio,
    ).toBe(value);
  });

  it("drops an invalid share with file-only remediation", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(
      validateRawLayer(
        { agent: { handoverMaxExcludedRatio: 1.5 } },
        "config.json",
      ).agent?.handoverMaxExcludedRatio,
    ).toBeUndefined();
    expect(String(warn.mock.calls[0]?.[0])).toContain(
      "Edit or delete the key in that file",
    );
  });

  it("defaults to half, resolves a global override, and rejects project use", () => {
    expect(DEFAULT_MAX_EXCLUDED_RATIO).toBe(0.5);
    expect(mergeDefaults({}).agent.handoverMaxExcludedRatio).toBe(0.5);
    expect(
      loadedStore(memoryIO({ agent: { handoverMaxExcludedRatio: 0.2 } })).agent
        .handoverMaxExcludedRatio,
    ).toBe(0.2);
    expect(isProjectAllowedAgentKey("handoverMaxExcludedRatio")).toBe(false);
  });
});

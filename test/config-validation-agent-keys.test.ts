/**
 * config-validation-agent-keys.test.ts — agent key validation per file layer.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { validateRawLayer } from "../src/config/config-validation.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("validateRawLayer — per-type model keys", () => {
  it("drops a per-type model key whose value is not a model", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const cleaned = validateRawLayer(
      { agent: { notARealKey: true } },
      "config.json",
    );

    expect(warn).toHaveBeenCalledTimes(1);
    expect(cleaned.agent).toBeUndefined();
  });
});

describe("validateRawLayer — spawn default keys", () => {
  it("keeps non-empty defaultAgentType and defaultOrchestrator strings", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const cleaned = validateRawLayer(
      {
        agent: {
          defaultAgentType: "code-reviewer",
          defaultOrchestrator: "planner",
        },
      },
      "config.json",
    );

    expect(warn).not.toHaveBeenCalled();
    expect(cleaned.agent?.defaultAgentType).toBe("code-reviewer");
    expect(cleaned.agent?.defaultOrchestrator).toBe("planner");
  });

  it("drops a wrong-typed or blank value with one warning each", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const cleaned = validateRawLayer(
      {
        agent: {
          defaultAgentType: 42,
          defaultOrchestrator: "",
          includeContextFiles: true,
        },
      },
      "config.json",
    );

    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0]![0]).toContain("agent.defaultAgentType");
    expect(warn.mock.calls[1]![0]).toContain("agent.defaultOrchestrator");
    expect(cleaned.agent).not.toHaveProperty("defaultAgentType");
    expect(cleaned.agent).not.toHaveProperty("defaultOrchestrator");
    // A valid sibling key survives the per-value drop.
    expect(cleaned.agent?.includeContextFiles).toBe(true);
  });
});

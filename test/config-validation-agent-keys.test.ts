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

describe("validateRawLayer — harness env overrides", () => {
  it("keeps a valid entry and drops the reserved, unreadable and unquotable ones", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const cleaned = validateRawLayer(
      {
        harness: {
          codex: {
            env: {
              MY_FLAG: "1",
              PATH: "/evil",
              "not-a-name": "x",
              MESSAGE: "a\nb",
              COUNT: 2,
            },
          },
        },
      },
      "config.json",
    );

    expect(cleaned.harness?.codex.env).toEqual({ MY_FLAG: "1" });
    expect(warn).toHaveBeenCalledTimes(4);
    expect(warn.mock.calls[0]![0]).toContain("harness.codex.env.PATH");
    expect(warn.mock.calls[1]![0]).toContain("harness.codex.env.not-a-name");
    expect(warn.mock.calls[2]![0]).toContain("harness.codex.env.MESSAGE");
    expect(warn.mock.calls[3]![0]).toContain("harness.codex.env.COUNT");
  });

  it("drops an env table that is not an object and keeps the rest of the section", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const cleaned = validateRawLayer(
      { harness: { codex: { env: "MY_FLAG=1" } } },
      "config.json",
    );

    expect(warn).toHaveBeenCalledTimes(1);
    expect(cleaned.harness?.codex).not.toHaveProperty("env");
  });
});

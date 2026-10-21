/**
 * config-thinking-levels.test.ts — thinking levels end to end through the
 * config layer: per-entry validation, the per-entry layer merge, the store's
 * resolution over those layers, and the chain that picks one.
 *
 * The chain is the same ranked-candidate walk the model chain uses, over a
 * shorter list of layers. It returns the winning level as written: a token is
 * one harness's vocabulary, so no layer here rewrites it to suit a model.
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
import {
  harnessDefaultThinking,
  resolveThinking,
  type SubagentsConfig,
} from "../src/models/model-precedence.js";

afterEach(() => {
  vi.restoreAllMocks();
});

/** In-memory ConfigIO over the layers a case hands in. */
function memoryIO(
  global: RawConfig,
  project: RawConfig | null = null,
): { io: ConfigIO } {
  const io: ConfigIO = {
    load: (): LoadedConfig => ({
      global: structuredClone(global),
      project: project === null ? null : structuredClone(project),
      projectStatus: project === null ? "absent" : "loaded",
    }),
    isGlobalWritable: () => true,
    paths: () => ({ global: "config.json" }),
    saveGlobal: () => {},
    saveProject: () => {},
  };
  return { io };
}

/** The config slice a chain case hands `resolveThinking`, with pi's default set to none. */
function configWith(
  agent: Partial<SubagentsConfig["agent"]>,
): Pick<SubagentsConfig, "agent"> {
  return { agent: { default: null, ...agent } };
}

describe("thinking maps — file validation", () => {
  it("keeps a token per entry, null included", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const cleaned = validateRawLayer(
      {
        agent: {
          defaultThinkingByHarness: {
            opencode: "high",
            codex: "ultra",
            claude: null,
          },
          thinking: { auditor: "xhigh", reviewer: null },
        },
      },
      "config.json",
    );

    expect(cleaned.agent?.defaultThinkingByHarness).toEqual({
      opencode: "high",
      codex: "ultra",
      claude: null,
    });
    expect(cleaned.agent?.thinking).toEqual({
      auditor: "xhigh",
      reviewer: null,
    });
  });

  it("drops a blank or non-string token, keeping every other entry", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const cleaned = validateRawLayer(
      { agent: { thinking: { blank: "   ", numeric: 3, kept: "low" } } },
      "config.json",
    );

    expect(cleaned.agent?.thinking).toEqual({ kept: "low" });
    // One warning per dropped entry, naming the key that carried it.
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls.map((call) => call[0]).join("\n")).toContain(
      "agent.thinking.blank",
    );
  });

  it("reads an empty table as absent, so no layer joins the chain", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const cleaned = validateRawLayer(
      { agent: { thinking: {}, defaultThinkingByHarness: {} } },
      "config.json",
    );

    expect(cleaned.agent).toBeUndefined();
  });
});

describe("thinking maps — layer merge", () => {
  it("merges per type, so a project entry never drops global's others", () => {
    const merged = mergeLayers(
      { agent: { thinking: { auditor: "low", reviewer: "high" } } },
      { agent: { thinking: { auditor: "max" } } },
    );

    expect(merged.agent?.thinking).toEqual({
      auditor: "max",
      reviewer: "high",
    });
  });

  it("merges per harness too", () => {
    const merged = mergeLayers(
      {
        agent: {
          defaultThinkingByHarness: { opencode: "low", codex: "high" },
        },
      },
      { agent: { defaultThinkingByHarness: { opencode: "max" } } },
    );

    expect(merged.agent?.defaultThinkingByHarness).toEqual({
      opencode: "max",
      codex: "high",
    });
  });
});

describe("resolveThinking — the chain", () => {
  const base = {
    subagentType: "auditor",
    config: configWith({}),
    harnessDefault: null,
  };

  it("prefers the session per-type token over every layer below it", () => {
    expect(
      resolveThinking({
        ...base,
        config: configWith({ thinking: { auditor: "low" } }),
        agentConfig: { thinkingByFamily: { pi: "medium" } },
        harnessDefault: "high",
        sessionThinking: { auditor: "max" },
      }),
    ).toBe("max");
  });

  it("prefers the config per-type token over the template's", () => {
    expect(
      resolveThinking({
        ...base,
        config: configWith({ thinking: { auditor: "low" } }),
        agentConfig: { thinkingByFamily: { pi: "medium" } },
        harnessDefault: "high",
      }),
    ).toBe("low");
  });

  it("reads only the launching family's template token", () => {
    expect(
      resolveThinking({
        ...base,
        harnessFamily: "opencode",
        agentConfig: { thinkingByFamily: { pi: "low", opencode: "max" } },
      }),
    ).toBe("max");
    // A pi token contributes nothing to an opencode launch.
    expect(
      resolveThinking({
        ...base,
        harnessFamily: "opencode",
        agentConfig: { thinkingByFamily: { pi: "low" } },
      }),
    ).toBeUndefined();
  });

  it("falls through to the harness default, and to nothing when it has none", () => {
    expect(resolveThinking({ ...base, harnessDefault: "high" })).toBe("high");
    expect(resolveThinking(base)).toBeUndefined();
  });

  it("reports which layer won", () => {
    expect(
      resolveThinking({
        ...base,
        harnessDefault: "high",
        sessionThinking: { auditor: "low" },
      }),
    ).toBe("low");
  });

  it("reads a session null as no session entry, leaving the files to answer", () => {
    expect(
      resolveThinking({
        ...base,
        config: configWith({ thinking: { auditor: "low" } }),
        sessionThinking: { auditor: null },
      }),
    ).toBe("low");
  });
});

describe("harnessDefaultThinking", () => {
  it("reads the pi family's one default, and each other harness's own entry", () => {
    const agent = {
      defaultThinking: "low" as const,
      defaultThinkingByHarness: { opencode: "max" },
    };

    expect(harnessDefaultThinking(agent, "pi")).toBe("low");
    expect(harnessDefaultThinking(agent, "pig")).toBe("low");
    expect(harnessDefaultThinking(agent, "opencode")).toBe("max");
    // A harness with no entry has no default; the chain falls through.
    expect(harnessDefaultThinking(agent, "codex")).toBeNull();
  });
});

describe("ConfigStore — per-type thinking overrides", () => {
  it("resolves the project token over the global one, entry by entry", () => {
    const store = new ConfigStore(
      memoryIO(
        { agent: { thinking: { auditor: "low", reviewer: "max" } } },
        { agent: { thinking: { auditor: "high" } } },
      ).io,
    );

    expect(store.thinkingFor("auditor", undefined, "pi")).toBe("high");
    expect(store.thinkingFor("reviewer", undefined, "pi")).toBe("max");
    expect(store.thinkingFor("scribe", undefined, "pi")).toBeUndefined();
  });
});

describe("ConfigStore — per-harness default thinking", () => {
  it("reads the pi family's defaultThinking and every other harness's entry", () => {
    const store = new ConfigStore(
      memoryIO({
        agent: {
          defaultThinking: "low",
          defaultThinkingByHarness: { opencode: "max" },
        },
      }).io,
    );

    expect(store.defaultThinkingForHarness("pi")).toBe("low");
    expect(store.defaultThinkingForHarness("opencode")).toBe("max");
    expect(store.defaultThinkingForHarness("codex")).toBeNull();
  });

  it("feeds the chain's last step, which the template's own token beats", () => {
    const store = new ConfigStore(
      memoryIO({ agent: { defaultThinking: "low" } }).io,
    );

    expect(
      store.thinkingFor("auditor", { thinkingByFamily: { pi: "high" } }, "pi"),
    ).toBe("high");
    expect(store.thinkingFor("auditor", undefined, "pi")).toBe("low");
  });
});

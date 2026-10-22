/**
 * config-thinking-levels.test.ts — thinking levels end to end through the
 * config layer: per-entry validation, the per-entry layer merge, the store's
 * resolution over those layers, and the chain that picks one.
 *
 * The chain is the same ranked-candidate walk the model chain uses, over a
 * shorter list of layers: the parent session's level is the last step, and only
 * a pi-family launch reads it. It returns the winning level as written: a token
 * is one harness's vocabulary, so no layer here rewrites it to suit a model.
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
  resolveThinkingSource,
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

  it("falls through to the parent's level for the pi family only", () => {
    expect(
      resolveThinking({
        ...base,
        harnessFamily: "pi",
        parentThinking: "high",
      }),
    ).toBe("high");
    // The parent's level is pi's, so a foreign launch never reads it.
    expect(
      resolveThinking({
        ...base,
        harnessFamily: "opencode",
        parentThinking: "high",
      }),
    ).toBeUndefined();
  });

  it("keeps every configured layer above the parent's level", () => {
    expect(
      resolveThinking({
        ...base,
        harnessFamily: "pi",
        config: configWith({ thinking: { auditor: "low" } }),
        harnessDefault: "medium",
        parentThinking: "high",
      }),
    ).toBe("low");
    expect(
      resolveThinking({
        ...base,
        harnessFamily: "pi",
        harnessDefault: "medium",
        parentThinking: "high",
      }),
    ).toBe("medium");
  });

  it("reports the parent as the winning chain position", () => {
    expect(
      resolveThinkingSource({
        ...base,
        harnessFamily: "pi",
        parentThinking: "high",
      }),
    ).toEqual({ value: "high", source: "parent" });
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

/** In-memory ConfigIO that records every save, so persistence is assertable. */
function recordingIO(
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

describe("ConfigStore — per-type thinking writers", () => {
  it("writes one type's token entry-wise, keeping the others", () => {
    const { io, savedGlobal } = recordingIO({
      agent: { thinking: { auditor: "low" } },
    });
    const store = new ConfigStore(io);

    store.mutate.agent.setThinkingOverride("scribe", "high", "global");

    expect(savedGlobal.at(-1)?.agent?.thinking).toEqual({
      auditor: "low",
      scribe: "high",
    });
  });

  it("writes a null as a real mask at a file layer", () => {
    const { io, savedProject } = recordingIO(
      { agent: { thinking: { auditor: "low" } } },
      {},
    );
    const store = new ConfigStore(io);

    store.mutate.agent.setThinkingOverride("auditor", null, "project");

    expect(savedProject.at(-1)?.agent?.thinking).toEqual({ auditor: null });
    expect(store.thinkingOverrideLevels("auditor")).toEqual({
      session: false,
      global: true,
      project: true,
    });
  });

  it("clears one layer's entry, dropping the table with its last entry", () => {
    const { io, savedGlobal } = recordingIO({
      agent: { thinking: { auditor: "low", scribe: "max" } },
    });
    const store = new ConfigStore(io);

    store.mutate.agent.clearThinkingOverride("scribe", "global");
    expect(savedGlobal.at(-1)?.agent?.thinking).toEqual({ auditor: "low" });

    store.mutate.agent.clearThinkingOverride("auditor", "global");
    expect(savedGlobal.at(-1)?.agent?.thinking).toBeUndefined();
    expect(store.thinkingOverrideLevels("auditor").global).toBe(false);
  });

  it("unpins the session on a null instead of masking it", () => {
    const { io } = recordingIO({});
    const store = new ConfigStore(io);

    store.mutate.agent.setThinkingOverride("auditor", "low", "session");
    expect(store.sessionThinkingOverride("auditor")).toBe("low");

    store.mutate.agent.setThinkingOverride("auditor", null, "session");
    expect(store.sessionThinkingOverride("auditor")).toBeNull();
    expect(store.thinkingOverrideLevels("auditor").session).toBe(false);
  });
});

describe("ConfigStore — per-harness default thinking writers", () => {
  it("writes one harness's entry, keeping the others, and clears it alone", () => {
    const { io, savedGlobal } = recordingIO({
      agent: { defaultThinkingByHarness: { codex: "low" } },
    });
    const store = new ConfigStore(io);

    store.mutate.agent.setHarnessDefaultThinking("opencode", "max", "global");
    expect(savedGlobal.at(-1)?.agent?.defaultThinkingByHarness).toEqual({
      codex: "low",
      opencode: "max",
    });

    store.mutate.agent.clearHarnessDefaultThinking("codex", "global");
    expect(savedGlobal.at(-1)?.agent?.defaultThinkingByHarness).toEqual({
      opencode: "max",
    });

    // The table goes with its last entry.
    store.mutate.agent.clearHarnessDefaultThinking("opencode", "global");
    expect(savedGlobal.at(-1)?.agent?.defaultThinkingByHarness).toBeUndefined();
  });

  it("keeps one session slot for the whole pi family", () => {
    const { io } = recordingIO({});
    const store = new ConfigStore(io);

    store.mutate.agent.setHarnessDefaultThinking("pi", "high", "session");

    // Every pi-family id reads the same slot; another harness reads its own.
    expect(store.defaultThinkingForHarness("pi")).toBe("high");
    expect(store.defaultThinkingForHarness("pig")).toBe("high");
    expect(store.defaultThinkingForHarness("pi-bolt")).toBe("high");
    expect(store.defaultThinkingForHarness("opencode")).toBeNull();
    expect(store.harnessDefaultThinkingLevels("pi-bolt").session).toBe(true);
  });

  it("reads a session null as no session entry, leaving the files to answer", () => {
    const { io } = recordingIO({ agent: { defaultThinking: "low" } });
    const store = new ConfigStore(io);

    store.mutate.agent.setHarnessDefaultThinking("pi", null, "session");

    expect(store.defaultThinkingForHarness("pig")).toBe("low");
    expect(store.harnessDefaultThinkingLevels("pig").session).toBe(false);
  });

  it("reports which layers carry a default: pi's scalar, or the table's entry", () => {
    const { io } = recordingIO(
      {
        agent: {
          defaultThinking: "low",
          defaultThinkingByHarness: { opencode: null },
        },
      },
      { agent: { defaultThinkingByHarness: { opencode: "high" } } },
    );
    const store = new ConfigStore(io);

    expect(store.harnessDefaultThinkingLevels("pi")).toEqual({
      session: false,
      global: true,
      project: false,
    });
    // A null entry is a mask a file layer carries, so the layer counts.
    expect(store.harnessDefaultThinkingLevels("opencode")).toEqual({
      session: false,
      global: true,
      project: true,
    });
  });
});

describe("ConfigStore — Clear-all covers thinking alone", () => {
  it("offers Clear-all for a file holding only agent.thinking, and clears the table", () => {
    const { io, savedGlobal } = recordingIO({
      agent: { thinking: { auditor: "low" } },
    });
    const store = new ConfigStore(io);

    expect(store.modelSettingsLevels().global).toBe(true);
    expect(store.modelSettingsLevels().project).toBe(false);

    store.mutate.agent.clearAllModelOverrides("global");

    expect(savedGlobal.at(-1)?.agent?.thinking).toBeUndefined();
    expect(store.modelSettingsLevels().global).toBe(false);
  });

  it("does not offer a session level for an unpinned thinking default", () => {
    const { io } = recordingIO({});
    const store = new ConfigStore(io);

    store.mutate.agent.setHarnessDefaultThinking("pi", null, "session");

    expect(store.modelSettingsLevels().session).toBe(false);
  });
});

describe("ConfigStore — the pi family's file default is the scalar", () => {
  it("writes agent.defaultThinking for a pi-family id, never its table entry", () => {
    const { io, savedGlobal } = recordingIO({});
    const store = new ConfigStore(io);

    // pig shares pi's slot and pi's scalar: a table entry here would persist a
    // key no launch ever reads.
    store.mutate.agent.setHarnessDefaultThinking("pig", "high", "global");

    expect(savedGlobal.at(-1)?.agent).toEqual({ defaultThinking: "high" });
    expect(store.defaultThinkingForHarness("pi-bolt")).toBe("high");

    store.mutate.agent.clearHarnessDefaultThinking("pig", "global");
    expect(savedGlobal.at(-1)?.agent?.defaultThinking).toBeUndefined();
    expect(store.defaultThinkingForHarness("pi")).toBeNull();
  });

  it("refuses a token the scalar's own level list does not name", () => {
    const { io } = recordingIO({});
    const store = new ConfigStore(io);

    expect(() =>
      store.mutate.agent.setHarnessDefaultThinking("pi", "absolute", "global"),
    ).toThrow(RangeError);
  });
});

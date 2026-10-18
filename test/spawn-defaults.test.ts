/** spawn-defaults.test.ts — omitted-param resolution with a mocked store and the real registries (config-store/validation halves live in their own suites). */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "../src/agents/types.js";
import type { OrchestratorConfig } from "../src/orchestrators/types.js";
import { registerAgents } from "../src/agents/agent-types.js";
import { registerOrchestrators } from "../src/orchestrators/orchestrator-types.js";
import { DEFAULT_ORCHESTRATORS } from "../src/orchestrators/default-orchestrators.js";
import {
  requestedHarnessId,
  resolveAgentTypeParam,
  resolveDefaultAgentType,
  resolveDefaultOrchestrator,
  resolveDefaultOrchestratorName,
  resolveHarnessType,
  resolveRequestedHarness,
  resolveWorktreeCheckoutType,
} from "../src/agents/spawn-defaults.js";
import { probed, unprobed, type Availability } from "../src/availability.js";
import {
  HARNESS_IDS,
  type HarnessId,
  type PluginHarness,
} from "../src/agents/harness.js";
import {
  harnessFamilyOf,
  registerHarness,
} from "../src/agents/harness/registry.js";

/** A registered-only harness: this file is about resolution, not availability. */
function pluginHarness(id: string): PluginHarness {
  return {
    id,
    displayName: id,
    agentMultiplexerKind: id,
    availability: () => ({ status: "available" }),
    prepare: async () => {},
    buildArgs: () => [],
    teardown: async () => {},
    listModels: async () => [],
    prefetchModels: () => {},
  };
}

const { configured } = vi.hoisted(() => ({
  configured: {} as {
    defaultAgentType?: unknown;
    defaultOrchestrator?: unknown;
    worktreeCheckoutType?: unknown;
    harnessType?: unknown;
    harnessAvailability?: unknown;
  },
}));

vi.mock("../src/shell.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/shell.js")>()),
  getStore: () => ({ agent: configured }),
  getHarnessAvailability: () =>
    configured.harnessAvailability as Availability<HarnessId>,
}));

function agent(name: string): AgentConfig {
  return {
    name,
    description: `${name} agent`,
    systemPrompt: "",
  };
}

function orchestrator(name: string): OrchestratorConfig {
  return {
    name,
    guidance: "",
    cues: { spawned: "spawned", queued: "queued", settled: "settled" },
  };
}

beforeEach(() => {
  configured.defaultAgentType = undefined;
  configured.defaultOrchestrator = undefined;
  configured.worktreeCheckoutType = "dirty";
  configured.harnessType = "pi";
  configured.harnessAvailability = unprobed();
  // Disabled built-ins keep "no longer resolves" unambiguous; the capitalized name proves canonicalization.
  registerAgents(
    new Map<string, AgentConfig>([
      ["general-purpose", agent("general-purpose")],
      ["Code-Reviewer", agent("Code-Reviewer")],
      [
        "clean-start",
        { ...agent("clean-start"), worktreeCheckoutType: "clean" },
      ],
      [
        "dirty-start",
        { ...agent("dirty-start"), worktreeCheckoutType: "dirty" },
      ],
      ["harness-pig", { ...agent("harness-pig"), harnessType: "pig" }],
    ]),
    { disableDefaultAgents: true },
  );
  registerOrchestrators(new Map([["Custom", orchestrator("Custom")]]));
});

describe("spawn-defaults — worktree dirty-checkout policy", () => {
  it("lets the template's key win over the config setting", () => {
    configured.worktreeCheckoutType = "dirty";
    expect(resolveWorktreeCheckoutType("clean-start")).toBe("clean");

    configured.worktreeCheckoutType = "clean";
    expect(resolveWorktreeCheckoutType("dirty-start")).toBe("dirty");
  });

  it("falls back to the config setting when the template omits the key", () => {
    configured.worktreeCheckoutType = "clean";
    expect(resolveWorktreeCheckoutType("general-purpose")).toBe("clean");

    configured.worktreeCheckoutType = "dirty";
    expect(resolveWorktreeCheckoutType("general-purpose")).toBe("dirty");
  });

  it("falls back to the config setting when the type does not resolve", () => {
    configured.worktreeCheckoutType = "clean";

    expect(resolveWorktreeCheckoutType("ghost-type")).toBe("clean");
  });

  it("resolves the template case-insensitively, like every other type lookup", () => {
    configured.worktreeCheckoutType = "dirty";

    expect(resolveWorktreeCheckoutType("Clean-Start")).toBe("clean");
  });
});

describe("spawn-defaults — harness", () => {
  it("lets the template's harness_type win over the config setting", () => {
    configured.harnessType = "pi";
    expect(resolveHarnessType("harness-pig")).toBe("pig");

    configured.harnessType = "pig";
    expect(resolveHarnessType("harness-pig")).toBe("pig");
  });

  it("falls back to the config setting when the template omits harness_type", () => {
    configured.harnessType = "pig";
    expect(resolveHarnessType("general-purpose")).toBe("pig");

    configured.harnessType = "pi";
    expect(resolveHarnessType("general-purpose")).toBe("pi");
  });

  it("falls back to the config setting when the type does not resolve", () => {
    configured.harnessType = "pig";

    expect(resolveHarnessType("ghost-type")).toBe("pig");
  });

  it("resolves the template case-insensitively, like every other type lookup", () => {
    configured.harnessType = "pi";

    expect(resolveHarnessType("Harness-Pig")).toBe("pig");
  });

  it("falls back to pi when the machine cannot launch the configured harness", () => {
    configured.harnessType = "pi-bolt";
    configured.harnessAvailability = probed<HarnessId>(["pi", "pig"]);

    expect(resolveHarnessType("general-purpose")).toBe("pi");
    // The template named one the machine has: availability narrows nothing here.
    expect(resolveHarnessType("harness-pig")).toBe("pig");
  });

  it("falls back to pi when the template names a harness the machine cannot launch", () => {
    configured.harnessType = "pi";
    configured.harnessAvailability = probed<HarnessId>(["pi"]);

    expect(resolveHarnessType("harness-pig")).toBe("pi");
  });

  it("resolves a plugin harness the machine can launch, and falls back from one it cannot", () => {
    // A plugin harness is a value like any other: registered means resolvable,
    // and an unproven one falls back exactly as a built-in does.
    registerHarness(pluginHarness("sd-plugin"));
    configured.harnessType = "sd-plugin";

    configured.harnessAvailability = probed(["sd-plugin"]);
    expect(resolveHarnessType("general-purpose")).toBe("sd-plugin");

    configured.harnessAvailability = probed(["pi"]);
    expect(resolveHarnessType("general-purpose")).toBe("pi");
  });

  it("lets the caller's harness_type win over both the template and the config setting", () => {
    configured.harnessType = "pi";

    expect(resolveHarnessType("harness-pig", "opencode")).toBe("opencode");
  });

  it("uses an explicit harness as-is, skipping the availability fallback the config path applies", () => {
    // Validation happens at parse; the resolver is handed a valid id and does not re-narrow it.
    configured.harnessType = "pi";
    configured.harnessAvailability = probed<HarnessId>(["pi"]);

    expect(resolveHarnessType("general-purpose", "opencode")).toBe("opencode");
  });

  it.each(["pi", "pig", "pi-bolt"] as const)(
    "keys the %s launch on the pi family, which shares pi's model catalogue",
    (harness) => {
      configured.harnessAvailability = unprobed();
      configured.harnessType = harness;

      expect(harnessFamilyOf(resolveHarnessType("general-purpose"))).toBe("pi");
    },
  );

  it("keys the opencode launch on its own family", () => {
    configured.harnessAvailability = unprobed();
    configured.harnessType = "opencode";

    expect(harnessFamilyOf(resolveHarnessType("general-purpose"))).toBe(
      "opencode",
    );
  });
});

describe("spawn-defaults — the caller's explicit harness_type", () => {
  it("resolves a harness this machine can launch", () => {
    configured.harnessAvailability = probed<HarnessId>(["pi", "pig"]);

    expect(resolveRequestedHarness("pig")).toBe("pig");
  });

  it("reads null and blank as unset, never as an unknown id", () => {
    expect(resolveRequestedHarness(null)).toBeUndefined();
    expect(resolveRequestedHarness("")).toBeUndefined();
    expect(resolveRequestedHarness("   ")).toBeUndefined();
  });

  it("refuses an unknown id, naming the valid ones and that nothing was spawned", () => {
    expect(() => resolveRequestedHarness("ghost")).toThrow(
      `Unknown harness_type "ghost": valid harnesses are ${HARNESS_IDS.join(", ")}. Nothing was spawned`,
    );
  });

  it("refuses a harness this machine cannot launch, naming what it can", () => {
    configured.harnessAvailability = probed<HarnessId>(["pi"]);

    expect(() => resolveRequestedHarness("opencode")).toThrow(
      'Harness "opencode" cannot be launched on this machine — this machine can launch pi. Nothing was spawned',
    );
  });

  it("leaves a bad value alone at the tool boundary instead of throwing", () => {
    configured.harnessAvailability = probed<HarnessId>(["pi"]);

    expect(requestedHarnessId("pi")).toBe("pi");
    expect(requestedHarnessId("ghost")).toBeUndefined();
    expect(requestedHarnessId("opencode")).toBeUndefined();
    expect(requestedHarnessId(null)).toBeUndefined();
  });
});

describe("spawn-defaults — configured default agent type", () => {
  it("degrades an unset, empty, or whitespace-only configured type to general-purpose", () => {
    configured.defaultAgentType = undefined;
    expect(resolveDefaultAgentType()).toBe("general-purpose");

    configured.defaultAgentType = "";
    expect(resolveDefaultAgentType()).toBe("general-purpose");

    configured.defaultAgentType = "   ";
    expect(resolveDefaultAgentType()).toBe("general-purpose");
  });

  it("resolves a valid configured type to its canonical registered key", () => {
    configured.defaultAgentType = "Code-Reviewer";
    expect(resolveDefaultAgentType()).toBe("Code-Reviewer");

    configured.defaultAgentType = "code-reviewer";
    expect(resolveDefaultAgentType()).toBe("Code-Reviewer");
  });

  it("degrades a configured type that no longer resolves to general-purpose", () => {
    configured.defaultAgentType = "ghost-type";
    expect(resolveDefaultAgentType()).toBe("general-purpose");
  });

  it("lets an explicit agent_type win and passes it through verbatim for the listener's resolution", () => {
    configured.defaultAgentType = "Code-Reviewer";

    // Explicit passes through verbatim: registry validation owns the error.
    expect(resolveAgentTypeParam("researcher")).toBe("researcher");
    expect(resolveAgentTypeParam("ghost-type")).toBe("ghost-type");

    // Omitted/null/empty/non-string fall back to the configured default.
    expect(resolveAgentTypeParam(undefined)).toBe("Code-Reviewer");
    expect(resolveAgentTypeParam("")).toBe("Code-Reviewer");
    expect(resolveAgentTypeParam(null)).toBe("Code-Reviewer");
    expect(resolveAgentTypeParam(7)).toBe("Code-Reviewer");
  });
});

describe("spawn-defaults — configured default orchestrator", () => {
  it("degrades an unset, empty, whitespace-only, or unregistered configured name to default", () => {
    configured.defaultOrchestrator = undefined;
    expect(resolveDefaultOrchestratorName()).toBe("default");

    configured.defaultOrchestrator = "";
    expect(resolveDefaultOrchestratorName()).toBe("default");

    configured.defaultOrchestrator = "   ";
    expect(resolveDefaultOrchestratorName()).toBe("default");

    configured.defaultOrchestrator = "ghost-orchestrator";
    expect(resolveDefaultOrchestratorName()).toBe("default");

    configured.defaultOrchestrator = "Custom";
    expect(resolveDefaultOrchestratorName()).toBe("Custom");
  });

  it("resolves a case-insensitive configured orchestrator to the registered config", () => {
    configured.defaultOrchestrator = "custom";

    const resolved = resolveDefaultOrchestrator();

    expect(resolved.name).toBe("Custom");
  });

  it("resolves the configured default over the code fallback", () => {
    configured.defaultOrchestrator = "Custom";

    expect(resolveDefaultOrchestrator().name).toBe("Custom");
    expect(resolveDefaultOrchestratorName()).toBe("Custom");
  });

  it("degrades a configured orchestrator that no longer resolves to the code default", () => {
    configured.defaultOrchestrator = "ghost-orchestrator";

    const resolved = resolveDefaultOrchestrator();

    expect(resolved).toBe(DEFAULT_ORCHESTRATORS.default);
    expect(resolved.name).toBe("default");
  });

  it("backs `default` with the code fallback when the registry was never populated", () => {
    registerOrchestrators(new Map(), { disableDefaultOrchestrators: true });

    const resolved = resolveDefaultOrchestrator();

    expect(resolved).toBe(DEFAULT_ORCHESTRATORS.default);
    expect(resolved.name).toBe("default");
  });
});

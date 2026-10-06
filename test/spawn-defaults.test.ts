/** spawn-defaults.test.ts — omitted-param resolution with a mocked store and the real registries (config-store/validation halves live in their own suites). */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "../src/agents/types.js";
import type { OrchestratorConfig } from "../src/orchestrators/types.js";
import { registerAgents } from "../src/agents/agent-types.js";
import { registerOrchestrators } from "../src/orchestrators/orchestrator-types.js";
import { DEFAULT_ORCHESTRATORS } from "../src/orchestrators/default-orchestrators.js";
import {
  resolveAgentTypeParam,
  resolveDefaultAgentType,
  resolveDefaultOrchestrator,
  resolveDefaultOrchestratorName,
  resolveHarnessType,
  resolveWorktreeCheckoutType,
} from "../src/agents/spawn-defaults.js";
import { probed, unprobed, type Availability } from "../src/availability.js";
import type { HarnessId } from "../src/agents/harness.js";

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

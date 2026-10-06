/** tool-steer.test.ts — the steer_cowboy_agent batch boundary: whole-call guards, per-item outcomes, and input-order reporting (lifecycle: subagent-session/agent-manager suites). */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentSpawn } from "../src/types.js";
import type { SteerOutcome } from "../src/agents/agent-manager.js";
import type { SteerBatchParams } from "../src/agents/schemas/steer-batch.schema.js";
import type { ToolResult } from "../src/agents/tool-result.js";
import type { SteerItemOutcome } from "../src/agents/tool-steer.js";

const { getManagerMock } = vi.hoisted(() => ({ getManagerMock: vi.fn() }));

vi.mock("../src/shell.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/shell.js")>();
  return { ...actual, getManager: getManagerMock, getPiInstance: () => ({}) };
});

const { executeSteerAgentTool } = await import("../src/agents/tool-steer.js");
const { registerTools } = await import("../src/registration.js");

const ID_A = "a1b2c3d4";
const ID_B = "e5f6a7b8";

function spawnWith(id: string, lifecycle: AgentSpawn["lifecycle"]): AgentSpawn {
  return {
    id,
    lifecycle,
    display: {
      type: "general-purpose",
      description: "Fix the login flow",
    },
  } as unknown as AgentSpawn;
}

function spawnedSpawn(id: string): AgentSpawn {
  return spawnWith(id, { phase: "spawned", startedAt: 1 });
}

function settledSpawn(id: string): AgentSpawn {
  return spawnWith(id, {
    phase: "settled",
    startedAt: 1,
    status: "completed",
    result: "done",
    completedAt: 2,
  });
}

interface FakeManager {
  getSpawn(id: string): AgentSpawn | undefined;
  steer(id: string, message: string): Promise<SteerOutcome>;
  listAgents(phases: readonly string[]): AgentSpawn[];
  steered: Array<[string, string]>;
}

function installManager(
  spawns: Record<string, AgentSpawn>,
  outcome: SteerOutcome | ((id: string) => SteerOutcome),
): FakeManager {
  const steered: Array<[string, string]> = [];
  const manager: FakeManager = {
    getSpawn: (id) => spawns[id],
    steer: async (id, message) => {
      steered.push([id, message]);
      return typeof outcome === "function" ? outcome(id) : outcome;
    },
    listAgents: () => Object.values(spawns),
    steered,
  };
  getManagerMock.mockReset().mockReturnValue(manager);
  return manager;
}

beforeEach(() => {
  getManagerMock.mockReset();
});

function steer(
  params: SteerBatchParams,
): Promise<ToolResult<{ agents: SteerItemOutcome[] }>> {
  return executeSteerAgentTool(
    "call-1",
    params,
    undefined,
    undefined,
    {} as never,
  );
}

function text(result: ToolResult<{ agents: SteerItemOutcome[] }>): string {
  return result.content.map((block) => block.text).join("\n");
}

describe("executeSteerAgentTool — whole-call guards", () => {
  it("rejects a repeated id before delivering anything", async () => {
    const manager = installManager(
      { [ID_A]: spawnedSpawn(ID_A) },
      {
        kind: "delivered",
      },
    );

    await expect(
      steer({ agent_ids: [ID_A, ID_B, ID_A], message: "hello" }),
    ).rejects.toThrow(/duplicate agent ids.*a1b2c3d4.*No item was handled/);
    expect(manager.steered).toEqual([]);
  });

  it("throws when message is missing or blank, delivering nothing", async () => {
    const manager = installManager(
      { [ID_A]: spawnedSpawn(ID_A) },
      {
        kind: "delivered",
      },
    );

    await expect(steer({ agent_ids: [ID_A], message: "" })).rejects.toThrow(
      /message is required/,
    );
    await expect(steer({ agent_ids: [ID_A], message: "   " })).rejects.toThrow(
      /message is required/,
    );
    expect(manager.steered).toEqual([]);
  });
});

describe("executeSteerAgentTool — batch", () => {
  it("delivers one message to every id in input order", async () => {
    const manager = installManager(
      { [ID_A]: spawnedSpawn(ID_A), [ID_B]: spawnedSpawn(ID_B) },
      { kind: "delivered" },
    );

    const result = await steer({
      agent_ids: [ID_A, ID_B],
      message: " wrap up ",
    });

    expect(manager.steered).toEqual([
      [ID_A, "wrap up"],
      [ID_B, "wrap up"],
    ]);
    expect(text(result)).toBe(
      [
        `Message delivered to spawned agent ${ID_A}. Delivery is fire-and-forget — the agent picks it up on its next turn; its next completion message will report the result.`,
        `Message delivered to spawned agent ${ID_B}. Delivery is fire-and-forget — the agent picks it up on its next turn; its next completion message will report the result.`,
      ].join("\n\n---\n\n"),
    );
    expect(result.details.agents).toEqual([
      { kind: "delivered", agentId: ID_A },
      { kind: "delivered", agentId: ID_B },
    ]);
  });

  it("reports that a settled agent was revived", async () => {
    const spawn = settledSpawn(ID_A);
    // The real session revives inside steer, re-projecting the lifecycle to
    // spawned before it returns.
    installManager({ [ID_A]: spawn }, () => {
      spawn.lifecycle = { phase: "spawned", startedAt: 1 };
      return { kind: "delivered" };
    });

    const result = await steer({
      agent_ids: [ID_A],
      message: "keep going",
    });

    const body = text(result);
    expect(body).toContain("had settled (completed)");
    expect(body).toContain("revived");
    expect(body).toContain("Merge nothing yet");
    expect(result.details.agents).toEqual([
      { kind: "delivered", agentId: ID_A },
    ]);
  });

  it("does not claim a revival when delivery left the agent un-revived", async () => {
    const spawn = spawnWith(ID_A, {
      phase: "never-started",
      queuedAt: 1,
      status: "stopped",
      completedAt: 2,
      stop: { initiator: "user" },
    });
    installManager({ [ID_A]: spawn }, { kind: "delivered" });

    const result = await steer({ agent_ids: [ID_A], message: "keep going" });

    expect(text(result)).toContain("but it was not revived");
    expect(text(result)).not.toContain("spawned again");
  });

  it("reports a refusal with both the state and the reason, and still steers the rest", async () => {
    const manager = installManager(
      { [ID_A]: settledSpawn(ID_A), [ID_B]: spawnedSpawn(ID_B) },
      (id) =>
        id === ID_A
          ? { kind: "refused", reason: "agent has no pane (it was cleaned up)" }
          : { kind: "delivered" },
    );

    const result = await steer({ agent_ids: [ID_A, ID_B], message: "hello" });

    expect(manager.steered).toEqual([
      [ID_A, "hello"],
      [ID_B, "hello"],
    ]);
    const body = text(result);
    expect(body).toContain(
      `Agent ${ID_A} was not steered (completed): agent has no pane (it was cleaned up)`,
    );
    expect(body).toContain(`Message delivered to spawned agent ${ID_B}`);
    expect(body).toContain("\n\n---\n\n");
    expect(result.details.agents).toEqual([
      {
        kind: "refused",
        agentId: ID_A,
        reason: "agent has no pane (it was cleaned up)",
      },
      { kind: "delivered", agentId: ID_B },
    ]);
  });

  it("reports a steer that threw as a refusal and still steers the rest", async () => {
    const manager = installManager(
      { [ID_A]: spawnedSpawn(ID_A), [ID_B]: spawnedSpawn(ID_B) },
      { kind: "delivered" },
    );
    manager.steer = async (id: string) => {
      if (id === ID_A) throw new Error("host unavailable");
      return { kind: "delivered" };
    };

    const result = await steer({ agent_ids: [ID_A, ID_B], message: "hello" });

    const body = text(result);
    expect(body).toContain("steering failed: host unavailable");
    expect(body).toContain(`Message delivered to spawned agent ${ID_B}`);
    expect(result.details.agents).toEqual([
      {
        kind: "refused",
        agentId: ID_A,
        reason: "steering failed: host unavailable",
      },
      { kind: "delivered", agentId: ID_B },
    ]);
  });

  it("reports a revive that failed as delivered but not revived", async () => {
    installManager(
      { [ID_A]: settledSpawn(ID_A) },
      {
        kind: "delivered-not-revived",
        reason: "the agent could not be revived: EACCES",
      },
    );

    const result = await steer({ agent_ids: [ID_A], message: "keep going" });

    const body = text(result);
    expect(body).toContain("had settled (completed)");
    expect(body).toContain("was not revived");
    expect(body).not.toContain("spawned again");
    expect(result.details.agents).toEqual([
      {
        kind: "delivered-not-revived",
        agentId: ID_A,
        reason: "the agent could not be revived: EACCES",
      },
    ]);
  });

  it("reports an id no spawn carries as data and still steers the rest", async () => {
    const manager = installManager(
      { [ID_B]: spawnedSpawn(ID_B) },
      {
        kind: "delivered",
      },
    );

    const result = await steer({ agent_ids: [ID_A, ID_B], message: "hello" });

    expect(manager.steered).toEqual([[ID_B, "hello"]]);
    const body = text(result);
    expect(body).toContain(
      `Agent ${ID_A} was not steered: not found. Active agents:`,
    );
    expect(body).not.toContain("delivered to spawned agent a1b2c3d4");
    expect(result.details.agents[0]).toEqual({
      kind: "refused",
      agentId: ID_A,
      reason: expect.stringContaining("not found"),
    });
    expect(result.details.agents[1]).toEqual({
      kind: "delivered",
      agentId: ID_B,
    });
  });
});

describe("steer_cowboy_agent registration", () => {
  function captureTool(name: string) {
    const tools: Array<{
      name: string;
      description: string;
      parameters: {
        properties?: Record<string, unknown>;
        required?: string[];
        additionalProperties?: boolean;
      };
      constrainedSampling?: unknown;
    }> = [];
    registerTools({
      registerTool: (tool: unknown) => tools.push(tool as never),
      registerMessageRenderer: () => {},
      registerCommand: () => {},
    } as unknown as ExtensionAPI);
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new Error(`tool ${name} was not registered`);
    return tool;
  }

  it("takes agent_ids + message, nothing else", () => {
    const tool = captureTool("steer_cowboy_agent");
    const ids = tool.parameters.properties?.agent_ids as
      | { type?: string; minItems?: number; items?: { type?: string } }
      | undefined;
    expect(ids?.type).toBe("array");
    expect(ids?.minItems).toBe(1);
    expect(ids?.items?.type).toBe("string");
    expect(Object.keys(tool.parameters.properties ?? {}).sort()).toEqual([
      "agent_ids",
      "message",
    ]);
    expect(tool.parameters.required).toEqual(["agent_ids", "message"]);
    expect(tool.parameters.additionalProperties).toBe(false);
    expect(tool.constrainedSampling).toEqual({
      type: "json_schema",
      strict: "prefer",
    });
  });

  it("documents the batch, revival, fire-and-forget delivery, and every refusal", () => {
    const tool = captureTool("steer_cowboy_agent");
    expect(tool.description).toContain("`agent_ids`");
    expect(tool.description).toMatch(/independently/);
    expect(tool.description).toContain("single `message`");
    expect(tool.description).toContain("spawned");
    expect(tool.description).toContain("SETTLED");
    expect(tool.description).toContain("REVIVED");
    expect(tool.description).toContain("fire-and-forget");
    expect(tool.description).toContain("no pane yet");
    expect(tool.description).toContain("QUEUED");
    // Every refusal the handler can return is named in the description.
    expect(tool.description).toContain("pane is gone (cleaned up)");
    expect(tool.description).toContain("TORN DOWN");
    expect(tool.description).toContain("states its reason");
    // The revived turn reports only through its completion message.
    expect(tool.description).toContain(
      "result promise closed with the first turn",
    );
  });
});

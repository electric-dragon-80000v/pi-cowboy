/** tool-stop-batch.test.ts — the stop_cowboy_agent batch boundary: whole-call guards, per-item outcomes, and input-order reporting (abort itself: subagent-session.test.ts). */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSpawn } from "../src/types.js";
import type { ToolResult } from "../src/agents/tool-result.js";
import type { StopBatchParams } from "../src/agents/schemas/stop-batch.schema.js";
import type { StopItemOutcome } from "../src/agents/tool-execution.js";

const { getManagerMock } = vi.hoisted(() => ({ getManagerMock: vi.fn() }));

vi.mock("../src/shell.js", () => ({ getManager: getManagerMock }));

const { executeStopAgentTool } =
  await import("../src/agents/tool-execution.js");

const ID_A = "a1b2c3d4";
const ID_B = "e5f6a7b8";
const ID_C = "c3d4e5f6";

function spawnedSpawn(id: string): AgentSpawn {
  return {
    id,
    lifecycle: { phase: "spawned", startedAt: 1 },
    display: { type: "general-purpose" },
  } as AgentSpawn;
}

function settledSpawn(id: string): AgentSpawn {
  return {
    id,
    lifecycle: {
      phase: "settled",
      startedAt: 1,
      status: "completed",
      result: "done",
      completedAt: 2,
    },
    display: { type: "general-purpose" },
  } as AgentSpawn;
}

interface FakeManager {
  getSpawn: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
  listAgents: ReturnType<typeof vi.fn>;
}

function fakeManager(
  spawns: Record<string, AgentSpawn | undefined>,
  abortImpl?: (id: string) => Promise<boolean>,
): FakeManager {
  return {
    getSpawn: vi.fn((id: string) => spawns[id]),
    abort: vi.fn(async (id: string) => (abortImpl ? abortImpl(id) : true)),
    listAgents: vi.fn(() => []),
  };
}

async function invoke(
  params: StopBatchParams,
): Promise<ToolResult<{ agents: StopItemOutcome[] }>> {
  return executeStopAgentTool(
    "call-1",
    params,
    undefined,
    undefined,
    {} as never,
  );
}

function text(result: ToolResult<{ agents: StopItemOutcome[] }>): string {
  return result.content.map((block) => block.text).join("\n");
}

beforeEach(() => {
  getManagerMock.mockReset();
});

describe("executeStopAgentTool — whole-call guards", () => {
  it("rejects a repeated id before stopping anything", async () => {
    const manager = fakeManager({ [ID_A]: spawnedSpawn(ID_A) });
    getManagerMock.mockReturnValue(manager);

    await expect(invoke({ agent_ids: [ID_A, ID_B, ID_A] })).rejects.toThrow(
      /duplicate agent ids.*a1b2c3d4.*No item was handled/,
    );
    expect(manager.abort).not.toHaveBeenCalled();
  });
});

describe("executeStopAgentTool — batch", () => {
  it("stops every id in one call, one line per id in input order", async () => {
    const manager = fakeManager({
      [ID_A]: spawnedSpawn(ID_A),
      [ID_B]: spawnedSpawn(ID_B),
    });
    getManagerMock.mockReturnValue(manager);

    const result = await invoke({ agent_ids: [ID_A, ID_B] });

    expect(manager.abort).toHaveBeenCalledTimes(2);
    expect(manager.abort).toHaveBeenNthCalledWith(1, ID_A, "agent");
    expect(manager.abort).toHaveBeenNthCalledWith(2, ID_B, "agent");
    expect(text(result)).toBe(
      [`Stopped agent ${ID_A}`, `Stopped agent ${ID_B}`].join("\n\n---\n\n"),
    );
    expect(result.details.agents).toEqual([
      { kind: "stopped", agentId: ID_A },
      { kind: "stopped", agentId: ID_B },
    ]);
  });

  it("reports an unknown id as data and still stops the rest", async () => {
    const manager = fakeManager({ [ID_B]: spawnedSpawn(ID_B) });
    getManagerMock.mockReturnValue(manager);

    const result = await invoke({ agent_ids: [ID_A, ID_B] });

    expect(manager.abort).toHaveBeenCalledTimes(1);
    expect(manager.abort).toHaveBeenCalledWith(ID_B, "agent");
    expect(text(result)).toBe(
      [
        `Agent ${ID_A} not found. Active agents: none`,
        `Stopped agent ${ID_B}`,
      ].join("\n\n---\n\n"),
    );
    expect(result.details.agents).toEqual([
      { kind: "unknown", agentId: ID_A, activeAgents: "none" },
      { kind: "stopped", agentId: ID_B },
    ]);
  });

  it("reports an already-settled agent without calling abort for it", async () => {
    const manager = fakeManager({
      [ID_A]: settledSpawn(ID_A),
      [ID_B]: spawnedSpawn(ID_B),
    });
    getManagerMock.mockReturnValue(manager);

    const result = await invoke({ agent_ids: [ID_A, ID_B] });

    expect(manager.abort).toHaveBeenCalledTimes(1);
    expect(manager.abort).toHaveBeenCalledWith(ID_B, "agent");
    expect(text(result)).toBe(
      [
        `Agent ${ID_A} is already completed. Active agents: none`,
        `Stopped agent ${ID_B}`,
      ].join("\n\n---\n\n"),
    );
    expect(result.details.agents).toEqual([
      {
        kind: "already-settled",
        agentId: ID_A,
        status: "completed",
        activeAgents: "none",
      },
      { kind: "stopped", agentId: ID_B },
    ]);
  });

  it("reports an abort failure as data and continues the batch", async () => {
    const manager = fakeManager(
      { [ID_A]: spawnedSpawn(ID_A), [ID_C]: spawnedSpawn(ID_C) },
      async (id) => id !== ID_A,
    );
    getManagerMock.mockReturnValue(manager);

    const result = await invoke({ agent_ids: [ID_A, ID_C] });

    expect(manager.abort).toHaveBeenCalledTimes(2);
    expect(text(result)).toBe(
      [
        `Failed to stop agent ${ID_A}: the agent could not be stopped`,
        `Stopped agent ${ID_C}`,
      ].join("\n\n---\n\n"),
    );
    expect(result.details.agents).toEqual([
      {
        kind: "failed",
        agentId: ID_A,
        error: "the agent could not be stopped",
      },
      { kind: "stopped", agentId: ID_C },
    ]);
  });
});

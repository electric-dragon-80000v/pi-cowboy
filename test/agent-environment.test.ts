/**
 * agent-environment.test.ts — execution placement and run-history transitions.
 */

import { describe, expect, it } from "vitest";
import {
  engageExecution,
  endExecutionRun,
  placeExecution,
} from "../src/agents/agent-environment.js";
import { buildAgentSpawn } from "../src/agents/subagent-session.js";
import type { AgentExecutionState, EndedRun } from "../src/types.js";
import type { AgentHostRef } from "../src/agents/agent-host.js";

function ref(paneId: string, paneCreated = true): AgentHostRef {
  return {
    multiplexer: "herdr",
    name: "cow-fix-login-abcd1234",
    paneId,
    tabId: "w1:t1",
    workspaceId: "w1",
    paneCreated,
  };
}

const ACTIVE = ref("w1:p1");

function endedRun(harness: EndedRun["harness"], host: AgentHostRef): EndedRun {
  return {
    harness,
    host,
    cwd: "/work/wt",
    sessionId: `${harness}-ses`,
    startedAt: 1,
    endedAt: 2,
  };
}

function execution(
  overrides: Partial<AgentExecutionState> = {},
): AgentExecutionState {
  return {
    promise: Promise.resolve(""),
    abortController: new AbortController(),
    history: [],
    ...overrides,
  };
}

describe("execution transitions", () => {
  it("writes a placement and the harness engaging it", () => {
    const state = execution();

    placeExecution(state, ACTIVE);
    engageExecution(state, "pig");

    expect(state.host).toEqual(ACTIVE);
    expect(state.harness).toBe("pig");
  });

  it("archives a run and releases its placement and harness", () => {
    const state = execution({ host: ACTIVE, harness: "codex" });
    const run = endedRun("codex", ACTIVE);

    endExecutionRun(state, run);

    expect(state.host).toBeUndefined();
    expect(state.harness).toBeUndefined();
    expect(state.history).toEqual([run]);
  });
});

describe("buildAgentSpawn", () => {
  it("starts an environment nothing has engaged", () => {
    const spawn = buildAgentSpawn(
      {
        pi: {} as never,
        ctx: {} as never,
        type: "general-purpose",
        prompt: "do the thing",
        options: {} as never,
      },
      Promise.resolve(""),
    );

    expect(spawn.execution.history).toEqual([]);
    expect(spawn.execution.harness).toBeUndefined();
  });
});

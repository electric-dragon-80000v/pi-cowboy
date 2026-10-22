/**
 * agent-environment.test.ts — the container view over one spawn's execution.
 * Pins what a caller may ask the environment for: the placement, the run
 * occupying it, and the runs before it.
 */

import { describe, expect, it } from "vitest";
import { environmentOf } from "../src/agents/agent-environment.js";
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
  return { harness, host, cwd: "/work/wt", startedAt: 1, endedAt: 2 };
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

describe("environmentOf", () => {
  it("reads the placement and the harness occupying it", () => {
    const environment = environmentOf(
      execution({ host: ACTIVE, harness: "pig" }),
    );

    expect(environment.host).toEqual(ACTIVE);
    expect(environment.harness).toBe("pig");
  });

  it("reports no active run before a launch places one", () => {
    const environment = environmentOf(execution());

    expect(environment.host).toBeUndefined();
    expect(environment.harness).toBeUndefined();
    expect(environment.ended).toEqual([]);
  });

  it("keeps each ended run's own address, oldest first", () => {
    const earlier = endedRun("claude", ref("w1:p2"));
    const oldest = endedRun("pi", ref("w1:p3"));
    const environment = environmentOf(
      execution({
        host: ACTIVE,
        harness: "opencode",
        history: [oldest, earlier],
      }),
    );

    expect(environment.ended).toEqual([oldest, earlier]);
  });

  it("writes a placement and the harness engaging it back to the execution", () => {
    const state = execution();

    environmentOf(state).place(ACTIVE);
    environmentOf(state).engage("pig");

    expect(state.host).toEqual(ACTIVE);
    expect(state.harness).toBe("pig");
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
    expect(environmentOf(spawn.execution).harness).toBeUndefined();
  });
});

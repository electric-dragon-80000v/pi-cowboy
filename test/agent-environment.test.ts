/**
 * agent-environment.test.ts — the container view over one spawn's execution.
 * Pins what callers may query from the environment: the placement, the run
 * occupying it and the session that run is in, and the runs before it.
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
    session: { kind: "unidentified" },
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
    expect(environment.session).toEqual({ kind: "unidentified" });
    expect(environment.ended).toEqual([]);
  });

  it("reads the session the active run is in", () => {
    const environment = environmentOf(
      execution({
        host: ACTIVE,
        harness: "codex",
        session: { kind: "identified", sessionId: "ses-codex-1" },
      }),
    );

    expect(environment.session).toEqual({
      kind: "identified",
      sessionId: "ses-codex-1",
    });
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

  it("gives up the placement, the harness, and the session when a run ends", () => {
    const state = execution({
      host: ACTIVE,
      harness: "codex",
      session: { kind: "identified", sessionId: "ses-codex-1" },
    });

    environmentOf(state).end(endedRun("codex", ACTIVE));

    expect(environmentOf(state).host).toBeUndefined();
    expect(environmentOf(state).harness).toBeUndefined();
    expect(environmentOf(state).session).toEqual({ kind: "unidentified" });
    expect(state.history).toEqual([endedRun("codex", ACTIVE)]);
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
    expect(environmentOf(spawn.execution).session).toEqual({
      kind: "unidentified",
    });
  });
});

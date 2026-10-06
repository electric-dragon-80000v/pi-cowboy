/**
 * protocol.test.ts — The delegation layer's own surfaces: details payload,
 * active-agent summary, and pre-side-effect intent validation. (Cue
 * byte-identity lives in message-baseline.test.ts and
 * orchestrator-integration.test.ts.)
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { AgentSpawn } from "../src/types.js";
import {
  DelegationProtocol,
  buildAgentDetails,
  formatActiveAgents,
  runDelegationBatch,
} from "../src/orchestrators/protocol.js";
import { registerOrchestrators } from "../src/orchestrators/orchestrator-types.js";
import type { OrchestratorConfig } from "../src/orchestrators/types.js";
import { TEST_ORCHESTRATION } from "./helpers/orchestration.js";

const { configuredAgent, getManagerMock } = vi.hoisted(() => ({
  configuredAgent: {} as { defaultOrchestrator?: string },
  // Any item that reaches `run` needs the manager; these suites assert that
  // validation refuses before then, so reaching it is the failure.
  getManagerMock: vi.fn(() => {
    throw new Error("the manager was reached before validation refused");
  }),
}));

vi.mock("../src/shell.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/shell.js")>()),
  getStore: () => ({ agent: configuredAgent }),
  getManager: getManagerMock,
}));

// 8 Crockford base32 chars, printed whole.
const AGENT_ID = "01234567";

/** Minimal spawn; cases override the fields they exercise. */
function spawn(
  overrides: Partial<{
    lifecycle: AgentSpawn["lifecycle"];
    display: Partial<AgentSpawn["display"]>;
    execution: Partial<AgentSpawn["execution"]>;
  }> = {},
): AgentSpawn {
  return {
    id: AGENT_ID,
    lifecycle: overrides.lifecycle ?? {
      phase: "spawned",
      startedAt: 1_700_000_000_000,
    },
    display: {
      type: "general-purpose",
      description: "do the thing",
      taskSlug: "fix-login-flow",
      orchestration: TEST_ORCHESTRATION,
      ...overrides.display,
    },
    execution: { ...overrides.execution },
  } as unknown as AgentSpawn;
}

/** Manager surface for formatActiveAgents — structural, like the tool's. */
function managerWith(agents: AgentSpawn[]) {
  return {
    listAgents: () => agents,
    getSpawn: () => undefined,
  };
}

describe("buildAgentDetails", () => {
  it("always includes the type and description, and omits what does not apply", () => {
    expect(buildAgentDetails(spawn())).toEqual({
      type: "general-purpose",
      description: "do the thing",
      taskSlug: "fix-login-flow",
    });
  });

  it("adds the worktree and herdr location for an adopted worktree run", () => {
    const details = buildAgentDetails(
      spawn({
        display: {
          worktree: {
            kind: "owned",
            path: "/wt/cow-fix-login-abc12345",
            branch: "cow-fix-login-abc12345",
          },
        },
        execution: {
          host: {
            engine: "herdr",
            name: "cow-fix-login-abc12345",
            paneId: "p1",
            tabId: "t1",
            workspaceId: "w1",
            paneCreated: false,
          },
        },
      }),
    );

    expect(details).toMatchObject({
      worktreePath: "/wt/cow-fix-login-abc12345",
      worktreeBranch: "cow-fix-login-abc12345",
      worktreeManaged: true,
      herdrAgent: "cow-fix-login-abc12345",
      herdrPane: "p1",
      herdrTab: "t1",
    });
  });

  it("includeStatus reports the settled status", () => {
    const details = buildAgentDetails(
      spawn({
        lifecycle: {
          phase: "settled",
          startedAt: 1,
          status: "stopped",
          completedAt: 2,
          stop: { initiator: "user" },
        },
      }),
      { includeStatus: true },
    );

    expect(details.status).toBe("stopped");
  });

  it("includeRunInfo reports the model, thinking level, and elapsed time", () => {
    const details = buildAgentDetails(
      spawn({
        lifecycle: {
          phase: "settled",
          startedAt: 1_700_000_000_000,
          status: "completed",
          result: "done",
          completedAt: 1_700_000_010_000,
        },
        display: {
          invocation: {
            modelName: "special-model",
            thinkingLevel: "high",
          },
        },
      }),
      { includeRunInfo: true },
    );

    expect(details).toMatchObject({
      durationMs: 10_000,
      modelName: "special-model",
      modelId: "special-model",
      thinkingLevel: "high",
    });
  });

  it("includeRunInfo reports zero elapsed time for a spawned spawn", () => {
    const details = buildAgentDetails(spawn(), { includeRunInfo: true });
    expect(details.durationMs).toBe(0);
  });
});

describe("formatActiveAgents", () => {
  it("reports none when no agent is active", () => {
    expect(formatActiveAgents(managerWith([]))).toBe("none");
  });

  it("lists spawned and queued agents by spawn id and type, and hides settled ones", () => {
    const settled = spawn({
      lifecycle: {
        phase: "settled",
        startedAt: 1,
        status: "completed",
        result: "done",
        completedAt: 2,
      },
    });

    expect(
      formatActiveAgents(
        managerWith([
          spawn({ display: { type: "general-purpose" } }),
          spawn({
            lifecycle: { phase: "queued", queuedAt: 1 },
            display: { type: "explore" },
          }),
          settled,
        ]),
      ),
    ).toBe("01234567 (general-purpose), 01234567 (explore)");
  });
});

describe("DelegationProtocol.parse", () => {
  const AVAILABLE = [
    { provider: "override", id: "special-model", name: "special-model" },
  ];

  function ctx(): ExtensionContext {
    return {
      cwd: "/work/repo/src",
      model: undefined,
      modelRegistry: {
        find: (provider: string, modelId: string) =>
          AVAILABLE.find((m) => m.provider === provider && m.id === modelId),
        // Every catalog model authenticates here; credential rules are covered in model-request.test.ts and model-override.test.ts.
        getProviderAuthStatus: () => ({ configured: true }),
      },
      ui: { notify: () => {} },
    } as unknown as ExtensionContext;
  }

  it("throws for a missing task name before resolving anything else", async () => {
    // `task_name` is intentionally missing — the type cast proves the parse
    // layer rejects it at runtime even when the input looks partial.
    await expect(
      DelegationProtocol.parse(
        { prompt: "do the thing" } as unknown as Parameters<
          typeof DelegationProtocol.parse
        >[0],
        ctx(),
        "",
      ),
    ).rejects.toThrow(/cowboy_agent requires a short 2-3 word task name/);
  });

  it("takes the resolved template's guidance verbatim, and blank adds no gate", async () => {
    const guided: OrchestratorConfig = {
      name: "guided",
      guidance: "  Inspect the exact diff before committing.  ",
      cues: {
        spawned: "s {{agent_id}}",
        queued: "q {{agent_id}}",
        settled: "{{result}}",
      },
    };
    registerOrchestrators(new Map([["guided", guided]]));
    configuredAgent.defaultOrchestrator = "guided";
    try {
      const protocol = await DelegationProtocol.parse(
        { prompt: "x", task_name: "fix login" },
        ctx(),
        "",
      );
      // Copied verbatim — no trim, no synthesis.
      expect(protocol.intent.orchestrator.guidance).toBe(
        "  Inspect the exact diff before committing.  ",
      );
    } finally {
      configuredAgent.defaultOrchestrator = undefined;
      registerOrchestrators(new Map());
    }

    const plain = await DelegationProtocol.parse(
      { prompt: "x", task_name: "fix login" },
      ctx(),
      "",
    );
    expect(plain.intent.orchestrator.guidance).toBe("");
  });

  it("freezes the validated intent", async () => {
    const protocol = await DelegationProtocol.parse(
      {
        prompt: "do the thing\nmore detail",
        task_name: "fix login",
        run_in_background: false,
      },
      ctx(),
      "tool-1",
    );

    expect(protocol.intent).toMatchObject({
      toolCallId: "tool-1",
      description: "do the thing",
      agentType: "general-purpose",
      resolvedType: "general-purpose",
      isBackground: false,
    });
    expect(protocol.intent.modelSelection).toBeUndefined();
    expect(protocol.intent.orchestrator.name).toBe("default");
  });

  it("defaults to background when run_in_background is omitted", async () => {
    const protocol = await DelegationProtocol.parse(
      { prompt: "x", task_name: "fix login" },
      ctx(),
      "",
    );
    expect(protocol.intent.isBackground).toBe(true);
  });

  it("resolves a caller-supplied model against the session registry", async () => {
    const protocol = await DelegationProtocol.parse(
      { prompt: "x", task_name: "fix login", model: "override/special-model" },
      ctx(),
      "",
    );

    expect(protocol.intent.modelSelection).toMatchObject({
      key: "override/special-model",
      model: { provider: "override", id: "special-model" },
    });
  });

  it("fails a model this session does not have", async () => {
    await expect(
      DelegationProtocol.parse(
        { prompt: "x", task_name: "fix login", model: "ghost/nope" },
        ctx(),
        "",
      ),
    ).rejects.toThrow(/not available in this session/);
  });

  it("fails an unknown agent type at parse, before anything is provisioned", async () => {
    await expect(
      DelegationProtocol.parse(
        { prompt: "x", task_name: "fix login", agent_type: "ghost" },
        ctx(),
        "",
      ),
    ).rejects.toThrow(/Unknown agent type: ghost — nothing was spawned/);
  });
});

describe("runDelegationBatch", () => {
  function ctx(): ExtensionContext {
    return {
      cwd: "/work/repo/src",
      model: undefined,
      modelRegistry: {
        find: () => undefined,
        getProviderAuthStatus: () => ({ configured: true }),
      },
      ui: { notify: () => {} },
    } as unknown as ExtensionContext;
  }

  it("rejects run_in_background: false with more than one agent, before any side effect", async () => {
    await expect(
      runDelegationBatch(
        {
          agents: [
            { prompt: "a", task_name: "task a" },
            { prompt: "b", task_name: "task b" },
          ],
          run_in_background: false,
        },
        {} as ExtensionContext,
        "",
        undefined,
      ),
    ).rejects.toThrow(/exactly one agent/);
  });

  it("does not fire the cross-field guard for a single-item foreground call", async () => {
    // The cross-field guard is the only check that fires synchronously
    // before any side effect — and it must NOT fire here. Any throw from
    // `runDelegationBatch` beyond the guard (e.g. parse-time model probe)
    // is not under test in this assertion.
    const promise = runDelegationBatch(
      {
        agents: [{ prompt: "x", task_name: "fix login" }],
        run_in_background: false,
      },
      {} as ExtensionContext,
      "",
      undefined,
    );
    await expect(promise).rejects.not.toThrow(/exactly one agent/);
  });

  it("refuses the whole batch on an unknown agent type before any item runs", async () => {
    await expect(
      runDelegationBatch(
        {
          agents: [
            { prompt: "a", task_name: "task a" },
            { prompt: "b", task_name: "task b", agent_type: "ghost" },
          ],
        },
        ctx(),
        "",
        undefined,
      ),
    ).rejects.toThrow(/Unknown agent type: ghost — nothing was spawned/);
    // No item reached `run`: the good item spawned no agent either.
    expect(getManagerMock).not.toHaveBeenCalled();
  });

  it("refuses a task_name used twice in one batch, before any item runs", async () => {
    await expect(
      runDelegationBatch(
        {
          agents: [
            { prompt: "a", task_name: "fix login" },
            { prompt: "b", task_name: "Fix Login!" },
          ],
        },
        ctx(),
        "",
        undefined,
      ),
    ).rejects.toThrow(
      /same task_name more than once: fix-login — nothing was spawned/,
    );
    expect(getManagerMock).not.toHaveBeenCalled();
  });

  it("does not fire the repeated-name guard for distinct task names", async () => {
    // Distinct slugs are distinct tasks, so the guard stays quiet and the call
    // proceeds into its runs (which this suite's stubs refuse for other reasons).
    await expect(
      runDelegationBatch(
        {
          agents: [
            { prompt: "a", task_name: "fix login" },
            { prompt: "b", task_name: "fix logins" },
          ],
        },
        ctx(),
        "",
        undefined,
      ),
    ).rejects.not.toThrow(/same task_name more than once/);
  });
});

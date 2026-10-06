/**
 * model-override.test.ts — the cowboy_agent tool's OPTIONAL per-call `model`.
 * Pins: the caller's `model` wins and is never clobbered by the listener;
 * unset runs the configured default (soft fallback to the parent when gone);
 * an unavailable or unauthenticatable model fails LOUDLY before any side
 * effect; and provenance lives in separate args keys, so a stale marker
 * cannot demote the failure to a silent fallback. Driven through the real
 * entry points over the SAME args object, like pi's preflight feeding
 * `tool.execute(args)`.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  ExtensionContext,
  ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSpawn } from "../src/types.js";

import {
  executeAgentTool,
  toolCallListener,
} from "../src/agents/tool-execution.js";
import type { CowboyAgents } from "../src/agents/schemas/cowboy-agents.schema.js";
import { TEST_ORCHESTRATION } from "./helpers/orchestration.js";

const {
  resolveMainCheckoutMock,
  createWorktreeCheckoutMock,
  hostAtMock,
  getPiInstanceMock,
  getSessionCtxMock,
  getStoreMock,
  getManagerMock,
  getCoordinatorMock,
  getRuntimeMock,
  spawnMock,
  mintSpawnIdMock,
  resolveTypeOrDiscoverMock,
  getAgentConfigMock,
  configuredModelMock,
  piExecMock,
} = vi.hoisted(() => ({
  resolveMainCheckoutMock: vi.fn(),
  createWorktreeCheckoutMock: vi.fn(),
  hostAtMock: vi.fn(),
  getPiInstanceMock: vi.fn(),
  getSessionCtxMock: vi.fn(),
  getStoreMock: vi.fn(),
  getManagerMock: vi.fn(),
  getCoordinatorMock: vi.fn(),
  getRuntimeMock: vi.fn(),
  spawnMock: vi.fn(),
  mintSpawnIdMock: vi.fn(),
  resolveTypeOrDiscoverMock: vi.fn(),
  getAgentConfigMock: vi.fn(),
  configuredModelMock: vi.fn(),
  piExecMock: vi.fn(),
}));

vi.mock("../src/infrastructure/git-client.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../src/infrastructure/git-client.js")
  >()),
  resolveMainCheckout: resolveMainCheckoutMock,
}));

vi.mock("../src/spawn/herdr-launcher.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/spawn/herdr-launcher.js")>()),
  createWorktreeCheckout: createWorktreeCheckoutMock,
}));

vi.mock("../src/agents/agent-types.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/agents/agent-types.js")>()),
  resolveTypeOrDiscover: resolveTypeOrDiscoverMock,
  getAgentConfig: getAgentConfigMock,
}));

vi.mock("../src/shell.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/shell.js")>()),
  getPiInstance: getPiInstanceMock,
  getSessionCtx: getSessionCtxMock,
  getStore: getStoreMock,
  getManager: getManagerMock,
  getCoordinator: getCoordinatorMock,
  getRuntime: getRuntimeMock,
}));

const AGENT_ID = "abc12345";
const BRANCH = `cow-fix-login-${AGENT_ID}`;
const CONFIGURED_KEY = "config/configured-model";
const OVERRIDE_KEY = "override/special-model";

function model(provider: string, id: string): Model<Api> {
  return { provider, id } as unknown as Model<Api>;
}

const PARENT_MODEL = model("parent", "parent-1");
const CONFIGURED_MODEL = model("config", "configured-model");
const OVERRIDE_MODEL = model("override", "special-model");

/** The session's available models — anything else must fail the call. */
const AVAILABLE = [CONFIGURED_MODEL, OVERRIDE_MODEL];

/**
 * Fake credential answers, keyed by PROVIDER: absent = has credential,
 * `"none"` = none, `Error` = throwing probe.
 */
let credentials: Map<string, "none" | Error>;

const registry = {
  find: (provider: string, modelId: string) =>
    AVAILABLE.find((m) => m.provider === provider && m.id === modelId),
  getProviderAuthStatus: (provider: string) => {
    const answer = credentials.get(provider);
    if (answer instanceof Error) throw answer;
    return answer === "none"
      ? { configured: false }
      : { configured: true, source: "stored" };
  },
};

const pi = { exec: piExecMock } as never;
const ctx = {
  cwd: "/work/repo/src",
  model: PARENT_MODEL,
  modelRegistry: registry,
  ui: { notify: () => {} },
} as unknown as ExtensionContext;

let worktreeRoot: string;

/** The mint spy is the first side effect, proving the model validates first. */
function managerFake(): {
  listAgents(): AgentSpawn[];
  mintSpawnId(): string;
} {
  return {
    listAgents: () => [],
    mintSpawnId: () => {
      mintSpawnIdMock();
      return AGENT_ID;
    },
  };
}

const PARAMS_TEMPLATE = {
  agents: [
    {
      agent_type: "general-purpose",
      prompt: "do the thing",
      task_name: "fix login",
    },
  ],
  run_in_background: true,
};

/**
 * Fresh deep clone per call: the listener mutates `input.agents[0]`
 * (injecting `_configuredModel` and `thinking`), and a shallow spread of a
 * shared PARAMS would let one test's mutation bleed into the next.
 */
const PARAMS = () => structuredClone(PARAMS_TEMPLATE);

function settledSpawn(options: { modelName?: string }): AgentSpawn {
  return {
    id: AGENT_ID,
    lifecycle: {
      phase: "settled",
      status: "completed",
      startedAt: 1,
      completedAt: 2,
      result: "the final answer",
    },
    display: {
      type: "general-purpose",
      description: "do the thing",
      taskSlug: "fix-login-flow",
      orchestration: TEST_ORCHESTRATION,
      invocation: { modelName: options.modelName },
    },
    execution: {
      promise: Promise.resolve(""),
    },
  } as unknown as AgentSpawn;
}

beforeEach(() => {
  vi.clearAllMocks();
  credentials = new Map();
  worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "model-override-"));
  getPiInstanceMock.mockReturnValue(pi);
  piExecMock.mockResolvedValue({
    code: 0,
    stdout: "",
    stderr: "",
  });
  getSessionCtxMock.mockReturnValue({ cwd: "/work/repo/src" });
  configuredModelMock.mockReturnValue(CONFIGURED_KEY);
  getStoreMock.mockReturnValue({
    agent: {
      worktreeRoot,
      worktreeMaterialization: "copy-on-write",
      defaultThinking: undefined,
    },
    modelFor: configuredModelMock,
  });
  getRuntimeMock.mockReturnValue({ host: { hostAt: hostAtMock } });
  getCoordinatorMock.mockReturnValue({ spawn: spawnMock });
  getManagerMock.mockReturnValue(managerFake());
  getAgentConfigMock.mockReturnValue(undefined);
  resolveTypeOrDiscoverMock.mockResolvedValue({
    kind: "resolved",
    key: "general-purpose",
  });
  hostAtMock.mockResolvedValue({
    engine: "herdr",
    name: BRANCH,
    paneId: "p1",
    tabId: "t1",
    workspaceId: "w1",
    paneCreated: false,
  });
  createWorktreeCheckoutMock.mockResolvedValue({
    path: "/work/.cowboy/cow-fix-login-abc12345",
    branch: BRANCH,
    repoCwd: "/work/repo",
  });
  resolveMainCheckoutMock.mockRejectedValue(new Error("not a repository"));
});

/** The listener runs first over the args object, then executeAgentTool gets that SAME object. Returns the spawn options the coordinator saw. */
async function runTool(
  itemOverrides: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  // `input` is the SAME object pi feeds to both the listener and
  // executeAgentTool; the listener injects `_configuredModel` at runtime, so
  // the type is the CowboyAgents shape plus an open Record (for the marker).
  // Structured-clone the per-item object: a previous test's listener can
  // have mutated the shared PARAMS.agents[0] reference, and the listener on
  // THIS input would otherwise inherit that mutation through the spread.
  const input = {
    ...PARAMS(),
    agents: [
      {
        ...structuredClone(PARAMS().agents[0]),
        ...itemOverrides,
      },
    ],
  } as CowboyAgents & Record<string, unknown>;
  await toolCallListener(
    { toolName: "cowboy_agent", input } as unknown as ToolCallEvent,
    ctx,
  );
  spawnMock.mockResolvedValue({
    agentId: AGENT_ID,
    spawn: settledSpawn({}),
  });
  await executeAgentTool("", input, undefined, undefined, ctx);
  return spawnMock.mock.calls[0]![1] as Record<string, unknown>;
}

describe("cowboy_agent per-call model override", () => {
  it("runs the caller-supplied model and never clobbers it", async () => {
    const input: CowboyAgents & Record<string, unknown> = {
      ...PARAMS(),
      agents: [{ ...structuredClone(PARAMS().agents[0]), model: OVERRIDE_KEY }],
    };
    await toolCallListener(
      { toolName: "cowboy_agent", input } as unknown as ToolCallEvent,
      ctx,
    );
    // The listener leaves the caller's param alone and opens no configured-default channel.
    expect(input.agents[0].model).toBe(OVERRIDE_KEY);
    expect(
      (input.agents[0] as Record<string, unknown>)._configuredModel,
    ).toBeUndefined();
    expect(configuredModelMock).not.toHaveBeenCalled();

    spawnMock.mockResolvedValue({
      agentId: AGENT_ID,
      spawn: settledSpawn({}),
    });
    await executeAgentTool("", input, undefined, undefined, ctx);

    const options = spawnMock.mock.calls[0]![1] as Record<string, unknown>;
    expect(options.modelSelection).toEqual({
      model: OVERRIDE_MODEL,
      key: OVERRIDE_KEY,
    });
    expect(options.invocation).toMatchObject({ modelName: "special-model" });
  });

  it("leaves the injected configured default unchanged when the param is unset", async () => {
    const input: CowboyAgents & Record<string, unknown> = { ...PARAMS() };
    await toolCallListener(
      { toolName: "cowboy_agent", input } as unknown as ToolCallEvent,
      ctx,
    );
    expect(input.agents[0].model).toBeUndefined();
    expect((input.agents[0] as Record<string, unknown>)._configuredModel).toBe(
      CONFIGURED_KEY,
    );

    spawnMock.mockResolvedValue({
      agentId: AGENT_ID,
      spawn: settledSpawn({}),
    });
    await executeAgentTool("", input, undefined, undefined, ctx);

    const options = spawnMock.mock.calls[0]![1] as Record<string, unknown>;
    expect(options.modelSelection).toEqual({
      model: CONFIGURED_MODEL,
      key: CONFIGURED_KEY,
    });
    expect(options.invocation).toMatchObject({ modelName: "configured-model" });
  });

  it("treats null (the constrained-sampling unset shape) as unset", async () => {
    await expect(runTool({ model: null })).resolves.toMatchObject({
      modelSelection: { model: CONFIGURED_MODEL, key: CONFIGURED_KEY },
    });
  });

  it("keeps the legacy soft fallback to the parent when the configured default is gone", async () => {
    configuredModelMock.mockReturnValue("config/vanished");
    await expect(runTool()).resolves.toMatchObject({
      modelSelection: { model: PARENT_MODEL, key: "parent/parent-1" },
    });
  });

  it("fails loudly for a model this session does not have, before any side effect", async () => {
    const input: CowboyAgents & Record<string, unknown> = {
      ...PARAMS(),
      agents: [
        {
          ...structuredClone(PARAMS().agents[0]),
          model: "ghost/missing-model",
        },
      ],
    };
    await toolCallListener(
      { toolName: "cowboy_agent", input } as unknown as ToolCallEvent,
      ctx,
    );

    await expect(
      executeAgentTool("", input, undefined, undefined, ctx),
    ).rejects.toThrow(
      'Model "ghost/missing-model" is not available in this session',
    );

    // Resolution runs before the mint and worktree resolution.
    expect(mintSpawnIdMock).not.toHaveBeenCalled();
    expect(resolveMainCheckoutMock).not.toHaveBeenCalled();
    expect(createWorktreeCheckoutMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("fails loudly for a bare model id with no provider segment", async () => {
    // A bare id has no provider to look the model up by.
    await expect(runTool({ model: "special-model" })).rejects.toThrow(
      'Model "special-model" is not available in this session',
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("cannot be demoted to the injected soft path by a stale marker on the args object", async () => {
    // A stale marker must not route a caller-supplied model onto the injected soft path.
    await expect(
      runTool({ model: "ghost/missing-model", _modelInjected: true }),
    ).rejects.toThrow('Model "ghost/missing-model" is not available');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("still honours a valid override next to a stale marker", async () => {
    await expect(
      runTool({ model: OVERRIDE_KEY, _modelInjected: true }),
    ).resolves.toMatchObject({
      modelSelection: { model: OVERRIDE_MODEL, key: OVERRIDE_KEY },
    });
  });

  it("fails loudly for a catalog model this session cannot authenticate, before any side effect", async () => {
    // The model IS in the catalog, so only the credential probe can catch it — before any child is spawned.
    credentials.set("override", "none");
    const input: CowboyAgents & Record<string, unknown> = {
      ...PARAMS(),
      agents: [{ ...structuredClone(PARAMS().agents[0]), model: OVERRIDE_KEY }],
    };
    await toolCallListener(
      { toolName: "cowboy_agent", input } as unknown as ToolCallEvent,
      ctx,
    );

    const promise = executeAgentTool("", input, undefined, undefined, ctx);
    await expect(promise).rejects.toThrow(
      'Model "override/special-model" cannot authenticate in this session',
    );
    await expect(promise).rejects.toThrow(/Nothing was spawned/);

    // Resolution runs before the mint and worktree resolution.
    expect(mintSpawnIdMock).not.toHaveBeenCalled();
    expect(resolveMainCheckoutMock).not.toHaveBeenCalled();
    expect(createWorktreeCheckoutMock).not.toHaveBeenCalled();
    expect(hostAtMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("fails the call when the configured default cannot authenticate — no parent substitution", async () => {
    credentials.set("config", "none");

    await expect(runTool()).rejects.toThrow(
      'The subagent model "config/configured-model" for this configured default cannot authenticate in this session',
    );
    // The usable parent model is still not substituted.
    expect(mintSpawnIdMock).not.toHaveBeenCalled();
    expect(resolveMainCheckoutMock).not.toHaveBeenCalled();
    expect(createWorktreeCheckoutMock).not.toHaveBeenCalled();
    expect(hostAtMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("fails the call when the pinned parent model cannot authenticate either", async () => {
    // No request pins the parent's model, with nothing softer to fall back to.
    configuredModelMock.mockReturnValue(undefined);
    credentials.set("parent", "none");

    await expect(runTool()).rejects.toThrow(
      /parent session's model "parent\/parent-1"/,
    );
    expect(mintSpawnIdMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("reports the model that actually runs in the tool details", async () => {
    const input: CowboyAgents & Record<string, unknown> = {
      ...PARAMS(),
      agents: [{ ...structuredClone(PARAMS().agents[0]), model: OVERRIDE_KEY }],
    };
    await toolCallListener(
      { toolName: "cowboy_agent", input } as unknown as ToolCallEvent,
      ctx,
    );
    // The foreground path renders details from the spawn's invocation.
    spawnMock.mockImplementation(() => ({
      agentId: AGENT_ID,
      spawn: settledSpawn({ modelName: "special-model" }),
    }));
    input.run_in_background = false;
    const result = await executeAgentTool("", input, undefined, undefined, ctx);
    // Single-item foreground preserves the unified `{ agents: [...] }` shape.
    const details = result.details as {
      agents: Array<Record<string, unknown>>;
    };
    expect(details.agents[0].modelName).toBe("special-model");
    expect(details.agents[0].modelId).toBe("special-model");
  });
});

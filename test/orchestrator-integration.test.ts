/**
 * orchestrator-integration.test.ts — Orchestrator wiring at the cowboy_agent
 * tool boundary. Byte-identity is pinned by message-baseline.test.ts (never
 * duplicated here); this suite proves the WIRING: spawns resolve the
 * configured default — an unresolvable name degrades to `default` — a custom
 * default is honored for spawn ack and settle report, and rendering reads the
 * template the spawn captured, never the registry.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSpawn } from "../src/types.js";
import { DEFAULT_ORCHESTRATORS } from "../src/orchestrators/default-orchestrators.js";
import {
  registerOrchestrators,
  getAvailableOrchestrators,
} from "../src/orchestrators/orchestrator-types.js";
import type { OrchestratorConfig } from "../src/orchestrators/types.js";

import { executeAgentTool } from "../src/agents/tool-execution.js";
import { formatResultContent } from "../src/orchestrators/protocol.js";

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
  resolveTypeOrDiscoverMock,
  getAgentConfigMock,
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
  resolveTypeOrDiscoverMock: vi.fn(),
  getAgentConfigMock: vi.fn(),
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

// --- Fixtures ---------------------------------------------------------------

// One id, one identity: the spawn id IS the branch (and path) suffix.
const AGENT_ID = "abc12345";
const BRANCH = `cow-fix-login-${AGENT_ID}`;
const WT_PATH = `/work/.herdr-subagents/repo/${BRANCH}`;
const RESULT_TEXT = "the final answer";

const CUSTOM: OrchestratorConfig = {
  ...DEFAULT_ORCHESTRATORS.default,
  name: "custom",
  cues: {
    spawned:
      "CUSTOM SPAWN {{agent_id}}{{#has_worktree}} WT {{worktree_path}} {{worktree_branch}}{{/has_worktree}}",
    queued: "CUSTOM QUEUED {{agent_id}} {{queue_running}}",
    settled: "CUSTOM SETTLED {{result}}",
  },
};

const GUIDED: OrchestratorConfig = {
  ...CUSTOM,
  name: "guided",
  guidance: "  Inspect the exact diff before committing.  ",
};

const pi = { exec: piExecMock } as never;
const ctx = {
  cwd: "/work/repo/src",
  model: undefined,
  modelRegistry: {},
  ui: { notify: () => {} },
} as unknown as ExtensionContext;

function baseParams(extra?: Record<string, unknown>) {
  return {
    agents: [
      {
        agent_type: "general-purpose",
        prompt: "do the thing",
        task_name: "fix login",
        ...extra,
      },
    ],
    run_in_background: true,
  };
}

/** Minimal spawned-phase spawn; tests override the fields they exercise. */
function baseSpawn(): AgentSpawn {
  return {
    id: AGENT_ID,
    lifecycle: {
      phase: "spawned",
      startedAt: 1_700_000_000_000,
    },
    display: {
      type: "general-purpose",
      description: "do the thing",
      taskSlug: "fix-login-flow",
    },
    execution: {
      promise: Promise.resolve(""),
    },
  } as unknown as AgentSpawn;
}

function settledCompleted(): AgentSpawn {
  const spawn = baseSpawn();
  spawn.display.worktree = { kind: "owned", path: WT_PATH, branch: BRANCH };
  spawn.lifecycle = {
    phase: "settled",
    startedAt: 1_700_000_000_000,
    status: "completed",
    result: RESULT_TEXT,
    completedAt: 1_700_000_010_000,
  };
  return spawn;
}

let worktreeRoot: string;

beforeEach(() => {
  vi.clearAllMocks();
  registerOrchestrators(new Map([[CUSTOM.name, CUSTOM]]));
  worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "orch-integration-"));
  getPiInstanceMock.mockReturnValue(pi);
  piExecMock.mockResolvedValue({
    code: 0,
    stdout: "pi: current (v8) (/tmp/herdr-agent-state.ts)\n",
    stderr: "",
  });
  getSessionCtxMock.mockReturnValue({ cwd: "/work/repo/src" });
  getStoreMock.mockReturnValue({
    agent: {
      worktreeRoot,
      worktreeMaterialization: "copy-on-write",
      defaultThinking: undefined,
    },
  });
  getRuntimeMock.mockReturnValue({ host: { hostAt: hostAtMock } });
  getCoordinatorMock.mockReturnValue({ spawn: spawnMock });
  getManagerMock.mockReturnValue({
    listAgents: () => [],
    mintSpawnId: () => AGENT_ID,
  });
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
    path: WT_PATH,
    branch: BRANCH,
    repoCwd: "/work/repo",
  });
  resolveMainCheckoutMock.mockResolvedValue("/work/repo");
});

/** Point the mocked store's configured default at a template. */
function useDefaultOrchestrator(name: string): void {
  getStoreMock.mockReturnValue({
    agent: {
      worktreeRoot,
      worktreeMaterialization: "copy-on-write",
      defaultThinking: undefined,
      defaultOrchestrator: name,
    },
  });
}

// --- Resolution --------------------------------------------------------------

describe("orchestrator default resolution", () => {
  it("degrades a configured default that no longer resolves to `default`", async () => {
    expect(getAvailableOrchestrators()).toContain("custom");
    useDefaultOrchestrator("nope");
    const spawn = baseSpawn();
    spawnMock.mockResolvedValue({ agentId: AGENT_ID, spawn });

    await executeAgentTool("", baseParams(), undefined, undefined, ctx);

    expect(spawnMock).toHaveBeenCalledOnce();
    expect(spawnMock.mock.calls[0]![1].orchestration).toEqual(
      DEFAULT_ORCHESTRATORS.default,
    );
  });

  it("forwards the resolved template's guidance verbatim, ignoring raw params", async () => {
    registerOrchestrators(
      new Map([
        [CUSTOM.name, CUSTOM],
        [GUIDED.name, GUIDED],
      ]),
    );
    const spawn = baseSpawn();
    spawnMock.mockResolvedValue({ agentId: AGENT_ID, spawn });
    useDefaultOrchestrator("guided");

    // Only the resolved template's guidance reaches the spawn — never a raw parameter.
    await executeAgentTool(
      "",
      baseParams({ agent_guidance: "Attempted bypass." }),
      undefined,
      undefined,
      ctx,
    );

    expect(spawnMock).toHaveBeenCalledOnce();
    expect(spawnMock.mock.calls[0]![1].orchestration.guidance).toBe(
      GUIDED.guidance,
    );
  });

  it("serves the same template guidance to a different task on the same template", async () => {
    registerOrchestrators(
      new Map([
        [CUSTOM.name, CUSTOM],
        [GUIDED.name, GUIDED],
      ]),
    );
    const spawn = baseSpawn();
    spawnMock.mockResolvedValue({ agentId: AGENT_ID, spawn });
    useDefaultOrchestrator("guided");

    await executeAgentTool(
      "",
      baseParams({ task_name: "fix checkout" }),
      undefined,
      undefined,
      ctx,
    );

    expect(spawnMock).toHaveBeenCalledOnce();
    expect(spawnMock.mock.calls[0]![1].orchestration.guidance).toBe(
      GUIDED.guidance,
    );
  });

  it("records the canonical name on the spawn when matched case-insensitively", async () => {
    const spawn = baseSpawn();
    spawnMock.mockResolvedValue({ agentId: AGENT_ID, spawn });
    useDefaultOrchestrator("Custom");

    await executeAgentTool("", baseParams(), undefined, undefined, ctx);

    expect(spawnMock).toHaveBeenCalledOnce();
    expect(spawnMock.mock.calls[0]![1].orchestration).toEqual(CUSTOM);
  });

  it("uses the configured default when the tool passes no orchestrator input", async () => {
    const spawn = baseSpawn();
    spawnMock.mockResolvedValue({ agentId: AGENT_ID, spawn });

    await executeAgentTool("", baseParams(), undefined, undefined, ctx);

    expect(spawnMock.mock.calls[0]![1].orchestration).toEqual(
      DEFAULT_ORCHESTRATORS.default,
    );
  });
});

// --- Rendering -----------------------------------------------------------------

describe("custom orchestrator rendering", () => {
  it("renders the spawn ack from the custom spawned cue", async () => {
    const spawn = baseSpawn();
    spawnMock.mockResolvedValue({ agentId: AGENT_ID, spawn });
    useDefaultOrchestrator("custom");

    const result = await executeAgentTool(
      "",
      baseParams(),
      undefined,
      undefined,
      ctx,
    );

    expect(result.content[0]!.text).toBe(
      `[Agent spawned] CUSTOM SPAWN ${AGENT_ID} WT ${path.join(worktreeRoot, BRANCH)} ${BRANCH}`,
    );
  });

  it("renders the settle report from the custom settled cue", () => {
    const spawn = settledCompleted();
    spawn.display.orchestration = CUSTOM;

    expect(formatResultContent(spawn)).toBe(`CUSTOM SETTLED ${RESULT_TEXT}`);
  });

  it("renders the template the spawn captured, not the registry's current one", () => {
    const spawn = settledCompleted();
    spawn.display.orchestration = CUSTOM;
    // The name is re-registered with different cues after the spawn captured it; rendering reads the spawn's own config.
    registerOrchestrators(
      new Map([
        [
          CUSTOM.name,
          {
            ...CUSTOM,
            cues: { ...CUSTOM.cues, settled: "REPLACED SETTLED {{result}}" },
          },
        ],
      ]),
    );

    expect(formatResultContent(spawn)).toBe(`CUSTOM SETTLED ${RESULT_TEXT}`);
  });
});

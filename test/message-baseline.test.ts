/**
 * message-baseline.test.ts — byte-for-byte characterization of the
 * parent-facing cowboy_agent messages (spawn ack, queued notice, settled
 * result). Pinned as WHOLE strings, so a single changed character fails the
 * suite. Driven through the public entry points (executeAgentTool with faked
 * shell seams, and the pure formatResultContent).
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSpawn, WorktreeRetentionReason } from "../src/types.js";

import { executeAgentTool } from "../src/agents/tool-execution.js";
import { formatResultContent } from "../src/orchestrators/protocol.js";
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

// Pin type resolution so the suite never touches the filesystem's agent directories.
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

/** One id, one identity: the spawn id IS the branch suffix. */
const AGENT_ID = "abc12345";
const BRANCH = `cow-fix-login-${AGENT_ID}`;
const WT_ROOT = "/work/.herdr-subagents/repo";
const WT_PATH = `${WT_ROOT}/${BRANCH}`;
const RESULT_TEXT = "the final answer";

const AGENT_ID_LINE = `\n\nAgent ID: ${AGENT_ID}`;

const SPAWNED_PREAMBLE =
  "Success! You delegated to an agent. A notification will arrive when done - USER: do not poll, don't check status and don't duplicate the delegated work!";

/** Shared verbatim by the spawn ack and the queued notice. */
const SPAWN_WORKTREE_NOTE = `\n(Worktree: ${WT_PATH} (branch ${BRANCH}) — the agent's commits land on that branch, never on main. Merge it with the merge_cowboy_branch tool when done, then remove the worktree with cleanup_cowboy_agent.)`;

function queuedBody(spawned: number): string {
  return `Agent QUEUED — the concurrency limit is reached (${spawned} ${spawned === 1 ? "agent" : "agents"} already spawned), so this task is waiting for a slot. It is NOT spawned yet: the process has not started. It will start automatically when another agent settles; you'll get a message when it starts and when it settles. Do NOT re-delegate — this task IS in flight.`;
}

const PROCESS_STAY =
  " The agent process and its herdr pane stay until you call cleanup_cowboy_agent — its pane is closed, which ends that process.";

function cleanWorktreeNote(processNote: string): string {
  return `\n(Worktree: ${WT_PATH} (branch ${BRANCH}).${processNote} The worktree stays until you call cleanup_cowboy_agent to remove it — call it once the branch is merged or rejected.)`;
}

function keptWorktreeNote(processNote: string): string {
  return `\n(Worktree: ${WT_PATH} (branch ${BRANCH}) — KEPT: has uncommitted changes.${processNote} Clean the worktree up, then call cleanup_cowboy_agent to remove it.)`;
}

const pi = { exec: piExecMock } as never;
const ctx = {
  cwd: "/work/repo/src",
  model: undefined,
  modelRegistry: {},
  ui: { notify: () => {} },
} as unknown as ExtensionContext;

const PARAMS = {
  agents: [
    {
      agent_type: "general-purpose",
      prompt: "do the thing",
      task_name: "fix login",
    },
  ],
  run_in_background: true,
};

/** The blocking call shape: one agent, awaited to settlement. */
const PARAMS_BLOCKING = { agents: PARAMS.agents, run_in_background: false };

let worktreeRoot: string;

/** Serves the queued spawned-count and the spawn-id mint. */
function managerFor(list: AgentSpawn[]): {
  listAgents(): AgentSpawn[];
  mintSpawnId(): string;
} {
  return {
    listAgents: () => list,
    mintSpawnId: () => AGENT_ID,
  };
}

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
      orchestration: TEST_ORCHESTRATION,
    },
    execution: {
      promise: Promise.resolve(""),
      abortController: new AbortController(),
    },
  } as unknown as AgentSpawn;
}

function spawnedSpawn(id: string): AgentSpawn {
  const spawn = baseSpawn();
  spawn.id = id;
  return spawn;
}

beforeEach(() => {
  vi.clearAllMocks();
  worktreeRoot = WT_ROOT;
  getPiInstanceMock.mockReturnValue(pi);
  piExecMock.mockResolvedValue({
    code: 0,
    stdout: "",
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
  getManagerMock.mockReturnValue(managerFor([]));
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
});

/**
 * Set a fixture's lifecycle, as the session's own projection would.
 */
function setLifecycle(
  spawn: AgentSpawn,
  lifecycle: AgentSpawn["lifecycle"],
): void {
  spawn.lifecycle = lifecycle;
}

async function spawnText(spawn: AgentSpawn): Promise<string> {
  spawnMock.mockResolvedValue({ agentId: AGENT_ID, spawn });
  const result = await executeAgentTool("", PARAMS, undefined, undefined, ctx);
  return result.content[0]!.text;
}

describe("cowboy_agent spawn messages", () => {
  it("emits the exact spawn ack when no worktree was resolved", async () => {
    resolveMainCheckoutMock.mockRejectedValue(new Error("not a repository"));
    const spawn = baseSpawn();

    await expect(spawnText(spawn)).resolves.toBe(
      `[Agent spawned] ${SPAWNED_PREAMBLE}${AGENT_ID_LINE}`,
    );
  });

  it("emits the exact spawn ack with the worktree note", async () => {
    resolveMainCheckoutMock.mockResolvedValue("/work/repo");
    const spawn = baseSpawn();

    await expect(spawnText(spawn)).resolves.toBe(
      `[Agent spawned] ${SPAWNED_PREAMBLE}${SPAWN_WORKTREE_NOTE}${AGENT_ID_LINE}`,
    );
  });

  it("emits the exact queued notice (one agent already spawned)", async () => {
    resolveMainCheckoutMock.mockRejectedValue(new Error("not a repository"));
    const spawn = baseSpawn();
    setLifecycle(spawn, { phase: "queued", queuedAt: 1 });
    getManagerMock.mockReturnValue(
      managerFor([spawn, spawnedSpawn("aaaaaaaaaaaaaaaa1")]),
    );

    await expect(spawnText(spawn)).resolves.toBe(
      `[Agent queued] ${queuedBody(1)}${AGENT_ID_LINE}`,
    );
  });

  it("emits the exact queued notice with the same worktree note as the ack", () => {
    // The queued notice reuses the ack's exact worktree note; only the head differs.
    resolveMainCheckoutMock.mockResolvedValue("/work/repo");
    const spawn = baseSpawn();
    setLifecycle(spawn, { phase: "queued", queuedAt: 1 });
    getManagerMock.mockReturnValue(
      managerFor([spawn, spawnedSpawn("aaaaaaaaaaaaaaaa1")]),
    );

    return expect(spawnText(spawn)).resolves.toBe(
      `[Agent queued] ${queuedBody(1)}${SPAWN_WORKTREE_NOTE}${AGENT_ID_LINE}`,
    );
  });

  it("pluralizes the queued spawned count", async () => {
    resolveMainCheckoutMock.mockRejectedValue(new Error("not a repository"));
    const spawn = baseSpawn();
    setLifecycle(spawn, { phase: "queued", queuedAt: 1 });
    getManagerMock.mockReturnValue(
      managerFor([
        spawn,
        spawnedSpawn("aaaaaaaaaaaaaaaa1"),
        spawnedSpawn("bbbbbbbbbbbbbbbb2"),
      ]),
    );

    await expect(spawnText(spawn)).resolves.toBe(
      `[Agent queued] ${queuedBody(2)}${AGENT_ID_LINE}`,
    );
  });
});

describe("cowboy_agent settled result messages", () => {
  function settledCompleted(): AgentSpawn {
    const spawn = baseSpawn();
    spawn.display.worktree = { kind: "owned", path: WT_PATH, branch: BRANCH };
    setLifecycle(spawn, {
      phase: "settled",
      startedAt: 1_700_000_000_000,
      status: "completed",
      result: RESULT_TEXT,
      completedAt: 1_700_000_010_000,
    });
    return spawn;
  }

  it("pins a completed settle on a clean worktree (process still alive)", () => {
    const spawn = settledCompleted();

    expect(formatResultContent(spawn)).toBe(
      `${RESULT_TEXT}${cleanWorktreeNote(PROCESS_STAY)}`,
    );
  });

  /** A settled fixture whose worktree was kept for the given reason. */
  function settledKeeping(reason: WorktreeRetentionReason): AgentSpawn {
    const spawn = settledCompleted();
    const { lifecycle } = spawn;
    if (lifecycle.phase !== "settled") {
      throw new Error(`expected a settled run, got ${lifecycle.phase}`);
    }
    lifecycle.worktreeRetentionReason = reason;
    return spawn;
  }

  it("pins a completed settle on a kept (dirty) worktree with the process alive", () => {
    const spawn = settledKeeping({ kind: "dirty" });

    expect(formatResultContent(spawn)).toBe(
      `${RESULT_TEXT}${keptWorktreeNote(PROCESS_STAY)}`,
    );
  });

  it("pins a completed settle without a worktree (parent-cwd run)", () => {
    const spawn = settledCompleted();
    delete spawn.display.worktree;

    expect(formatResultContent(spawn)).toBe(RESULT_TEXT);
  });

  it("pins a stopped settle (process gone, pane kept, status note)", () => {
    const spawn = baseSpawn();
    spawn.display.worktree = { kind: "owned", path: WT_PATH, branch: BRANCH };
    setLifecycle(spawn, {
      phase: "settled",
      startedAt: 1_700_000_000_000,
      status: "stopped",
      completedAt: 1_700_000_010_000,
      stop: { initiator: "user" },
    });

    expect(formatResultContent(spawn)).toBe(
      `${cleanWorktreeNote("")} (STOPPED BY THE USER before completion — output is partial; the task was NOT finished)`,
    );
  });

  it("pins a failed settle on a worktree (error note, no live process)", () => {
    const spawn = baseSpawn();
    spawn.display.worktree = { kind: "owned", path: WT_PATH, branch: BRANCH };
    setLifecycle(spawn, {
      phase: "settled",
      startedAt: 1_700_000_000_000,
      status: "error",
      error: "boom",
      completedAt: 1_700_000_010_000,
    });

    // A failed settle has no live process; only the worktree consequence remains.
    expect(formatResultContent(spawn)).toBe(
      `\n\nError: boom${cleanWorktreeNote("")}`,
    );
  });

  it("pins a failed settle without a worktree", () => {
    const spawn = baseSpawn();
    setLifecycle(spawn, {
      phase: "settled",
      startedAt: 1_700_000_000_000,
      status: "error",
      error: "boom",
      completedAt: 1_700_000_010_000,
    });

    expect(formatResultContent(spawn)).toBe("\n\nError: boom");
  });

  it("headlines a blocking result with the agent id the caller must act on", async () => {
    // The settled cue names no id, so without this headline the one call shape
    // that returns its result inline hands back no handle to stop, merge or
    // clean up with. It is the completion nudge's headline, verbatim.
    resolveMainCheckoutMock.mockResolvedValue("/work/repo");
    const spawn = settledCompleted();
    spawnMock.mockResolvedValue({ agentId: AGENT_ID, spawn });

    const result = await executeAgentTool(
      "",
      PARAMS_BLOCKING,
      undefined,
      undefined,
      ctx,
    );

    expect(result.content[0]!.text).toBe(
      `[Cowboy agent "general-purpose" ${AGENT_ID} completed]\n\n${RESULT_TEXT}${cleanWorktreeNote(PROCESS_STAY)}`,
    );
    // The structured payload carries it too, nested like every other
    // cowboy_agent return.
    expect(result.details.agents).toEqual([
      expect.objectContaining({ agentId: AGENT_ID }),
    ]);
  });
});

/**
 * agent-spawn-store.test.ts — Store ops plus retention through the manager.
 * A spawn registers at creation, stays listed after disposal, and stays
 * cleanable from a fresh manager.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  AgentSpawnStore,
  SpawnIdCollisionError,
} from "../src/agents/agent-spawn-store.js";
import {
  ACTIVE_AGENT_PHASES,
  ALL_AGENT_PHASES,
  TERMINAL_AGENT_PHASES,
} from "../src/types.js";
import { AgentManager } from "../src/agents/agent-manager.js";
import type {
  AgentLifecycleState,
  AgentSpawn,
  ModelSelection,
} from "../src/types.js";
import type { AgentHost, AgentHostRef } from "../src/agents/agent-host.js";
import type { HerdrTaskRegistry } from "../src/task-registry.js";
import type { DeliverableReport, SubagentIPC } from "../src/subagent/ipc.js";
import type { BranchCleanupResult } from "../src/infrastructure/git-client.js";
import {
  SPAWN_ID_ALPHABET,
  SPAWN_ID_LENGTH,
  SpawnIdExhaustedError,
} from "../src/spawn/spawn-id.js";
import { nextSpawnId } from "./helpers/spawn-ids.js";
import { TEST_ORCHESTRATION } from "./helpers/orchestration.js";

const {
  getPiInstanceMock,
  getStoreMock,
  stopAgentAndWaitMock,
  getAgentInfoMock,
  closePaneMock,
  buildLaunchPlanMock,
  isWorktreeDirtyMock,
  removeGitWorktreeMock,
  deleteWorktreeBranchMock,
  removeHerdrWorktreeMock,
  resolveMainCheckoutMock,
} = vi.hoisted(() => ({
  getPiInstanceMock: vi.fn(),
  getStoreMock: vi.fn(() => ({ agent: {} })),
  stopAgentAndWaitMock: vi.fn(),
  getAgentInfoMock: vi.fn(),
  closePaneMock: vi.fn(),
  buildLaunchPlanMock: vi.fn(),
  isWorktreeDirtyMock: vi.fn(),
  removeGitWorktreeMock: vi.fn(),
  deleteWorktreeBranchMock: vi.fn(),
  removeHerdrWorktreeMock: vi.fn(),
  resolveMainCheckoutMock: vi.fn(),
}));

/** Store instance the mocked shell hands to every manager. */
const shared = vi.hoisted(() => ({
  store: undefined as unknown as AgentSpawnStore,
}));

vi.mock("../src/infrastructure/herdr-client.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../src/infrastructure/herdr-client.js")
    >();
  return {
    ...actual,
    stopAgentAndWait: stopAgentAndWaitMock,
    getAgentInfo: getAgentInfoMock,
    closePane: closePaneMock,
    removeHerdrWorktree: removeHerdrWorktreeMock,
  };
});

vi.mock("../src/infrastructure/git-client.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../src/infrastructure/git-client.js")
    >();
  return {
    ...actual,
    isWorktreeDirty: isWorktreeDirtyMock,
    removeGitWorktree: removeGitWorktreeMock,
    deleteWorktreeBranch: deleteWorktreeBranchMock,
    // No repo on disk here: stub the checkout derivation to the fixture repo.
    resolveMainCheckout: resolveMainCheckoutMock,
  };
});

vi.mock("../src/agents/agent-runner.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/agents/agent-runner.js")>();
  return { ...actual, buildLaunchPlan: buildLaunchPlanMock };
});

vi.mock("../src/shell.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/shell.js")>();
  shared.store = new AgentSpawnStore();
  return {
    ...actual,
    getPiInstance: getPiInstanceMock,
    getStore: getStoreMock,
    getAgentSpawns: () => shared.store,
  };
});

const BRANCH = "cow-fix-login-flow-0123456789abcdef0";
const WT_PATH = `/work/.herdr-subagents/repo/${BRANCH}`;

/** A paired model selection for spawns that opt into concurrency slots. */
function testSelection(): ModelSelection {
  return {
    model: { provider: "test", id: "model" } as unknown as Model<Api>,
    key: "test/model",
  };
}

/** Adopted host ref a worktree spawn carries. */
const HOST_REF: AgentHostRef = {
  engine: "herdr",
  name: BRANCH,
  paneId: "w1:p1",
  tabId: "w1:t1",
  workspaceId: "w1",
  paneCreated: true,
};

/** Minimal spawn for the pure store tests. */
function storeSpawn(id: string, lifecycle: AgentLifecycleState): AgentSpawn {
  return {
    id,
    display: {
      type: "general-purpose",
      description: "some task",
      taskSlug: "fix-login-flow",
    },
    lifecycle,
    execution: {
      promise: Promise.resolve(""),
      abortController: new AbortController(),
    },
  } as unknown as AgentSpawn;
}

const SETTLED: AgentLifecycleState = {
  phase: "settled",
  startedAt: 1_700_000_000_000,
  status: "completed",
  result: "done",
  completedAt: 1_700_000_010_000,
};
const SPAWNED: AgentLifecycleState = {
  phase: "spawned",
  startedAt: 1_700_000_000_000,
};
const QUEUED: AgentLifecycleState = {
  phase: "queued",
  queuedAt: 1_700_000_000_000,
};

/** IPC fake settling every run as completed. */
class ScriptedIpc implements SubagentIPC {
  constructor() {}
  async readDeliverable(): Promise<DeliverableReport | null> {
    return { content: "done", mtime: 1 };
  }
  async steer(): Promise<void> {}
}

interface HarnessOptions {
  worktree?: boolean;
  id?: string;
}

interface Harness {
  manager: AgentManager;
  id: string;
  spawn: AgentSpawn;
}

/** Spawn through the manager and drive the run to settlement. */
async function spawnAndSettle(options: HarnessOptions = {}): Promise<Harness> {
  const host = {
    hostAt: async () => HOST_REF,
    release: async () => true,
    start: async () => {},
    stop: async () => true,
    observe: async () => ({ state: "done" }),
  } as unknown as AgentHost;
  const transport = {
    createHost: () => host,
    createIpc: () => new ScriptedIpc(),
  };
  const pool = { limit: 1, spawned: 0 };
  const registry = {
    admitSpawn: () => ({ kind: "start" as const, reservation: [pool] }),
    reserve: () => {
      pool.spawned++;
    },
    release: async () => {
      pool.spawned--;
    },
    clearQueue: () => {},
  };
  const manager = new AgentManager(
    undefined,
    undefined,
    registry as unknown as HerdrTaskRegistry,
    transport,
  );
  buildLaunchPlanMock.mockResolvedValue({
    cwd: "/repo",
    initialMessage: "@/tmp/briefing.md",
    resultFile: "/tmp/result.md",
    piArgs: [],
    harness: "pi",
  });
  const id = manager.spawn(
    {} as never,
    {} as never,
    "general-purpose",
    "do it",
    {
      spawnId: options.id ?? nextSpawnId(),
      description: "do it",
      modelSelection: testSelection(),
      orchestration: TEST_ORCHESTRATION,
      ...(options.worktree
        ? {
            worktree: { kind: "owned", path: WT_PATH, branch: BRANCH },
            hostRef: HOST_REF,
          }
        : {}),
    },
  );
  const spawn = manager.getSpawn(id)!;
  if (options.worktree) {
    // Retention and cleanup read the repo cwd off spawnCtx.
    spawn.execution.spawnCtx = { cwd: "/work/repo" } as never;
  }
  // Drive plan/pane/start/probe, then the poll that settles the spawn.
  await vi.advanceTimersByTimeAsync(0);
  await Promise.resolve();
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(4_000);
  await expect(spawn.execution.promise).resolves.toBe("done");
  expect(spawn.lifecycle).toMatchObject({
    phase: "settled",
    status: "completed",
  });
  return { manager, id, spawn };
}

/** Queued spawn without starting it. */
function spawnQueued(): Harness {
  const registry = {
    admitSpawn: () => ({ kind: "queue" as const }),
    reserve: () => {},
    release: async () => {},
    cancelQueued: () => {},
    clearQueue: () => {},
  };
  const manager = new AgentManager(
    undefined,
    undefined,
    registry as unknown as HerdrTaskRegistry,
  );
  const id = manager.spawn(
    {} as never,
    {} as never,
    "general-purpose",
    "do it",
    {
      spawnId: nextSpawnId(),
      description: "do it",
      modelSelection: testSelection(),
      orchestration: TEST_ORCHESTRATION,
    },
  );
  const spawn = manager.getSpawn(id)!;
  spawn.execution.spawnCtx = { cwd: "/work/repo" } as never;
  return { manager, id, spawn };
}

/* ── Id minting ────────────────────────────────────────────────────────── */

describe("AgentSpawnStore.mint", () => {
  it("returns an id no registered spawn holds, at the canonical length", () => {
    const store = new AgentSpawnStore();
    store.add(storeSpawn("11111111", SPAWNED));

    const id = store.mint();

    expect(id).toMatch(
      new RegExp(`^[${SPAWN_ID_ALPHABET}]{${SPAWN_ID_LENGTH}}$`),
    );
    expect(store.get(id)).toBeUndefined();
  });

  it("retries past ids the store already holds, settled ones included", () => {
    const store = new AgentSpawnStore();
    // Retained spawns still own their ids.
    store.add(storeSpawn("taken001", SETTLED));
    store.add(storeSpawn("taken002", SPAWNED));
    const candidates = ["taken001", "taken002", "free0003"];
    let minted = 0;

    const id = store.mint(() => candidates[minted++]!);

    expect(id).toBe("free0003");
    expect(minted).toBe(3);
  });

  it("throws loudly when every attempt is taken rather than reusing an id", () => {
    const store = new AgentSpawnStore();
    store.add(storeSpawn("taken001", SPAWNED));

    expect(() => store.mint(() => "taken001")).toThrow(SpawnIdExhaustedError);
    // Failed mint leaves the original untouched.
    expect(store.list().map((spawn) => spawn.id)).toEqual(["taken001"]);
  });

  it("the manager mints through the store, so its ids never collide", () => {
    const store = new AgentSpawnStore();
    const manager = new AgentManager();
    const id = manager.mintSpawnId();
    store.add(storeSpawn(id, SPAWNED));

    expect(manager.mintSpawnId()).not.toBe(id);
    manager.dispose();
  });
});

/* ── The store itself ──────────────────────────────────────────────────── */

describe("AgentSpawnStore", () => {
  it("registers a spawn and returns it by id", () => {
    const store = new AgentSpawnStore();
    const spawn = storeSpawn("agent-1", SPAWNED);
    store.add(spawn);
    expect(store.get("agent-1")).toBe(spawn);
    expect(store.get("missing")).toBeUndefined();
  });

  it("stores the spawn itself, never a copy — the session mutates it in place", () => {
    const store = new AgentSpawnStore();
    const spawn = storeSpawn("agent-1", QUEUED);
    store.add(spawn);
    // Retention stores; it never copies.
    spawn.lifecycle = SPAWNED;
    expect(store.get("agent-1")).toBe(spawn);
    expect(store.get("agent-1")!.lifecycle).toEqual(SPAWNED);
    expect(store.list()).toEqual([spawn]);
  });

  it("throws on a duplicate id and leaves the original spawn intact", () => {
    const store = new AgentSpawnStore();
    const original = storeSpawn("agent-1", SPAWNED);
    const impostor = storeSpawn("agent-1", SETTLED);
    store.add(original);

    // Overwriting would destroy the live spawn and its execution.
    expect(() => store.add(impostor)).toThrow(SpawnIdCollisionError);
    expect(() => store.add(impostor)).toThrow(/already registered/);
    expect(store.get("agent-1")).toBe(original);
    expect(store.list()).toEqual([original]);
  });

  it("rejects a duplicate id even for the very same object", () => {
    const store = new AgentSpawnStore();
    const spawn = storeSpawn("agent-1", SETTLED);
    store.add(spawn);

    // Identity is the id, not the object.
    expect(() => store.add(spawn)).toThrow(SpawnIdCollisionError);
    expect(store.list()).toEqual([spawn]);
  });

  it("drops by id and lists what remains", () => {
    const store = new AgentSpawnStore();
    const one = storeSpawn("agent-1", SETTLED);
    const two = storeSpawn("agent-2", SPAWNED);
    store.add(one);
    store.add(two);
    expect(store.list()).toEqual([one, two]);
    store.drop("agent-1");
    expect(store.get("agent-1")).toBeUndefined();
    expect(store.list()).toEqual([two]);
    // Unknown ids are a no-op drop.
    store.drop("missing");
    expect(store.list()).toEqual([two]);
  });

  it("lists all phases by default and scopes to the phases asked for", () => {
    const store = new AgentSpawnStore();
    const queued = storeSpawn("agent-queued", QUEUED);
    const spawned = storeSpawn("agent-spawned", SPAWNED);
    const settled = storeSpawn("agent-settled", SETTLED);
    for (const spawn of [queued, spawned, settled]) store.add(spawn);

    expect(store.list()).toEqual([queued, spawned, settled]);
    expect(store.list(ALL_AGENT_PHASES)).toEqual([queued, spawned, settled]);
    // Active-only scope excludes settled spawns.
    expect(store.list(ACTIVE_AGENT_PHASES)).toEqual([queued, spawned]);
    expect(store.list(TERMINAL_AGENT_PHASES)).toEqual([settled]);
    // All phases is the two scopes together.
    expect(ALL_AGENT_PHASES).toEqual([
      ...ACTIVE_AGENT_PHASES,
      ...TERMINAL_AGENT_PHASES,
    ]);
  });
});

/* ── Retention through the manager ────────────────────────────────────── */

describe("spawn retention through the manager", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    getPiInstanceMock.mockReset().mockReturnValue({});
    getStoreMock.mockReset().mockReturnValue({ agent: {} });
    stopAgentAndWaitMock.mockReset().mockResolvedValue(true);
    getAgentInfoMock.mockReset().mockResolvedValue({
      state: "working",
      paneId: "w1:p1",
      interactiveReady: true,
    });
    closePaneMock.mockReset().mockResolvedValue(undefined);
    buildLaunchPlanMock.mockReset();
    isWorktreeDirtyMock.mockReset().mockResolvedValue(false);
    removeGitWorktreeMock.mockReset().mockResolvedValue(true);
    deleteWorktreeBranchMock.mockReset().mockResolvedValue({
      kind: "deleted",
    } satisfies BranchCleanupResult);
    removeHerdrWorktreeMock.mockReset().mockResolvedValue(true);
    resolveMainCheckoutMock.mockReset().mockResolvedValue("/work/repo");
    for (const spawn of shared.store.list()) shared.store.drop(spawn.id);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("the id a spawn reports is the handle stop/cleanup accept", async () => {
    // Non-8-char id: the whole handle must print and resolve (exact Map.get).
    const spawnId = "abc12345-longer-handle";
    const { manager, id } = await spawnAndSettle({
      worktree: true,
      id: spawnId,
    });
    expect(id).toBe(spawnId);

    // The lookup cleanup_cowboy_agent performs before cleaning up.
    expect(manager.getSpawn(id)).toBeDefined();

    manager.dispose();
    const fresh = new AgentManager();
    const report = await fresh.cleanup(id);

    expect(report).toMatchObject({
      agentId: spawnId,
      worktree: { kind: "removed", path: WT_PATH },
    });
    expect(fresh.getSpawn(id)).toBeUndefined();
    fresh.dispose();
  });

  it("registers the spawn at creation, before the run starts", () => {
    const { id, spawn } = spawnQueued();

    expect(spawn.lifecycle.phase).toBe("queued");
    expect(shared.store.get(id)).toBe(spawn);
  });

  it("a settled run stays registered — the store holds the settled spawn itself", async () => {
    const { id, spawn } = await spawnAndSettle();

    expect(shared.store.get(id)).toBe(spawn);
    expect(shared.store.list()).toEqual([spawn]);
  });

  it("the live-only list hides settled spawns while the all-phase list keeps them", async () => {
    const settled = await spawnAndSettle();
    const queued = spawnQueued();

    expect(
      settled.manager.listAgents(ACTIVE_AGENT_PHASES).map((r) => r.id),
    ).toEqual([queued.id]);
    expect(
      settled.manager
        .listAgents(ALL_AGENT_PHASES)
        .map((r) => r.id)
        .sort(),
    ).toEqual([queued.id, settled.id].sort());
    // Default lists the full retained set.
    expect(
      settled.manager
        .listAgents()
        .map((r) => r.id)
        .sort(),
    ).toEqual([queued.id, settled.id].sort());
    settled.manager.dispose();
    queued.manager.dispose();
  });

  it("dispose() clears the runtime sessions but the store keeps the spawn, and a new manager still cleans it up", async () => {
    const { manager, id } = await spawnAndSettle({ worktree: true });

    manager.dispose();
    expect(manager.listAgents(ACTIVE_AGENT_PHASES)).toEqual([]);
    expect(shared.store.get(id)).toBeDefined();

    // Fresh manager on the same store, as after a session replacement.
    const fresh = new AgentManager();
    expect(fresh.getSpawn(id)).toBeDefined();
    expect(fresh.listAgents().map((spawn) => spawn.id)).toEqual([id]);

    const report = await fresh.cleanup(id);

    expect(report).toMatchObject({
      agentId: id,
      source: "tracked",
      settlement: { kind: "recorded", phase: "settled" },
      pane: { kind: "closed", paneId: "w1:p1" },
      worktree: { kind: "removed", path: WT_PATH },
      branch: { kind: "deleted" },
    });
    expect(removeHerdrWorktreeMock).toHaveBeenCalledWith({}, "w1");
    // Cleanup success drops the store entry.
    expect(fresh.getSpawn(id)).toBeUndefined();
    expect(shared.store.get(id)).toBeUndefined();
    // A retry reports the agent as gone.
    await expect(fresh.cleanup(id)).rejects.toThrow(`Agent ${id} not found.`);
    fresh.dispose();
  });

  it.each(["dirty", "unverifiable"] as const)(
    "a %s tree keeps the report's refusal reason and the retained spawn",
    async (tree) => {
      isWorktreeDirtyMock.mockResolvedValue(
        tree === "dirty" ? true : undefined,
      );
      const { manager, id } = await spawnAndSettle({ worktree: true });

      manager.dispose();
      const fresh = new AgentManager();
      const report = await fresh.cleanup(id);

      expect(report.worktree).toEqual({ kind: "kept", path: WT_PATH });
      expect(report.outcome).toEqual({
        kind: "refused",
        reason:
          tree === "dirty"
            ? { kind: "dirty" }
            : { kind: "unverifiable", detail: "git status probe failed" },
      });
      // Kept tree keeps its spawn.
      expect(shared.store.get(id)).toBeDefined();
      expect(fresh.getSpawn(id)).toBeDefined();
      fresh.dispose();
    },
  );

  it("a queued stop keeps the spawn (it already owns its worktree)", async () => {
    const { manager, id, spawn } = spawnQueued();
    expect(spawn.lifecycle.phase).toBe("queued");

    await expect(manager.abort(id, "user")).resolves.toBe(true);

    expect(spawn.lifecycle).toMatchObject({
      phase: "never-started",
      status: "stopped",
    });
    expect(spawn.lifecycle.phase).toBe("never-started");
    expect(shared.store.get(id)).toBe(spawn);
    manager.dispose();
  });

  it("a start that never happened leaves no spawn behind", () => {
    const registry = {
      admitSpawn: () => ({
        kind: "start" as const,
        reservation: [{ limit: 1, spawned: 0 }],
      }),
      reserve: () => {
        throw new Error("start boom");
      },
      release: async () => {},
      clearQueue: () => {},
    };
    const manager = new AgentManager(
      undefined,
      undefined,
      registry as unknown as HerdrTaskRegistry,
    );

    expect(() =>
      manager.spawn({} as never, {} as never, "general-purpose", "do it", {
        spawnId: nextSpawnId(),
        description: "do it",
        modelSelection: testSelection(),
      } as never),
    ).toThrow("start boom");

    // Failed start drops the registered spawn: no orphan trips dedup.
    expect(manager.listAgents()).toEqual([]);
    manager.dispose();
  });

  it("a duplicate id throws out of spawn and releases the granted admission", () => {
    // Refused id gives the granted admission back instead of leaking.
    shared.store.add(storeSpawn("dup00001", SPAWNED));
    const release = vi.fn(async () => {});
    const registry = {
      admitSpawn: () => ({ kind: "queue" as const }),
      reserve: () => {},
      release,
      cancelQueued: vi.fn(),
      clearQueue: () => {},
    };
    const manager = new AgentManager(
      undefined,
      undefined,
      registry as unknown as HerdrTaskRegistry,
    );

    expect(() =>
      manager.spawn({} as never, {} as never, "general-purpose", "do it", {
        spawnId: "dup00001",
        description: "do it",
        modelSelection: testSelection(),
        orchestration: TEST_ORCHESTRATION,
      }),
    ).toThrow(SpawnIdCollisionError);
    expect(release).toHaveBeenCalledWith("dup00001");
    // The original spawn is intact.
    expect(manager.listAgents()).toEqual([shared.store.get("dup00001")]);
    manager.dispose();
  });

  it("dropSpawn on a terminal spawn removes the store entry", async () => {
    const { manager, id, spawn } = await spawnAndSettle();
    expect(shared.store.get(id)).toBe(spawn);

    manager.dropSpawn(spawn);

    expect(manager.getSpawn(id)).toBeUndefined();
    expect(shared.store.get(id)).toBeUndefined();
  });

  it("Clear drops the store entry, including for a spawn whose session is gone", async () => {
    const { manager, id } = await spawnAndSettle();
    expect(manager.getSpawn(id)).toBeDefined();

    manager.dispose();
    const fresh = new AgentManager();

    await expect(fresh.clear(id)).resolves.toEqual({ kind: "cleared" });
    expect(shared.store.get(id)).toBeUndefined();
    fresh.dispose();
  });
});

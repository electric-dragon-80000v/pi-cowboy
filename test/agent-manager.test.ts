/**
 * agent-manager.test.ts — Fleet spawn → settle plumbing per terminal outcome.
 * A failed launch settles the spawn; a spawned agent is never touched.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  AgentManager,
  DISPOSE_QUEUED_MESSAGE,
  type AgentManagerTransport,
  type SpawnOptions,
} from "../src/agents/agent-manager.js";
import type {
  ConcurrencyPool,
  HerdrTaskRegistry,
  PoolReservation,
} from "../src/task-registry.js";
import { HerdrTaskRegistry as HerdrTaskRegistryImpl } from "../src/task-registry.js";
import type { SpawnIntent } from "../src/spawn/spawn-coordinator.js";
import type { OrchestratorConfig } from "../src/orchestrators/types.js";
import { DEFAULT_ORCHESTRATORS } from "../src/orchestrators/default-orchestrators.js";
import type { AgentSpawn, ModelSelection } from "../src/types.js";
import type { AgentHost, AgentHostRef } from "../src/agents/agent-host.js";
import type { DeliverableReport, SubagentIPC } from "../src/subagent/ipc.js";
import { AgentSpawnStore } from "../src/agents/agent-spawn-store.js";
import { ACTIVE_AGENT_PHASES } from "../src/types.js";
import { nextSpawnId } from "./helpers/spawn-ids.js";
import { TEST_ORCHESTRATION } from "./helpers/orchestration.js";

/** A paired model selection for spawns that opt into concurrency slots. */
function testSelection(): ModelSelection {
  return {
    model: { provider: "test", id: "model" } as unknown as Model<Api>,
    key: "test/model",
  };
}

/** Orchestration template: the type carries the whole config. */
const OPS_TEMPLATE: OrchestratorConfig = {
  ...DEFAULT_ORCHESTRATORS.default,
  name: "ops:sprint-4/review",
};

const { getStoreMock, getAgentInfoMock, buildLaunchPlanMock } = vi.hoisted(
  () => ({
    getStoreMock: vi.fn(() => ({ agent: {} })),
    getAgentInfoMock: vi.fn(),
    buildLaunchPlanMock: vi.fn(),
  }),
);

vi.mock("../src/agents/agent-runner.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/agents/agent-runner.js")>();
  return { ...actual, buildLaunchPlan: buildLaunchPlanMock };
});

/** The real store the mocked shell hands to every manager. */
const shared = vi.hoisted(() => ({
  store: undefined as unknown as AgentSpawnStore,
}));

vi.mock("../src/shell.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/shell.js")>();
  const { AgentSpawnStore: Store } =
    await import("../src/agents/agent-spawn-store.js");
  shared.store = new Store();
  return {
    ...actual,
    getPiInstance: () => ({}),
    getStore: getStoreMock,
    // Tests drive a real store: the whole spawn surface reads this one.
    getAgentSpawns: () => shared.store,
  };
});

/** Each test starts from an empty shell-owned store. */
beforeEach(() => {
  for (const spawn of shared.store.list()) shared.store.drop(spawn.id);
});

describe("AgentManager supervisor launch→watch seam", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    getAgentInfoMock.mockReset().mockResolvedValue({
      state: "working",
      paneId: "w1:p1",
      interactiveReady: true,
    });
    getStoreMock.mockReset().mockReturnValue({
      agent: {},
    });
  });

  afterEach(() => vi.useRealTimers());

  class ScriptedIpc implements SubagentIPC {
    /** Reads served, so a test can show the watch outlives settlement. */
    reads = 0;
    private content: string | null;
    private stamp = 0;

    constructor(kind: "completed" | "none") {
      this.content = kind === "completed" ? "done" : null;
    }

    /** Write a later report, moving its stamp so the watch reads it as news. */
    write(content: string): void {
      this.content = content;
      this.stamp += 1;
    }

    async readDeliverable(): Promise<DeliverableReport | null> {
      this.reads += 1;
      return this.content === null
        ? null
        : { content: this.content, mtime: this.stamp };
    }
    async steer(): Promise<void> {}
  }

  it("releases the placement when supervisor start fails", async () => {
    const pool = { limit: 1, spawned: 0 };
    const registry = {
      admitSpawn: () => ({ kind: "start" as const, reservation: [pool] }),
      reserve: () => {},
      release: async () => {},
      clearQueue: () => {},
    };
    const released: Array<{ ref: AgentHostRef; scope: string }> = [];
    const manager = new AgentManager(
      undefined,
      undefined,
      registry as unknown as HerdrTaskRegistry,
      {
        createHost: () =>
          ({
            hostAt: async () => ({
              engine: "herdr",
              name: "cow-seam-01234567",
              paneId: "w1:p1",
              tabId: "w1:t1",
              workspaceId: "w1",
              paneCreated: true,
            }),
            start: async () => {
              throw new Error("start failed");
            },
            release: async (ref: AgentHostRef, scope: string) => {
              released.push({ ref, scope });
              return true;
            },
          }) as unknown as AgentHost,
        createIpc: () => new ScriptedIpc("completed"),
      },
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
        description: "do it",
        spawnId: nextSpawnId(),
        orchestration: TEST_ORCHESTRATION,
      },
    );
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();
    const spawn = manager.getSpawn(id)!;
    await expect(spawn.execution.promise).resolves.toBe("");
    expect(spawn.lifecycle).toMatchObject({
      phase: "settled",
      status: "error",
    });
    expect(released).toEqual([
      {
        ref: {
          engine: "herdr",
          name: "cow-seam-01234567",
          paneId: "w1:p1",
          tabId: "w1:t1",
          workspaceId: "w1",
          paneCreated: true,
        },
        scope: "placement",
      },
    ]);
    manager.dispose();
  });

  it("forwards the authored guidance into the launch plan options", async () => {
    const pool = { limit: 1, spawned: 0 };
    const registry = {
      admitSpawn: () => ({ kind: "start" as const, reservation: [pool] }),
      reserve: () => {},
      release: async () => {},
      clearQueue: () => {},
    };
    const manager = new AgentManager(
      undefined,
      undefined,
      registry as unknown as HerdrTaskRegistry,
      {
        createHost: () =>
          ({
            hostAt: async () => ({
              engine: "herdr",
              name: "cow-seam-01234567",
              paneId: "w1:p1",
              tabId: "w1:t1",
              workspaceId: "w1",
              paneCreated: true,
            }),
            start: async () => {
              throw new Error("start failed");
            },
            release: async () => true,
          }) as unknown as AgentHost,
        createIpc: () => new ScriptedIpc("completed"),
      },
    );
    buildLaunchPlanMock.mockResolvedValue({
      cwd: "/repo",
      initialMessage: "@/tmp/briefing.md",
      resultFile: "/tmp/result.md",
      piArgs: [],
      harness: "pi",
    });

    buildLaunchPlanMock.mockClear();
    const guidance = "Review your own diff before committing.";
    manager.spawn({} as never, {} as never, "general-purpose", "do it", {
      description: "do it",
      spawnId: nextSpawnId(),
      orchestration: { ...OPS_TEMPLATE, guidance },
    });
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();

    expect(buildLaunchPlanMock).toHaveBeenCalledOnce();
    // Template config stays parent-side; only guidance enters the plan.
    expect(buildLaunchPlanMock.mock.calls[0]![4]).toMatchObject({
      agentGuidance: guidance,
    });
    expect(buildLaunchPlanMock.mock.calls[0]![4]).not.toHaveProperty(
      "orchestration",
    );
    manager.dispose();
  });

  it("settles a completed run through launch, report watch, gate, slot release, and nudge", async () => {
    const stopCalls: Array<{ paneId: string }> = [];
    const host = {
      hostAt: async () => ({
        engine: "herdr",
        name: "cow-fix-login-flow-01234567",
        paneId: "w1:p1",
        tabId: "w1:t1",
        workspaceId: "w1",
        paneCreated: true,
      }),
      release: async () => true,
      start: async () => {},
      stop: async (ref: AgentHostRef) => {
        stopCalls.push({ paneId: ref.paneId });
        return true;
      },
      // Herdr state never settles: the agent's own report decides.
      observe: async () => ({ state: "working" }),
    } as unknown as AgentHost;
    let ipc: ScriptedIpc | undefined;
    const transport: AgentManagerTransport = {
      createHost: () => host,
      createIpc: () => {
        ipc = new ScriptedIpc("completed");
        return ipc;
      },
    };
    const pool = { limit: 1, spawned: 0 };
    const released: string[] = [];
    const registry = {
      admitSpawn: () => ({ kind: "start" as const, reservation: [pool] }),
      reserve: () => {
        pool.spawned++;
      },
      release: async (id: string) => {
        released.push(id);
        pool.spawned--;
      },
      clearQueue: () => {},
    };
    const nudges: AgentSpawn[] = [];
    const followUps: Array<{ id: string; deliverable: string }> = [];
    const manager = new AgentManager(
      (spawn) => nudges.push(spawn),
      undefined,
      registry as unknown as HerdrTaskRegistry,
      transport,
    );
    manager.setOnFollowUp((followedUp, deliverable) =>
      followUps.push({ id: followedUp.id, deliverable }),
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
        description: "do it",
        spawnId: nextSpawnId(),
        modelSelection: testSelection(),
        orchestration: TEST_ORCHESTRATION,
      },
    );
    // The report settles on the second poll: the first sighting is held.
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(4_000);
    const spawn = manager.getSpawn(id)!;
    await expect(spawn.execution.promise).resolves.toBe("done");

    expect(spawn.lifecycle).toMatchObject({
      phase: "settled",
      status: "completed",
    });
    expect(pool.spawned).toBe(0);
    expect(released).toEqual([id]);
    expect(nudges).toEqual([spawn]);
    expect(followUps).toEqual([]);

    // Settlement does not end the watch: the run's later report reaches the
    // follow-up seam without settling or re-notifying.
    ipc!.write("and one more thing");
    await vi.advanceTimersByTimeAsync(4_000);
    expect(followUps).toEqual([{ id, deliverable: "and one more thing" }]);
    expect(nudges).toEqual([spawn]);
    expect(stopCalls).toEqual([]);
    manager.dispose();
  });

  it("keeps a spawn whose agent vanished from herdr spawned until an explicit stop", async () => {
    // Report-only: a run that never reports stays live.
    const stopCalls: string[] = [];
    const host = {
      hostAt: async () => ({
        engine: "herdr",
        name: "cow-vanished-01234567",
        paneId: "w1:p1",
        tabId: "w1:t1",
        workspaceId: "w1",
        paneCreated: true,
      }),
      release: async () => true,
      start: async () => {},
      // The registry never knows this agent.
      observe: async () => undefined,
      stop: async (ref: AgentHostRef) => {
        stopCalls.push(ref.paneId);
        return true;
      },
    } as unknown as AgentHost;
    let ipc: ScriptedIpc | undefined;
    const transport: AgentManagerTransport = {
      createHost: () => host,
      createIpc: () => {
        ipc = new ScriptedIpc("none");
        return ipc;
      },
    };
    const pool = { limit: 1, spawned: 1 };
    const released: string[] = [];
    const registry = {
      admitSpawn: () => ({ kind: "start" as const, reservation: [pool] }),
      reserve: () => {},
      release: async (id: string) => {
        released.push(id);
        pool.spawned--;
      },
      clearQueue: () => {},
    };
    const nudges: AgentSpawn[] = [];
    const manager = new AgentManager(
      (spawn) => nudges.push(spawn),
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
        description: "do it",
        spawnId: nextSpawnId(),
        modelSelection: testSelection(),
        orchestration: TEST_ORCHESTRATION,
      },
    );
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();
    const spawn = manager.getSpawn(id)!;

    // Ten report-less polls settle nothing.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(spawn.lifecycle).toMatchObject({ phase: "spawned" });
    expect(spawn.lifecycle.phase).toBe("spawned");
    expect(stopCalls).toEqual([]);
    expect(nudges).toEqual([]);

    // Only the explicit stop ends the run.
    await expect(manager.abort(id, "user")).resolves.toBe(true);
    await expect(spawn.execution.promise).resolves.toBe("");
    expect(spawn.lifecycle).toMatchObject({
      phase: "settled",
      status: "stopped",
      stop: { initiator: "user" },
    });
    expect(stopCalls).toEqual(["w1:p1"]);
    expect(released).toEqual([id]);
    manager.dispose();
  });
});

describe("AgentManager.spawn start failure", () => {
  it("releases the reserved slot and drops the spawn when the session start throws", () => {
    const pool = { limit: 1, spawned: 0 };
    let reserved = 0;
    const released: string[] = [];
    // Structural fake: the session's first start step throws, and the sync
    // release lands before the throw reaches the caller.
    const registry = {
      admitSpawn: () => ({ kind: "start" as const, reservation: [pool] }),
      reserve: () => {
        reserved++;
        pool.spawned++;
        throw new Error("start boom");
      },
      release: async (id: string) => {
        released.push(id);
        pool.spawned = Math.max(0, pool.spawned - 1);
      },
    };
    const manager = new AgentManager(
      undefined,
      undefined,
      registry as unknown as HerdrTaskRegistry,
    );

    expect(() =>
      manager.spawn({} as never, {} as never, "general-purpose", "do it", {
        description: "do it",
        spawnId: nextSpawnId(),
        modelSelection: testSelection(),
      } as SpawnOptions),
    ).toThrow("start boom");

    // Freed pool: a retry can start. No orphan trips dedup.
    expect(reserved).toBe(1);
    expect(pool.spawned).toBe(0);
    expect(released).toHaveLength(1);
    expect(manager.listAgents()).toEqual([]);
  });
});

describe("AgentManager.spawn orchestration designator", () => {
  /** Queue without launching: off the herdr transport entirely. */
  function makeQueuedManager(): AgentManager {
    const registry = {
      admitSpawn: () => ({ kind: "queue" as const }),
      clearQueue: () => {},
    };
    return new AgentManager(
      undefined,
      undefined,
      registry as unknown as HerdrTaskRegistry,
    );
  }

  it("copies a supplied orchestration onto the spawn's display info", () => {
    const manager = makeQueuedManager();
    const id = manager.spawn(
      {} as never,
      {} as never,
      "general-purpose",
      "do it",
      {
        description: "do it",
        spawnId: nextSpawnId(),
        // Template names are opaque, never normalized.
        orchestration: OPS_TEMPLATE,
      } as SpawnOptions,
    );

    expect(manager.getSpawn(id)!.display.orchestration).toEqual(OPS_TEMPLATE);
    manager.dispose();
  });

  it("survives the registry's intent → spawn-options handoff", async () => {
    // The registry spreads intent extras into SpawnOptions; orchestration rides along.
    let captured: SpawnOptions | undefined;
    const registry = new HerdrTaskRegistryImpl({
      listAgents: () => [],
      spawn: (_type, _prompt, options) => {
        captured = options;
        return "0123456789abcdef0";
      },
      getSpawn: () => undefined,
      findTaskAttempts: async () => [],
    });
    const intent: SpawnIntent = {
      type: "general-purpose",
      prompt: "do it",
      description: "do it",
      spawnId: nextSpawnId(),
      runInBackground: true,
      orchestration: OPS_TEMPLATE,
    };

    await registry.admit(intent);

    expect(captured!.orchestration).toEqual(OPS_TEMPLATE);
  });
});

/** Fleet routing: admission, ordering, clearing, steer, disposal. */
describe("AgentManager fleet routing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    getStoreMock.mockReset().mockReturnValue({
      agent: {},
    });
    buildLaunchPlanMock.mockReset().mockResolvedValue({
      cwd: "/repo",
      initialMessage: "@/tmp/briefing.md",
      resultFile: "/tmp/result.md",
      piArgs: [],
      harness: "pi",
    });
  });

  afterEach(() => vi.useRealTimers());

  /** Routing suites assert routing, never the file plane. */
  class FleetScriptedIpc implements SubagentIPC {
    async readDeliverable(): Promise<DeliverableReport | null> {
      return { content: "done", mtime: 1 };
    }
    async steer(): Promise<void> {}
  }

  /** A host that never materializes a placement: launch stays pending. */
  function hangingTransport(): AgentManagerTransport {
    return {
      createHost: () =>
        ({
          hostAt: () => new Promise(() => {}),
        }) as unknown as AgentHost,
      createIpc: () => new FleetScriptedIpc(),
    };
  }

  /** Registry fake: admits what the test asks, records releases. */
  function recordingRegistry(
    admission: () => {
      kind: "start" | "queue";
      reservation?: PoolReservation;
    },
  ) {
    const released: string[] = [];
    const cancelled: string[] = [];
    const reacquired: Array<{ id: string; modelKey: string | undefined }> = [];
    let captured: {
      id: string;
      start(reservation: PoolReservation): boolean;
    } | null = null;
    const registry = {
      admitSpawn: (
        _modelKey: string | undefined,
        queued: { id: string; start(reservation: PoolReservation): boolean },
      ) => {
        captured = queued;
        return admission();
      },
      reserve: () => {},
      reacquire: (spawn: { id: string }, modelKey: string | undefined) => {
        reacquired.push({ id: spawn.id, modelKey });
      },
      release: async (id: string) => {
        released.push(id);
      },
      cancelQueued: (id: string) => {
        cancelled.push(id);
      },
      clearQueue: () => {},
    };
    return {
      registry,
      released,
      cancelled,
      reacquired,
      capturedStart: () => captured!,
    };
  }

  function spawnQueued(manager: AgentManager): string {
    return manager.spawn({} as never, {} as never, "general-purpose", "do it", {
      description: "do it",
      spawnId: nextSpawnId(),
      modelSelection: testSelection(),
      orchestration: TEST_ORCHESTRATION,
    });
  }

  it("drains a queued spawn through the registry's captured start callback", () => {
    const fake = recordingRegistry(() => ({ kind: "queue" as const }));
    const manager = new AgentManager(
      undefined,
      undefined,
      fake.registry as unknown as HerdrTaskRegistry,
      hangingTransport(),
    );

    const id = spawnQueued(manager);
    const spawn = manager.getSpawn(id)!;
    expect(spawn.lifecycle).toMatchObject({ phase: "queued" });

    const pool: ConcurrencyPool = { limit: 1, spawned: 0 };
    expect(fake.capturedStart().start([pool])).toBe(true);

    expect(manager.getSpawn(id)!.lifecycle).toMatchObject({
      phase: "spawned",
    });
    manager.dispose();
  });

  it("lists agents newest-first by lifecycle start time", () => {
    const fake = recordingRegistry(() => ({ kind: "queue" as const }));
    const manager = new AgentManager(
      undefined,
      undefined,
      fake.registry as unknown as HerdrTaskRegistry,
    );

    vi.setSystemTime(1_000);
    const first = spawnQueued(manager);
    vi.setSystemTime(2_000);
    const second = spawnQueued(manager);
    vi.setSystemTime(3_000);
    const third = spawnQueued(manager);

    expect(manager.listAgents().map((spawn) => spawn.id)).toEqual([
      third,
      second,
      first,
    ]);
    manager.dispose();
  });

  it("refuses clear on a queued session and clears it once terminal", async () => {
    const fake = recordingRegistry(() => ({ kind: "queue" as const }));
    const manager = new AgentManager(
      undefined,
      undefined,
      fake.registry as unknown as HerdrTaskRegistry,
    );
    const id = spawnQueued(manager);

    await expect(manager.clear(id)).resolves.toEqual({
      kind: "refused",
      reason: "not-terminal",
    });

    await manager.abort(id, "user");

    // No owned checkout: nothing to tear down, so the spawn drops outright.
    await expect(manager.clear(id)).resolves.toEqual({ kind: "cleared" });
    expect(manager.getSpawn(id)).toBeUndefined();
    expect(fake.cancelled).toEqual([id]);
  });

  it("refuses clear on a spawned session", async () => {
    const fake = recordingRegistry(() => ({
      kind: "start" as const,
      reservation: [{ limit: 1, spawned: 0 }],
    }));
    const manager = new AgentManager(
      undefined,
      undefined,
      fake.registry as unknown as HerdrTaskRegistry,
      hangingTransport(),
    );
    const id = spawnQueued(manager);
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    expect(manager.getSpawn(id)!.lifecycle).toMatchObject({
      phase: "spawned",
    });

    await expect(manager.clear(id)).resolves.toEqual({
      kind: "refused",
      reason: "not-terminal",
    });
    manager.dispose();
  });

  it("routes steer: an unknown id is refused with a reason, a live session is delivered", async () => {
    const ref: AgentHostRef = {
      engine: "herdr",
      name: "cow-fleet-01234567",
      paneId: "w1:p1",
      tabId: "w1:t1",
      workspaceId: "w1",
      paneCreated: true,
    };
    const deliveries: Array<{ ref: AgentHostRef; message: string }> = [];
    const host = {
      hostAt: async () => ref,
      start: async () => {},
      observe: async () => ({ state: "working" }),
      stop: async () => true,
      release: async () => true,
      deliver: async (deliveryRef: AgentHostRef, message: string) => {
        deliveries.push({ ref: deliveryRef, message });
        return { kind: "submitted" as const };
      },
    } as unknown as AgentHost;
    const fake = recordingRegistry(() => ({
      kind: "start" as const,
      reservation: [{ limit: 1, spawned: 0 }],
    }));
    const manager = new AgentManager(
      undefined,
      undefined,
      fake.registry as unknown as HerdrTaskRegistry,
      { createHost: () => host, createIpc: () => new FleetScriptedIpc() },
    );
    const liveId = spawnQueued(manager);
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();

    // Unknown id: refused with the reason, not a bare false.
    await expect(manager.steer("0123456789abcdef0", "hello")).resolves.toEqual({
      kind: "refused",
      reason: expect.stringContaining("no live session"),
    });

    await expect(manager.steer(liveId, "hello")).resolves.toEqual({
      kind: "delivered",
    });
    expect(deliveries).toEqual([{ ref, message: "hello" }]);
    manager.dispose();
  });

  it("refuses a queued session's steer with the queued reason", async () => {
    const fake = recordingRegistry(() => ({ kind: "queue" as const }));
    const manager = new AgentManager(
      undefined,
      undefined,
      fake.registry as unknown as HerdrTaskRegistry,
    );
    const id = spawnQueued(manager);

    await expect(manager.steer(id, "hello")).resolves.toEqual({
      kind: "refused",
      reason: expect.stringContaining("queued"),
    });
    manager.dispose();
  });

  it("makes a revived agent live again for dedup and nudges on the second settle", async () => {
    const ref: AgentHostRef = {
      engine: "herdr",
      name: "cow-revive-01234567",
      paneId: "w1:p1",
      tabId: "w1:t1",
      workspaceId: "w1",
      paneCreated: true,
    };
    const host = {
      hostAt: async () => ref,
      start: async () => {},
      observe: async () => ({ state: "working" }),
      stop: async () => true,
      release: async () => true,
      deliver: async () => ({ kind: "submitted" as const }),
    } as unknown as AgentHost;
    const fake = recordingRegistry(() => ({
      kind: "start" as const,
      reservation: [{ limit: 1, spawned: 0 }],
    }));
    const nudges: AgentSpawn[] = [];
    const manager = new AgentManager(
      (spawn) => nudges.push(spawn),
      undefined,
      fake.registry as unknown as HerdrTaskRegistry,
      { createHost: () => host, createIpc: () => new FleetScriptedIpc() },
    );
    const id = spawnQueued(manager);
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(4_000);

    expect(nudges).toHaveLength(1);
    expect(shared.store.list(ACTIVE_AGENT_PHASES)).toEqual([]);

    // Owner-only relock targets the per-agent dir, never /tmp itself.
    const reviveDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "cowboy-fleet-revive-"),
    );
    const settledSpawn = manager.getSpawn(id)!;
    const settledLifecycle = settledSpawn.lifecycle;
    if (settledLifecycle.phase !== "settled" || !settledLifecycle.launch) {
      throw new Error("expected a settled run that launched");
    }
    // The revive resumes the run's own report path, so the second turn settles
    // on a report written where the test can read it.
    settledLifecycle.launch.resultFile = path.join(reviveDir, "result.md");

    await expect(manager.steer(id, "one more thing")).resolves.toEqual({
      kind: "delivered",
    });

    // The revived turn is live again, so its pools are charged again.
    expect(fake.reacquired).toEqual([{ id, modelKey: "test/model" }]);

    // Revived runs look live to dispatch again.
    expect(manager.getSpawn(id)!.lifecycle).toMatchObject({
      phase: "spawned",
    });
    expect(shared.store.list(ACTIVE_AGENT_PHASES).map((s) => s.id)).toEqual([
      id,
    ]);

    // Second settlement repeats the completion path.
    await vi.advanceTimersByTimeAsync(4_000);
    expect(nudges).toHaveLength(2);
    expect(manager.getSpawn(id)!.lifecycle).toMatchObject({
      phase: "settled",
      status: "completed",
    });
    manager.dispose();
    fs.rmSync(reviveDir, { recursive: true, force: true });
  });

  it("dispose projects queued sessions as never-started and leaves spawned panes alone", async () => {
    const stopCalls: string[] = [];
    const host = {
      hostAt: async () => ({
        engine: "herdr",
        name: "cow-fleet-01234567",
        paneId: "w1:p1",
        tabId: "w1:t1",
        workspaceId: "w1",
        paneCreated: true,
      }),
      start: async () => {},
      observe: async () => ({ state: "working" }),
      stop: async (ref: AgentHostRef) => {
        stopCalls.push(ref.paneId);
        return true;
      },
      release: async () => true,
    } as unknown as AgentHost;
    let admits = 0;
    const fake = recordingRegistry(() => {
      admits += 1;
      return admits === 1
        ? { kind: "queue" as const }
        : { kind: "start" as const, reservation: [{ limit: 1, spawned: 0 }] };
    });
    const manager = new AgentManager(
      undefined,
      undefined,
      fake.registry as unknown as HerdrTaskRegistry,
      { createHost: () => host, createIpc: () => new FleetScriptedIpc() },
    );
    const queuedId = spawnQueued(manager);
    const spawnedId = spawnQueued(manager);
    const queuedSpawn = manager.getSpawn(queuedId)!;
    const spawnedSpawn = manager.getSpawn(spawnedId)!;
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();
    expect(spawnedSpawn.lifecycle).toMatchObject({ phase: "spawned" });

    manager.dispose();

    await expect(queuedSpawn.execution.promise).resolves.toBe("");
    expect(queuedSpawn.lifecycle).toMatchObject({
      phase: "never-started",
      status: "error",
      error: DISPOSE_QUEUED_MESSAGE,
    });
    // Pane belongs to the run: left running.
    expect(spawnedSpawn.lifecycle).toMatchObject({ phase: "spawned" });
    await expect(spawnedSpawn.execution.promise).resolves.toBe("");
    expect(stopCalls).toEqual([]);
    // Both spawns stay in the store across replacement; only the live one is in flight.
    expect(manager.getSpawn(queuedId)).toBe(queuedSpawn);
    expect(manager.getSpawn(spawnedId)).toBe(spawnedSpawn);
    expect(manager.listAgents()).toHaveLength(2);
    expect(manager.listAgents(ACTIVE_AGENT_PHASES)).toEqual([spawnedSpawn]);
  });
});

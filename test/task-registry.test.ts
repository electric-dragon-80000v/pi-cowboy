/**
 * task-registry.test.ts — HerdrTaskRegistry against a fake manager surface (structural
 * TaskRegistryDeps, no vi.mock). The fake has no stop capability, so every rejection
 * proves the non-destructive guarantee: duplicates die, existing attempts are untouched.
 */

import { describe, expect, it, vi } from "vitest";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  HerdrTaskRegistry,
  type TaskRegistryDeps,
  LiveAttempt,
} from "../src/task-registry.js";
import {
  ConcurrencyPools,
  DEFAULT_CONCURRENCY_LIMIT,
  type ConcurrencyConfig,
  type PoolReservation,
} from "../src/concurrency-pools.js";
import type { SpawnOptions } from "../src/agents/agent-manager.js";
import type { SpawnIntent } from "../src/spawn/spawn-coordinator.js";
import type { AgentSpawn, ModelSelection } from "../src/types.js";
import type { HarnessId } from "../src/agents/harness.js";
import { nextSpawnId } from "./helpers/spawn-ids.js";
import { TEST_ORCHESTRATION } from "./helpers/orchestration.js";

/** A paired model selection for the given "provider/id" concurrency key. */
function selectionFor(key: string): ModelSelection {
  const [provider, id] = key.split("/");
  return {
    model: { provider, id } as unknown as Model<Api>,
    key,
  };
}

/** A complete config from just the levels a test cares about. */
function poolConfig(
  overrides: Partial<ConcurrencyConfig> = {},
): ConcurrencyConfig {
  return {
    default: DEFAULT_CONCURRENCY_LIMIT,
    harnesses: {},
    providers: {},
    models: {},
    ...overrides,
  };
}

/** Fake manager surface mirroring the real admission shape (same circular binding). */
class FakeManager implements TaskRegistryDeps {
  spawns = new Map<string, AgentSpawn>();
  /** The harness every fake spawn resolves to; a test overrides it for non-pi pools. */
  harness: HarnessId = "pi";
  readonly pools: ConcurrencyPools;

  constructor(
    initialConcurrency?: Partial<ConcurrencyConfig>,
    public findTaskAttempts = vi.fn(async () => [] as LiveAttempt[]),
  ) {
    this.pools = new ConcurrencyPools(poolConfig(initialConcurrency));
  }

  listAgents(): AgentSpawn[] {
    return [...this.spawns.values()];
  }

  getSpawn(agentId: string): AgentSpawn | undefined {
    return this.spawns.get(agentId);
  }

  queuePosition(agentId: string): number {
    return this.pools.queuePosition(agentId);
  }

  spawn(_type: string, _prompt: string, options: SpawnOptions): string {
    const id = `a${this.spawns.size + 1}`;
    const spawn = {
      id,
      lifecycle: { phase: "queued", queuedAt: Date.now() },
      display: {
        type: "general-purpose",
        description: "",
        taskSlug: options.taskSlug,
      },
    } as unknown as AgentSpawn;
    const admission = this.pools.admitSpawn(
      { harness: this.harness, modelKey: options.modelSelection?.key },
      { id, start: (reservation) => this.startQueued(id, reservation) },
    );
    this.spawns.set(id, spawn);
    if (admission.kind === "queue") return id;
    this.startQueued(id, admission.reservation);
    return id;
  }

  startQueued(id: string, reservation: PoolReservation | undefined): boolean {
    const spawn = this.spawns.get(id);
    if (!spawn || spawn.lifecycle.phase !== "queued") return false;
    if (reservation) this.pools.reserve(id, reservation);
    spawn.lifecycle = {
      phase: "spawned",
      startedAt: Date.now(),
    };
    return true;
  }

  /** Settle a spawned agent the way the manager's finishSettlement does. */
  async settle(agentId: string): Promise<void> {
    const spawn = this.spawns.get(agentId);
    if (!spawn) return;
    spawn.lifecycle = {
      phase: "settled",
      startedAt: 1_700_000_000_000,
      status: "completed",
      result: "done",
      completedAt: Date.now(),
    };
    this.pools.release(agentId);
  }
}

/** Registry + fake manager pair. */
function makePair(initialConcurrency?: Partial<ConcurrencyConfig>): {
  registry: HerdrTaskRegistry;
  manager: FakeManager;
} {
  const manager = new FakeManager(initialConcurrency);
  const registry = new HerdrTaskRegistry(manager);
  return { registry, manager };
}

/** Live backend attempt: identity only, nothing here can end it. */
function liveAttempt(name: string): LiveAttempt {
  return { name };
}

function intent(overrides: Partial<SpawnIntent> = {}): SpawnIntent {
  return {
    type: "general-purpose",
    prompt: "do it",
    runInBackground: true,
    description: "some task",
    taskSlug: "fix-login-flow",
    spawnId: nextSpawnId(),
    orchestration: TEST_ORCHESTRATION,
    // A model selection adds its model and provider pools; every spawn counts against the global pool.
    modelSelection: selectionFor("freebuff/gpt-5.2"),
    ...overrides,
  };
}

describe("HerdrTaskRegistry.admit", () => {
  it("admits a fresh task with a spawned agent", async () => {
    const { registry, manager } = makePair();
    const admission = await registry.admit(intent());
    expect(admission).toEqual({ status: "admitted", agentId: "a1" });
    expect(manager.getSpawn("a1")?.lifecycle.phase).toBe("spawned");
  });

  it("queues a spawn behind the concurrency limit with a FIFO position", async () => {
    const { registry, manager } = makePair({ default: 1 });
    await registry.admit(intent());
    // A different slug queues; same-slug duplicates are dedup-rejected, never queued.
    const second = await registry.admit(intent({ taskSlug: "second-task" }));
    expect(second).toEqual({
      status: "queued",
      agentId: "a2",
      queuePosition: 1,
    });
    expect(manager.getSpawn("a2")?.lifecycle.phase).toBe("queued");
  });

  it("rejects an already-in-flight in-memory spawn for the same slug", async () => {
    const { registry } = makePair();
    await registry.admit(intent());
    const again = await registry.admit(intent());
    expect(again).toEqual({
      status: "rejected",
      reason: "already_in_flight",
      conflictingId: "a1",
    });
  });

  it("rejects when a live backend attempt owns the slug (parent reload)", async () => {
    const { registry, manager } = makePair();
    manager.findTaskAttempts.mockResolvedValue([
      liveAttempt("cow-fix-login-flow-01234567"),
    ]);
    const admission = await registry.admit(intent());
    expect(admission).toEqual({
      status: "rejected",
      reason: "already_in_flight",
      conflictingId: "cow-fix-login-flow-01234567",
    });
    expect(manager.spawns.size).toBe(0);
  });

  it("rejects a leftover (idle/done) attempt too — it is never reclaimed", async () => {
    // Ownership is binary: a live registry entry always wins, and only the duplicate ends.
    const { registry, manager } = makePair();
    manager.findTaskAttempts.mockResolvedValue([
      liveAttempt("cow-fix-login-flow-01234567"),
    ]);
    const admission = await registry.admit(intent());
    expect(admission).toEqual({
      status: "rejected",
      reason: "already_in_flight",
      conflictingId: "cow-fix-login-flow-01234567",
    });
    expect(manager.spawns.size).toBe(0);
  });

  it("allows distinct slugs concurrently (single-live-agent is per slug)", async () => {
    const { registry } = makePair();
    await registry.admit(intent());
    const other = await registry.admit(intent({ taskSlug: "other-task" }));
    expect(other.status).toBe("admitted");
  });

  it("admits only the first of two concurrent requests for one slug", async () => {
    // The dedup check and the herdr probe straddle an await, so a batch of duplicate
    // task names must not let both items past it.
    const { registry, manager } = makePair();
    const [first, second] = await Promise.all([
      registry.admit(intent()),
      registry.admit(intent()),
    ]);

    expect(first).toEqual({ status: "admitted", agentId: "a1" });
    expect(second).toEqual({
      status: "rejected",
      reason: "already_in_flight",
      conflictingId: "a1",
    });
    expect(manager.spawns.size).toBe(1);
  });

  it("admits a same-slug request once the first one settles", async () => {
    // The chain must not outlive its tail: a settled attempt no longer owns the slug.
    const { registry, manager } = makePair();
    const first = await registry.admit(intent());
    await manager.settle("a1");
    const later = await registry.admit(intent());
    expect(later.status).toBe("admitted");
    expect(later).not.toEqual(first);
  });

  it("admits both concurrent requests for distinct slugs", async () => {
    const { registry, manager } = makePair();
    const [first, second] = await Promise.all([
      registry.admit(intent({ taskSlug: "fix-login-flow" })),
      registry.admit(intent({ taskSlug: "write-docs" })),
    ]);

    expect(first.status).toBe("admitted");
    expect(second.status).toBe("admitted");
    expect(manager.spawns.size).toBe(2);
  });
});

describe("single-live-agent invariants", () => {
  it("in-memory spawn wins over a live backend attempt for the same slug", async () => {
    const { registry, manager } = makePair();
    // The in-memory spawn is the freshest signal, so admit rejects on the spawn.
    await registry.admit(intent());
    manager.findTaskAttempts.mockResolvedValue([
      liveAttempt("cow-fix-login-flow-01234567"),
    ]);
    const again = await registry.admit(intent());
    expect(again).toEqual({
      status: "rejected",
      reason: "already_in_flight",
      conflictingId: "a1",
    });
  });

  it("a queued spawn still owns the task (admit rejects the duplicate)", async () => {
    const { registry } = makePair({ default: 1 });
    await registry.admit(intent());
    await registry.admit(intent({ taskSlug: "second-task" }));
    const duplicate = await registry.admit(intent({ taskSlug: "second-task" }));
    expect(duplicate).toEqual({
      status: "rejected",
      reason: "already_in_flight",
      conflictingId: "a2",
    });
  });
});

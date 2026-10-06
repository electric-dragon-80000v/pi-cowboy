/**
 * task-registry.test.ts — HerdrTaskRegistry against a fake manager surface (structural
 * TaskRegistryDeps, no vi.mock). The fake has no stop capability, so every rejection
 * proves the non-destructive guarantee: duplicates die, existing attempts are untouched.
 */

import { describe, expect, it, vi } from "vitest";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  DEFAULT_CONCURRENCY_LIMIT,
  HerdrTaskRegistry,
  type ConcurrencyConfig,
  type PoolReservation,
  type TaskRegistryDeps,
  LiveAttempt,
} from "../src/task-registry.js";
import type { SpawnOptions } from "../src/agents/agent-manager.js";
import type { SpawnIntent } from "../src/spawn/spawn-coordinator.js";
import type { AgentSpawn, ModelSelection } from "../src/types.js";
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

/** Fake manager surface mirroring the real admission shape (same circular registry binding). */
class FakeManager implements TaskRegistryDeps {
  registry!: HerdrTaskRegistry;
  spawns = new Map<string, AgentSpawn>();

  constructor(
    public findTaskAttempts = vi.fn(async () => [] as LiveAttempt[]),
  ) {}

  listAgents(): AgentSpawn[] {
    return [...this.spawns.values()];
  }

  getSpawn(agentId: string): AgentSpawn | undefined {
    return this.spawns.get(agentId);
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
    const admission = this.registry.admitSpawn(options.modelSelection?.key, {
      id,
      start: (reservation) => this.startQueued(id, reservation),
    });
    this.spawns.set(id, spawn);
    if (admission.kind === "queue") return id;
    this.startQueued(id, admission.reservation);
    return id;
  }

  startQueued(id: string, reservation: PoolReservation | undefined): boolean {
    const spawn = this.spawns.get(id);
    if (!spawn || spawn.lifecycle.phase !== "queued") return false;
    if (reservation) this.registry.reserve(spawn, reservation);
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
    await this.registry.release(agentId);
  }
}

/** Registry + fake manager pair. */
function makePair(initialConcurrency?: ConcurrencyConfig): {
  registry: HerdrTaskRegistry;
  manager: FakeManager;
} {
  const manager = new FakeManager();
  const registry = new HerdrTaskRegistry(manager, initialConcurrency);
  manager.registry = registry;
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

describe("HerdrTaskRegistry.release", () => {
  it("drains the queue FIFO: releasing a slot starts the next queued spawn", async () => {
    const { registry, manager } = makePair({ default: 1 });
    await registry.admit(intent());
    await registry.admit(intent({ taskSlug: "second-task" }));
    await registry.admit(intent({ taskSlug: "third-task" }));
    expect(manager.getSpawn("a2")?.lifecycle.phase).toBe("queued");
    expect(manager.getSpawn("a3")?.lifecycle.phase).toBe("queued");

    await manager.settle("a1");
    expect(manager.getSpawn("a2")?.lifecycle.phase).toBe("spawned");
    expect(manager.getSpawn("a3")?.lifecycle.phase).toBe("queued");

    await manager.settle("a2");
    expect(manager.getSpawn("a3")?.lifecycle.phase).toBe("spawned");
  });

  it("is idempotent for a spawn with no slot (queued-stop leftovers)", async () => {
    const { registry, manager } = makePair({ default: 1 });
    await registry.admit(intent());
    await registry.admit(intent({ taskSlug: "second-task" }));
    registry.cancelQueued("a2");
    await expect(registry.release("a2")).resolves.toBeUndefined();
    expect(manager.getSpawn("a1")?.lifecycle.phase).toBe("spawned");
  });

  it("drops a queue entry whose session can no longer start", async () => {
    const { registry, manager } = makePair({ default: 1 });
    await registry.admit(intent());
    await registry.admit(intent({ taskSlug: "second-task" }));
    await registry.admit(intent({ taskSlug: "third-task" }));
    // The session of a2 ended without a release: the drain cannot start it.
    manager.getSpawn("a2")!.lifecycle = {
      phase: "settled",
      startedAt: 1,
      status: "completed",
      result: "done",
      completedAt: 2,
    };

    await manager.settle("a1");

    // a2 is gone from the queue, so a4's position counts only a3 ahead of it.
    expect(manager.getSpawn("a3")?.lifecycle.phase).toBe("spawned");
    const fourth = await registry.admit(intent({ taskSlug: "fourth-task" }));
    expect(fourth).toEqual({
      status: "queued",
      agentId: "a4",
      queuePosition: 1,
    });
  });

  it("frees the spawned count so capacity returns exactly", async () => {
    const { registry, manager } = makePair({ default: 1 });
    await registry.admit(intent());
    await manager.settle("a1");
    const again = await registry.admit(intent());
    expect(again.status).toBe("admitted");
  });

  it("expanded limits drain the queue via setConcurrency", async () => {
    const { registry, manager } = makePair({ default: 1 });
    await registry.admit(intent());
    await registry.admit(intent({ taskSlug: "second-task" }));
    expect(manager.getSpawn("a2")?.lifecycle.phase).toBe("queued");
    registry.setConcurrency({ default: 2 });
    expect(manager.getSpawn("a2")?.lifecycle.phase).toBe("spawned");
  });
});

describe("HerdrTaskRegistry concurrency levels", () => {
  /** Spawn one agent for the given model key and report the phase it landed in. */
  function spawnFor(
    manager: FakeManager,
    key: string | undefined,
  ): "spawned" | "queued" {
    const id = manager.spawn(
      "general-purpose",
      "x",
      intent({
        taskSlug: `task-${manager.spawns.size + 1}`,
        modelSelection: key === undefined ? undefined : selectionFor(key),
      }),
    );
    return manager.getSpawn(id)!.lifecycle.phase as "spawned" | "queued";
  }

  it("defaults the global pool to DEFAULT_CONCURRENCY_LIMIT", () => {
    const { manager } = makePair();
    const phases = Array.from({ length: DEFAULT_CONCURRENCY_LIMIT + 1 }, () =>
      spawnFor(manager, undefined),
    );
    expect(phases.slice(0, DEFAULT_CONCURRENCY_LIMIT)).toEqual(
      Array(DEFAULT_CONCURRENCY_LIMIT).fill("spawned"),
    );
    expect(phases.at(-1)).toBe("queued");
  });

  it("resolves a spawn's pools as model, provider, then global", () => {
    const { registry } = makePair({
      default: 4,
      providers: { acme: 3 },
      models: { "acme/fast": 1 },
    });
    const pools = (
      registry as unknown as {
        applicablePools(key: string | undefined): PoolReservation;
      }
    ).applicablePools("acme/fast");
    expect(pools.map((pool) => pool.limit)).toEqual([1, 3, 4]);
  });

  it("resolves a spawn without a model selection to the global pool alone", () => {
    const { registry } = makePair({ default: 4, providers: { acme: 3 } });
    const pools = (
      registry as unknown as {
        applicablePools(key: string | undefined): PoolReservation;
      }
    ).applicablePools(undefined);
    expect(pools.map((pool) => pool.limit)).toEqual([4]);
  });

  it("queues when the model pool is full even though provider and global have room", () => {
    const { manager } = makePair({
      default: 4,
      providers: { acme: 4 },
      models: { "acme/fast": 1 },
    });
    expect(spawnFor(manager, "acme/fast")).toBe("spawned");
    expect(spawnFor(manager, "acme/fast")).toBe("queued");
    // A different model of the same provider is a different model pool.
    expect(spawnFor(manager, "acme/slow")).toBe("spawned");
  });

  it("queues when the provider pool is full even though model and global have room", () => {
    const { manager } = makePair({ default: 4, providers: { acme: 1 } });
    expect(spawnFor(manager, "acme/first")).toBe("spawned");
    expect(spawnFor(manager, "acme/second")).toBe("queued");
    expect(spawnFor(manager, "other/first")).toBe("spawned");
  });

  it("counts every config-free model against the one global pool", () => {
    const { manager } = makePair({ default: 1 });
    expect(spawnFor(manager, "acme/first")).toBe("spawned");
    expect(spawnFor(manager, "acme/second")).toBe("queued");
  });

  it("counts a spawn with no model selection against the global pool", () => {
    const { manager } = makePair({ default: 1 });
    expect(spawnFor(manager, undefined)).toBe("spawned");
    expect(spawnFor(manager, undefined)).toBe("queued");
  });

  it("approaches independently configured models from the same global pool", () => {
    const { manager } = makePair({
      default: 1,
      models: { "acme/first": 4, "acme/second": 4 },
    });
    expect(spawnFor(manager, "acme/first")).toBe("spawned");
    expect(spawnFor(manager, "acme/second")).toBe("queued");
  });

  it("keeps the running count when a limit is raised", async () => {
    const { registry, manager } = makePair({ default: 2 });
    expect([
      spawnFor(manager, undefined),
      spawnFor(manager, undefined),
    ]).toEqual(["spawned", "spawned"]);
    expect(spawnFor(manager, undefined)).toBe("queued");

    registry.setConcurrency({ default: 3 });

    // Two spawns were running and one queued: the raise has room for exactly the queued one.
    expect(manager.getSpawn("a3")?.lifecycle.phase).toBe("spawned");
    expect(spawnFor(manager, undefined)).toBe("queued");

    await manager.settle("a1");
    expect(manager.getSpawn("a4")?.lifecycle.phase).toBe("spawned");
  });

  it("clamps a limit below one to one", () => {
    const global = makePair({ default: 0 });
    expect(spawnFor(global.manager, undefined)).toBe("spawned");
    expect(spawnFor(global.manager, undefined)).toBe("queued");

    const provider = makePair({ default: 4, providers: { acme: 0 } });
    expect(spawnFor(provider.manager, "acme/first")).toBe("spawned");
    expect(spawnFor(provider.manager, "acme/second")).toBe("queued");
  });

  it("drains a queue whose limit was removed", () => {
    const { registry, manager } = makePair({
      default: 4,
      models: { "acme/fast": 1 },
    });
    expect(spawnFor(manager, "acme/fast")).toBe("spawned");
    expect(spawnFor(manager, "acme/fast")).toBe("queued");

    registry.setConcurrency({ default: 4 });

    expect(manager.getSpawn("a2")?.lifecycle.phase).toBe("spawned");
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

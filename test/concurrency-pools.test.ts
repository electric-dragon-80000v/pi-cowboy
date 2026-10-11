/**
 * concurrency-pools.test.ts — ConcurrencyPools directly, with no task surface:
 * pool-key canonicalization, the four independent levels, FIFO queueing,
 * reservation release, reacquisition, and limit changes. Spawns are a tiny
 * harness over the controller's own admit/reserve/release verbs.
 */

import { describe, expect, it } from "vitest";
import {
  ConcurrencyPools,
  DEFAULT_CONCURRENCY_LIMIT,
  type ConcurrencyConfig,
  type PoolIdentity,
  type PoolReservation,
} from "../src/concurrency-pools.js";
import type { HarnessId } from "../src/agents/harness.js";

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

/** A spawn registry over ConcurrencyPools: ids, phases, and settle. */
class Spawns {
  readonly pools: ConcurrencyPools;
  private n = 0;
  private phases = new Map<string, "spawned" | "queued">();

  constructor(overrides: Partial<ConcurrencyConfig> = {}) {
    this.pools = new ConcurrencyPools(poolConfig(overrides));
  }

  spawn(identity: PoolIdentity): string {
    const id = `a${++this.n}`;
    const admission = this.pools.admitSpawn(identity, {
      id,
      start: (reservation) => this.start(id, reservation),
    });
    if (admission.kind === "queue") {
      this.phases.set(id, "queued");
      return id;
    }
    this.pools.reserve(id, admission.reservation);
    this.phases.set(id, "spawned");
    return id;
  }

  /** Convenience: spawn for one harness and model key, and report the phase. */
  spawnFor(
    key: string | undefined,
    harness: HarnessId = "pi",
  ): "spawned" | "queued" {
    const id = this.spawn({ harness, modelKey: key });
    return this.phases.get(id)!;
  }

  phase(id: string): "spawned" | "queued" | undefined {
    return this.phases.get(id);
  }

  /** End a spawn the way the manager's finishSettlement does. */
  settle(id: string): void {
    this.phases.delete(id);
    this.pools.release(id);
  }

  setConcurrency(overrides: Partial<ConcurrencyConfig> = {}): void {
    this.pools.setConcurrency(poolConfig(overrides));
  }

  private start(id: string, reservation: PoolReservation): boolean {
    // A session that ended without a release refuses its own start.
    if (this.phases.get(id) !== "queued") return false;
    this.pools.reserve(id, reservation);
    this.phases.set(id, "spawned");
    return true;
  }
}

/** Reach the private level resolution the admission math is built on. */
function applicablePools(
  pools: ConcurrencyPools,
  identity: PoolIdentity,
): PoolReservation {
  return (
    pools as unknown as {
      applicablePools(identity: PoolIdentity): PoolReservation;
    }
  ).applicablePools(identity);
}

describe("ConcurrencyPools — release and draining", () => {
  it("drains the queue FIFO: releasing a slot starts the next queued spawn", () => {
    const spawns = new Spawns({ default: 1 });
    const a1 = spawns.spawn({ harness: "pi", modelKey: undefined });
    const a2 = spawns.spawn({ harness: "pi", modelKey: undefined });
    const a3 = spawns.spawn({ harness: "pi", modelKey: undefined });
    expect(spawns.phase(a2)).toBe("queued");
    expect(spawns.phase(a3)).toBe("queued");

    spawns.settle(a1);
    expect(spawns.phase(a2)).toBe("spawned");
    expect(spawns.phase(a3)).toBe("queued");

    spawns.settle(a2);
    expect(spawns.phase(a3)).toBe("spawned");
  });

  it("is idempotent for a spawn with no slot (queued-stop leftovers)", () => {
    const spawns = new Spawns({ default: 1 });
    const a1 = spawns.spawn({ harness: "pi", modelKey: undefined });
    const a2 = spawns.spawn({ harness: "pi", modelKey: undefined });
    spawns.pools.cancelQueued(a2);
    expect(() => spawns.pools.release(a2)).not.toThrow();
    expect(spawns.phase(a1)).toBe("spawned");
  });

  it("drops a queue entry whose session can no longer start", () => {
    const spawns = new Spawns({ default: 1 });
    const a1 = spawns.spawn({ harness: "pi", modelKey: undefined });
    const a2 = spawns.spawn({ harness: "pi", modelKey: undefined });
    const a3 = spawns.spawn({ harness: "pi", modelKey: undefined });
    // The session of a2 ended without a release: the drain cannot start it.
    spawns.settle(a2);

    spawns.settle(a1);

    // a2 is gone from the queue, so a4's position counts only a3 ahead of it.
    expect(spawns.phase(a3)).toBe("spawned");
    const a4 = spawns.spawn({ harness: "pi", modelKey: undefined });
    expect(spawns.phase(a4)).toBe("queued");
    expect(spawns.pools.queuePosition(a4)).toBe(1);
  });

  it("frees the spawned count so capacity returns exactly", () => {
    const spawns = new Spawns({ default: 1 });
    const a1 = spawns.spawn({ harness: "pi", modelKey: undefined });
    spawns.settle(a1);
    expect(spawns.spawnFor(undefined)).toBe("spawned");
  });

  it("expanded limits drain the queue via setConcurrency", () => {
    const spawns = new Spawns({ default: 1 });
    spawns.spawn({ harness: "pi", modelKey: undefined });
    const a2 = spawns.spawn({ harness: "pi", modelKey: undefined });
    expect(spawns.phase(a2)).toBe("queued");
    spawns.setConcurrency({ default: 2 });
    expect(spawns.phase(a2)).toBe("spawned");
  });

  it("reports a queued spawn's FIFO position", () => {
    const spawns = new Spawns({ default: 1 });
    spawns.spawn({ harness: "pi", modelKey: undefined });
    const a2 = spawns.spawn({ harness: "pi", modelKey: undefined });
    const a3 = spawns.spawn({ harness: "pi", modelKey: undefined });
    expect(spawns.pools.queuePosition(a2)).toBe(1);
    expect(spawns.pools.queuePosition(a3)).toBe(2);
    expect(spawns.pools.queuePosition("missing")).toBe(0);
  });
});

describe("ConcurrencyPools — reacquisition", () => {
  it("charges a revived run once and ignores a second revive", () => {
    const spawns = new Spawns({ default: 1 });
    const a1 = spawns.spawn({ harness: "pi", modelKey: undefined });
    const identity: PoolIdentity = { harness: "pi", modelKey: undefined };

    spawns.settle(a1);
    spawns.pools.reacquire(a1, identity);
    // Charged once: a fresh spawn now queues behind the revived run.
    const a2 = spawns.spawn(identity);
    expect(spawns.phase(a2)).toBe("queued");

    // A second reacquire is a no-op, not a second charge.
    spawns.pools.reacquire(a1, identity);
    const [global] = applicablePools(spawns.pools, identity);
    expect(global.spawned).toBe(1);

    // Releasing the revived run lets the queued spawn in.
    spawns.settle(a1);
    expect(spawns.phase(a2)).toBe("spawned");
  });

  it("charges the qualified pools a revive returns to", () => {
    const spawns = new Spawns({
      default: 4,
      harnesses: { opencode: 2 },
      models: { "opencode:acme/fast": 2 },
    });
    const identity: PoolIdentity = {
      harness: "opencode",
      modelKey: "acme/fast",
    };
    const a1 = spawns.spawn(identity);
    spawns.settle(a1);
    spawns.pools.reacquire(a1, identity);

    const reservation = applicablePools(spawns.pools, identity);
    expect(reservation.map((pool) => pool.spawned)).toEqual([1, 1, 1]);
  });
});

describe("ConcurrencyPools — levels", () => {
  it("defaults the global pool to DEFAULT_CONCURRENCY_LIMIT", () => {
    const spawns = new Spawns();
    const phases = Array.from({ length: DEFAULT_CONCURRENCY_LIMIT + 1 }, () =>
      spawns.spawnFor(undefined),
    );
    expect(phases.slice(0, DEFAULT_CONCURRENCY_LIMIT)).toEqual(
      Array(DEFAULT_CONCURRENCY_LIMIT).fill("spawned"),
    );
    expect(phases.at(-1)).toBe("queued");
  });

  it("resolves a spawn's pools as model, provider, harness, then global", () => {
    const pools = new ConcurrencyPools(
      poolConfig({
        default: 4,
        harnesses: { pi: 5 },
        providers: { acme: 3 },
        models: { "acme/fast": 1 },
      }),
    );
    const reservation = applicablePools(pools, {
      harness: "pi",
      modelKey: "acme/fast",
    });
    expect(reservation.map((pool) => pool.limit)).toEqual([1, 3, 5, 4]);
  });

  it("resolves a spawn without a model selection to its harness and global pools", () => {
    const pools = new ConcurrencyPools(
      poolConfig({
        default: 4,
        harnesses: { opencode: 2 },
        providers: { acme: 3 },
      }),
    );
    const reservation = applicablePools(pools, {
      harness: "opencode",
      modelKey: undefined,
    });
    expect(reservation.map((pool) => pool.limit)).toEqual([2, 4]);
  });

  it("names the same pi pool for a bare key and its pi-qualified form", () => {
    const pools = new ConcurrencyPools(
      poolConfig({
        default: 4,
        models: { "acme/fast": 1, "pi:acme/fast": 2 },
      }),
    );
    // Two keys that parse to one pool share it; the later entry wins.
    const reservation = applicablePools(pools, {
      harness: "pi",
      modelKey: "acme/fast",
    });
    expect(reservation.map((pool) => pool.limit)).toEqual([2, 4]);
  });

  it("namespaces the model pool by harness", () => {
    const spawns = new Spawns({
      default: 4,
      models: { "acme/fast": 1, "opencode:acme/fast": 4 },
    });
    expect(spawns.spawnFor("acme/fast", "pi")).toBe("spawned");
    expect(spawns.spawnFor("acme/fast", "pi")).toBe("queued");
    // The opencode pool for the same model is independent of pi's.
    expect(spawns.spawnFor("acme/fast", "opencode")).toBe("spawned");
  });

  it("queues when the harness pool is full even though model and global have room", () => {
    const spawns = new Spawns({
      default: 4,
      harnesses: { opencode: 1 },
      models: { "opencode:acme/fast": 4 },
    });
    expect(spawns.spawnFor("acme/fast", "opencode")).toBe("spawned");
    expect(spawns.spawnFor("acme/slow", "opencode")).toBe("queued");
  });

  it("drains a queued spawn into the harness pool it was queued under", () => {
    const spawns = new Spawns({
      default: 4,
      harnesses: { opencode: 1, pi: 4 },
    });
    const a1 = spawns.spawn({ harness: "opencode", modelKey: undefined });
    const a2 = spawns.spawn({ harness: "opencode", modelKey: undefined });
    expect(spawns.phase(a1)).toBe("spawned");
    expect(spawns.phase(a2)).toBe("queued");

    // The queue entry carried its harness, so the drain re-checks opencode's pool.
    spawns.settle(a1);
    expect(spawns.phase(a2)).toBe("spawned");
  });

  it("queues when the model pool is full even though provider and global have room", () => {
    const spawns = new Spawns({
      default: 4,
      providers: { acme: 4 },
      models: { "acme/fast": 1 },
    });
    expect(spawns.spawnFor("acme/fast")).toBe("spawned");
    expect(spawns.spawnFor("acme/fast")).toBe("queued");
    // A different model of the same provider is a different model pool.
    expect(spawns.spawnFor("acme/slow")).toBe("spawned");
  });

  it("queues when the provider pool is full even though model and global have room", () => {
    const spawns = new Spawns({ default: 4, providers: { acme: 1 } });
    expect(spawns.spawnFor("acme/first")).toBe("spawned");
    expect(spawns.spawnFor("acme/second")).toBe("queued");
    expect(spawns.spawnFor("other/first")).toBe("spawned");
  });

  it("counts every config-free model against the one global pool", () => {
    const spawns = new Spawns({ default: 1 });
    expect(spawns.spawnFor("acme/first")).toBe("spawned");
    expect(spawns.spawnFor("acme/second")).toBe("queued");
  });

  it("counts a spawn with no model selection against the global pool", () => {
    const spawns = new Spawns({ default: 1 });
    expect(spawns.spawnFor(undefined)).toBe("spawned");
    expect(spawns.spawnFor(undefined)).toBe("queued");
  });

  it("approaches independently configured models from the same global pool", () => {
    const spawns = new Spawns({
      default: 1,
      models: { "acme/first": 4, "acme/second": 4 },
    });
    expect(spawns.spawnFor("acme/first")).toBe("spawned");
    expect(spawns.spawnFor("acme/second")).toBe("queued");
  });

  it("keeps the running count when a limit is raised", () => {
    const spawns = new Spawns({ default: 2 });
    expect([spawns.spawnFor(undefined), spawns.spawnFor(undefined)]).toEqual([
      "spawned",
      "spawned",
    ]);
    const a3 = spawns.spawn({ harness: "pi", modelKey: undefined });
    expect(spawns.phase(a3)).toBe("queued");

    spawns.setConcurrency({ default: 3 });

    // Two spawns were running and one queued: the raise has room for exactly the queued one.
    expect(spawns.phase(a3)).toBe("spawned");
    const a4 = spawns.spawn({ harness: "pi", modelKey: undefined });
    expect(spawns.phase(a4)).toBe("queued");

    spawns.settle("a1");
    expect(spawns.phase(a4)).toBe("spawned");
  });

  it("clamps a limit below one to one", () => {
    const global = new Spawns({ default: 0 });
    expect(global.spawnFor(undefined)).toBe("spawned");
    expect(global.spawnFor(undefined)).toBe("queued");

    const provider = new Spawns({ default: 4, providers: { acme: 0 } });
    expect(provider.spawnFor("acme/first")).toBe("spawned");
    expect(provider.spawnFor("acme/second")).toBe("queued");
  });

  it("drains a queue whose limit was removed", () => {
    const spawns = new Spawns({
      default: 4,
      models: { "acme/fast": 1 },
    });
    expect(spawns.spawnFor("acme/fast")).toBe("spawned");
    const a2 = spawns.spawn({ harness: "pi", modelKey: "acme/fast" });
    expect(spawns.phase(a2)).toBe("queued");

    spawns.setConcurrency({ default: 4 });

    expect(spawns.phase(a2)).toBe("spawned");
  });
});

/**
 * concurrency-pools.ts — the resource-rate-limiter half of admission: four
 * independent pool levels, a FIFO queue, and the reservations that give charged
 * capacity back.
 *
 * Shell-free and task-free: it knows nothing about task slugs, dedup, or live
 * backend attempts. A caller states one spawn's harness-qualified `PoolIdentity`
 * and the controller decides "start now" or "queue", charges a reservation, and
 * later releases it. Every external dependency is a value or a callback, so the
 * controller runs directly in tests.
 *
 * A pool key is harness-qualified: a model pool is
 * `<harnessId>:<provider>/<modelId>` and a provider pool is
 * `<harnessId>:<provider>`. A harness pool is the id alone. A bare key — one
 * with no harness qualifier — belongs to pi, so an existing config's keys keep
 * naming exactly the pools they name today.
 */

import {
  DEFAULT_HARNESS,
  parseHarnessId,
  type HarnessId,
} from "./agents/harness.js";

/** The global concurrency limit every spawn counts against. */
export const DEFAULT_CONCURRENCY_LIMIT = 4;

/**
 * The resolved concurrency config. Every level is present — an empty map means
 * "no ceiling at this level" — so a reader never distinguishes an absent level
 * from an empty one.
 *
 * Each level's map holds only the keys that have a ceiling, so each is
 * `Partial<Record<Key, number>>`. For `harnesses` that is what allows one
 * harness without the other three — `Record<HarnessId, number>` would demand
 * all of them. For `providers`/`models` the keys are open-ended strings, and
 * `Partial` keeps a lookup of an unset key honest (`number | undefined`)
 * instead of claiming a number.
 */
export interface ConcurrencyConfig {
  /** The global limit: every spawn counts against it, whatever else also applies. */
  default: number;
  /** Per-harness ceilings keyed by harness id. */
  harnesses: Partial<Record<HarnessId, number>>;
  /** Per-provider ceilings keyed by "provider" or "<harnessId>:<provider>". */
  providers: Partial<Record<string, number>>;
  /** Per-model ceilings keyed by "provider/modelId" or "<harnessId>:<provider>/<modelId>". */
  models: Partial<Record<string, number>>;
}

/**
 * A concurrency pool's identity, parsed from a config key or built from a
 * spawn's harness and bare model key. The three halves are kept apart so every
 * reader reads the same parse.
 */
export type PoolKey =
  | { kind: "model"; harness: HarnessId; provider: string; model: string }
  | { kind: "provider"; harness: HarnessId; provider: string };

/**
 * Parse one concurrency key into its harness, provider, and model halves. One
 * parser for every key shape: the harness qualifier, when present, must name a
 * harness (a bare key means pi), and the remainder splits at the first "/".
 * Undefined when the key names no pool: an unknown harness qualifier, an empty
 * provider half, or a model key with an empty model half.
 */
export function parsePoolKey(key: string): PoolKey | undefined {
  const slash = key.indexOf("/");
  const colon = key.indexOf(":");
  // A qualifier is a harness id before the first "/"; a colon inside the
  // provider or model half is part of the key, not a qualifier.
  const hasQualifier = colon > 0 && (slash < 0 || colon < slash);
  let harness: HarnessId = DEFAULT_HARNESS;
  let rest = key;
  if (hasQualifier) {
    const qualifier = parseHarnessId(key.slice(0, colon));
    if (qualifier === undefined) return undefined;
    harness = qualifier;
    rest = key.slice(colon + 1);
  }
  const restSlash = rest.indexOf("/");
  if (restSlash < 0) {
    return rest === ""
      ? undefined
      : { kind: "provider", harness, provider: rest };
  }
  const provider = rest.slice(0, restSlash);
  const model = rest.slice(restSlash + 1);
  if (provider === "" || model === "") return undefined;
  return { kind: "model", harness, provider, model };
}

/** The canonical model-pool key: harness, provider, and model, fully qualified. */
function qualifiedModelKey(
  harness: HarnessId,
  provider: string,
  model: string,
): string {
  return `${harness}:${provider}/${model}`;
}

/** The canonical provider-pool key: harness and provider, fully qualified. */
function qualifiedProviderKey(harness: HarnessId, provider: string): string {
  return `${harness}:${provider}`;
}

/** The canonical model pool a config key names, or undefined when it names no model pool. */
function modelPoolKeyOf(configKey: string): string | undefined {
  const parsed = parsePoolKey(configKey);
  return parsed?.kind === "model"
    ? qualifiedModelKey(parsed.harness, parsed.provider, parsed.model)
    : undefined;
}

/** The canonical provider pool a config key names, or undefined when it names no provider pool. */
function providerPoolKeyOf(configKey: string): string | undefined {
  const parsed = parsePoolKey(configKey);
  return parsed?.kind === "provider"
    ? qualifiedProviderKey(parsed.harness, parsed.provider)
    : undefined;
}

/**
 * The harness-qualified identity a spawn's pools are keyed by. The harness is
 * resolved once on the spawn path, so admission, a queued drain, and a revived
 * turn all charge the same pools.
 */
export interface PoolIdentity {
  harness: HarnessId;
  /** The spawn's bare "provider/modelId" selection, or undefined when it carries none. */
  modelKey: string | undefined;
}

/** One level's pool: its ceiling and how many spawns count against it. */
export interface ConcurrencyPool {
  limit: number;
  spawned: number;
}

/**
 * The pools one spawn counts against. The levels are independent: a spawn whose
 * model, provider, and harness all have limits counts against four pools — its
 * model's, its provider's, its harness's, and the global one — and none stands
 * in for another.
 */
export type PoolReservation = readonly ConcurrencyPool[];

/** One spawn waiting for room in every pool that applies to it. */
interface QueuedSpawn {
  id: string;
  /**
   * The harness-qualified identity the spawn was queued under, so a drain
   * re-checks exactly the pools the spawn will be charged.
   */
  identity: PoolIdentity;
  /**
   * Start the queued spawn now that every applicable pool has room. False means
   * the session is gone or is no longer queued, so the entry is dropped. A
   * function-typed property: `admitSpawn` stores the caller's callback as a
   * bare value.
   */
  start: (reservation: PoolReservation) => boolean;
}

/** Concurrency admission verdict at spawn time. */
export type SpawnAdmission =
  { kind: "start"; reservation: PoolReservation } | { kind: "queue" };

/** Limits are floored at one: a configured 0 means one at a time, never "no limit". */
function clampLimit(limit: number): number {
  return Math.max(1, limit);
}

/**
 * The four-level pool accounting and FIFO queue. Spawns are addressed by their
 * stable id; a reservation is remembered against that id so release gives the
 * exact pools back, even when the spawn has already left the caller's store.
 */
export class ConcurrencyPools {
  /** Per-model pools keyed by "<harnessId>:<provider>/<modelId>". */
  private modelPools = new Map<string, ConcurrencyPool>();

  /** Per-provider pools — one pool shared by every model of that harness and provider. */
  private providerPools = new Map<string, ConcurrencyPool>();

  /** Per-harness pools — one pool shared by every spawn of that harness. */
  private harnessPools = new Map<HarnessId, ConcurrencyPool>();

  /** The global pool. It is never replaced, so a config change cannot lose its count. */
  private globalPool: ConcurrencyPool = {
    limit: DEFAULT_CONCURRENCY_LIMIT,
    spawned: 0,
  };

  /** Spawns waiting for room, FIFO. */
  private queue: QueuedSpawn[] = [];

  /** The pools each spawned agent counts against, so release can give them back. */
  private reservations = new Map<string, PoolReservation>();

  constructor(initialConcurrency?: ConcurrencyConfig) {
    this.setLimits(
      initialConcurrency ?? {
        default: DEFAULT_CONCURRENCY_LIMIT,
        harnesses: {},
        providers: {},
        models: {},
      },
    );
  }

  /**
   * Update the configured limits and drain the queue. A pool that stays
   * configured keeps its counter and only takes the new ceiling, so raising or
   * lowering a limit cannot lose track of the spawns already charged to it.
   */
  setConcurrency(config: ConcurrencyConfig): void {
    this.setLimits(config);
    this.drainQueue();
  }

  /** Admission at spawn time: a reservation now, or a FIFO queue entry. */
  admitSpawn(
    identity: PoolIdentity,
    queued: { id: string; start: (reservation: PoolReservation) => boolean },
  ): SpawnAdmission {
    const reservation = this.applicablePools(identity);
    if (!this.hasRoom(reservation)) {
      this.queue.push({ id: queued.id, identity, start: queued.start });
      return { kind: "queue" };
    }
    return { kind: "start", reservation };
  }

  /** Charge every pool in the reservation and remember it, so release can give them back. */
  reserve(agentId: string, reservation: PoolReservation): void {
    for (const pool of reservation) pool.spawned++;
    this.reservations.set(agentId, reservation);
  }

  /**
   * Charge a run that returns to active without an admission, which is a revived
   * turn. The message is already in the agent's pane, so the run cannot wait for
   * room: a pool that is full is charged past its limit, and the next admission
   * reads the true count. Idempotent: a run already charged is left alone.
   */
  reacquire(agentId: string, identity: PoolIdentity): void {
    if (this.reservations.has(agentId)) return;
    this.reserve(agentId, this.applicablePools(identity));
  }

  /** Release a spawn's pools and drain the queue. Idempotent. */
  release(agentId: string): void {
    const reservation = this.reservations.get(agentId);
    if (reservation) {
      for (const pool of reservation) {
        pool.spawned = Math.max(0, pool.spawned - 1);
      }
      this.reservations.delete(agentId);
    }
    // A queued spawn holds no pool; still drop its entry so the id never lingers.
    this.cancelQueued(agentId);
    this.drainQueue();
  }

  /** Drop a queued spawn (queued stop). */
  cancelQueued(id: string): void {
    this.queue = this.queue.filter((entry) => entry.id !== id);
  }

  /** Drop every queued spawn (manager dispose). */
  clearQueue(): void {
    this.queue = [];
  }

  /** 1-based FIFO position of a queued spawn, or 0 when it is not queued. */
  queuePosition(agentId: string): number {
    return this.queue.findIndex((entry) => entry.id === agentId) + 1;
  }

  // ── Private ──

  /** Bring the four levels in line with the config. */
  private setLimits(config: ConcurrencyConfig): void {
    this.globalPool.limit = clampLimit(config.default);
    this.syncHarnessPools(config.harnesses);
    this.syncPools(this.providerPools, config.providers, providerPoolKeyOf);
    this.syncPools(this.modelPools, config.models, modelPoolKeyOf);
  }

  /** Harness pools are keyed by the harness id itself, so no qualifier is parsed. */
  private syncHarnessPools(
    configured: Partial<Record<HarnessId, number>>,
  ): void {
    const limits = new Map<HarnessId, number>();
    for (const [key, limit] of Object.entries(configured)) {
      const harness = parseHarnessId(key);
      if (harness !== undefined && typeof limit === "number") {
        limits.set(harness, clampLimit(limit));
      }
    }
    for (const [harness, limit] of limits) {
      const pool = this.harnessPools.get(harness);
      if (pool) pool.limit = limit;
      else this.harnessPools.set(harness, { limit, spawned: 0 });
    }
    for (const harness of this.harnessPools.keys()) {
      if (!limits.has(harness)) this.harnessPools.delete(harness);
    }
  }

  /**
   * Give every configured key a pool and drop the pools whose key the config no
   * longer names. Two keys that name the same pool (a bare key and its
   * pi-qualified form) share it, the later one winning. A dropped pool's spawns
   * keep counting against the levels that still apply to them; only the level
   * that no longer exists stops counting them.
   */
  private syncPools(
    pools: Map<string, ConcurrencyPool>,
    configured: Partial<Record<string, number>>,
    canonicalKeyOf: (key: string) => string | undefined,
  ): void {
    const limits = new Map<string, number>();
    for (const [key, limit] of Object.entries(configured)) {
      const canonicalKey = canonicalKeyOf(key);
      if (canonicalKey !== undefined && limit !== undefined)
        limits.set(canonicalKey, clampLimit(limit));
    }
    for (const [key, limit] of limits) {
      const pool = pools.get(key);
      if (pool) pool.limit = limit;
      else pools.set(key, { limit, spawned: 0 });
    }
    for (const key of pools.keys()) {
      if (!limits.has(key)) pools.delete(key);
    }
  }

  /**
   * The pools one spawn counts against, most specific first: its model's pool
   * when the model has a limit, its provider's pool when the provider has one,
   * its harness's pool when the harness has one, and the global pool, which
   * every spawn counts against. A spawn with no model selection has no model or
   * provider pool.
   */
  private applicablePools(identity: PoolIdentity): PoolReservation {
    const pools: ConcurrencyPool[] = [];
    if (identity.modelKey) {
      const parsed = parsePoolKey(identity.modelKey);
      if (parsed?.kind === "model") {
        const modelPool = this.modelPools.get(
          qualifiedModelKey(identity.harness, parsed.provider, parsed.model),
        );
        if (modelPool) pools.push(modelPool);
        const providerPool = this.providerPools.get(
          qualifiedProviderKey(identity.harness, parsed.provider),
        );
        if (providerPool) pools.push(providerPool);
      }
    }
    const harnessPool = this.harnessPools.get(identity.harness);
    if (harnessPool) pools.push(harnessPool);
    pools.push(this.globalPool);
    return pools;
  }

  /** Every pool in the reservation must have room; one full level queues the spawn. */
  private hasRoom(reservation: PoolReservation): boolean {
    return reservation.every((pool) => pool.spawned < pool.limit);
  }

  /** Start queued spawns whose pools all have room, FIFO. */
  private drainQueue(): void {
    const kept: QueuedSpawn[] = [];
    for (const entry of this.queue) {
      const reservation = this.applicablePools(entry.identity);
      if (!this.hasRoom(reservation)) {
        kept.push(entry);
        continue;
      }
      // Every other outcome ends the entry: a started spawn leaves the queue, and a
      // refused start means the session is gone or is no longer queued.
      entry.start(reservation);
    }
    this.queue = kept;
  }
}

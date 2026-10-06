/**
 * task-registry.ts — unified admission/execution-tracking layer for subagent tasks.
 * Owns dedup (findTaskDedup / TaskDedup / TaskAlreadyInFlightError) and concurrency
 * (independent level pools + FIFO queue + release). Admission is non-destructive: a
 * duplicate is rejected and the existing attempt is never touched — the registry holds
 * no kill capability. Shell-free: every external dependency is injected via
 * TaskRegistryDeps (fakes in tests).
 */

import type { LiveAttempt } from "./agents/agent-host.js";
import type { SpawnIntent } from "./spawn/spawn-coordinator.js";
import type { SpawnOptions } from "./agents/agent-manager.js";
import type { SubagentType } from "./agents/types.js";
import { isActivePhase, lifecycleStatus, type AgentSpawn } from "./types.js";

export type AdmissionResult =
  | { status: "admitted"; agentId: string }
  | { status: "queued"; agentId: string; queuePosition: number }
  | {
      status: "rejected";
      reason: "already_in_flight";
      conflictingId: string;
    };

export interface TaskRegistry {
  admit(intent: SpawnIntent): Promise<AdmissionResult>;
  release(agentId: string): Promise<void>;
}

// --- Task dedup ---

export type { LiveAttempt } from "./agents/agent-host.js";

/** A live attempt suppressing a new spawn: an in-memory queued/spawned spawn, or a live backend attempt. */
type TaskDedup =
  | { kind: "none" }
  | { kind: "spawn"; spawn: AgentSpawn }
  | { kind: "herdr"; attempt: LiveAttempt };

/**
 * Decide whether a task is already in flight. In-memory spawns win (freshest signal — the
 * placement may not be live in the backend yet); otherwise any live backend attempt owns
 * the task, which also covers a parent reload. Ownership is binary and ends only the duplicate.
 */
export function findTaskDedup(
  inFlightSpawns: AgentSpawn[],
  liveAttempts: LiveAttempt[],
): TaskDedup {
  const spawn = inFlightSpawns.at(0);
  if (spawn) return { kind: "spawn", spawn };
  const attempt = liveAttempts.at(0);
  if (attempt) return { kind: "herdr", attempt };
  return { kind: "none" };
}

/** A spawn was requested for a task with a live agent. Throwing is the whole consequence. */
export class TaskAlreadyInFlightError extends Error {
  readonly taskSlug: string;
  /** Dedup evidence behind the error: the live spawn, or the live herdr attempt. */
  readonly dedup: Exclude<TaskDedup, { kind: "none" }>;

  constructor(dedup: Exclude<TaskDedup, { kind: "none" }>, taskSlug: string) {
    const inMemory = dedup.kind === "spawn";
    const label = inMemory ? `agent ${dedup.spawn.id}` : dedup.attempt.name;
    // Only the knowable state is reported: nothing about a herdr attempt's prompt is probed.
    const state = inMemory ? lifecycleStatus(dedup.spawn.lifecycle) : "live";
    super(
      `Task "${taskSlug}" is already in flight as ${label} (state: ${state}). No second agent was spawned.`,
    );
    this.name = "TaskAlreadyInFlightError";
    this.taskSlug = taskSlug;
    this.dedup = dedup;
  }
}

// --- Concurrency machinery ---

/** The global concurrency limit every spawn counts against. */
export const DEFAULT_CONCURRENCY_LIMIT = 4;

export interface ConcurrencyConfig {
  /** The global limit: every spawn counts against it, whatever else also applies. */
  default: number;
  /** Per-provider concurrency limits keyed by provider name (e.g. "llamacpp"). */
  providers?: Record<string, number>;
  /** Per-model concurrency limits keyed by "provider/modelId". */
  models?: Record<string, number>;
}

/** One level's pool: its ceiling and how many spawns count against it. */
export interface ConcurrencyPool {
  limit: number;
  spawned: number;
}

/**
 * The pools one spawn counts against. The levels are independent: a spawn whose model
 * and provider both have limits counts against three pools — its model's, its provider's,
 * and the global one — and its model and provider limits do not stand in for each other.
 */
export type PoolReservation = readonly ConcurrencyPool[];

/** One spawn waiting for room in every pool that applies to it. */
interface QueuedSpawn {
  id: string;
  /** The spawn's model key, or undefined when it carries no model selection. */
  modelKey: string | undefined;
  /**
   * Start the queued spawn now that every applicable pool has room. False means the
   * session is gone or is no longer queued, so the entry is dropped. A function-typed
   * property: `admitSpawn` stores the caller's callback as a bare value.
   */
  start: (reservation: PoolReservation) => boolean;
}

/** Concurrency admission verdict at spawn time. */
type SpawnAdmission =
  { kind: "start"; reservation: PoolReservation } | { kind: "queue" };

/** Limits are floored at one: a configured 0 means one at a time, never "no limit". */
function clampLimit(limit: number): number {
  return Math.max(1, limit);
}

/** The provider half of a "provider/modelId" key. */
function providerOf(modelKey: string): string {
  return modelKey.split("/")[0];
}

/** Minimal manager surface the registry drives (structural — fakes in tests); never shells out. */
export interface TaskRegistryDeps {
  /** All tracked agents; dedup reads the queued/spawned ones. */
  listAgents(): AgentSpawn[];
  /** Create the agent spawn and return its id. */
  spawn(type: SubagentType, prompt: string, options: SpawnOptions): string;
  /** Look up a spawn by id. */
  getSpawn(agentId: string): AgentSpawn | undefined;
  /** Live backend attempts for a task slug. */
  findTaskAttempts(taskSlug: string): Promise<LiveAttempt[]>;
}

/** Unified admission/execution-tracking layer: `admit` gates (dedup, then concurrency); `release` frees and drains. */
export class HerdrTaskRegistry implements TaskRegistry {
  /** Per-model pools keyed by "provider/modelId". */
  private modelPools = new Map<string, ConcurrencyPool>();

  /** Per-provider pools — one pool shared by every model from that provider. */
  private providerPools = new Map<string, ConcurrencyPool>();

  /** The global pool. It is never replaced, so a config change cannot lose its count. */
  private globalPool: ConcurrencyPool = {
    limit: DEFAULT_CONCURRENCY_LIMIT,
    spawned: 0,
  };

  /** Spawns waiting for room, FIFO. */
  private queue: QueuedSpawn[] = [];

  /** The pools each spawned agent counts against, so release can give them back. */
  private reservations = new WeakMap<AgentSpawn, PoolReservation>();

  /** Tail of the admission chain per task slug, so two requests for one slug cannot interleave. */
  private admissionBySlug = new Map<string, Promise<AdmissionResult>>();

  constructor(
    private deps: TaskRegistryDeps,
    initialConcurrency?: ConcurrencyConfig,
  ) {
    this.setLimits(
      initialConcurrency ?? { default: DEFAULT_CONCURRENCY_LIMIT },
    );
  }

  /**
   * Admit a spawn request. Rejections carry the conflict's identity and never throw — the caller converts them.
   * A slug serializes its admissions: the dedup check and the spawn must not straddle another
   * request for the same slug, or a batch of duplicate task names starts twice.
   */
  async admit(intent: SpawnIntent): Promise<AdmissionResult> {
    const slug = intent.taskSlug;
    if (slug === undefined) return this.admitOne(intent);
    const previous = this.admissionBySlug.get(slug);
    const mine = (previous ?? Promise.resolve())
      .catch(() => {})
      .then(() => this.admitOne(intent));
    this.admissionBySlug.set(slug, mine);
    try {
      return await mine;
    } finally {
      if (this.admissionBySlug.get(slug) === mine) {
        this.admissionBySlug.delete(slug);
      }
    }
  }

  /** One admission: dedup first, then the synchronous spawn that registers the spawn in the store. */
  private async admitOne(intent: SpawnIntent): Promise<AdmissionResult> {
    // Verify-only: a conflict rejects the NEW request and leaves the existing attempt alone.
    if (intent.taskSlug) {
      const inFlight = this.deps
        .listAgents()
        .filter(
          (a) =>
            a.display.taskSlug === intent.taskSlug &&
            isActivePhase(a.lifecycle.phase),
        );
      const dedup = findTaskDedup(
        inFlight,
        await this.deps.findTaskAttempts(intent.taskSlug),
      );
      if (dedup.kind !== "none") {
        // The rejection is the entire consequence; leftovers end explicitly (Cleanup/stop_cowboy_agent).
        return {
          status: "rejected",
          reason: "already_in_flight",
          conflictingId:
            dedup.kind === "spawn" ? dedup.spawn.id : dedup.attempt.name,
        };
      }
    }

    // The manager folds concurrency admission (reservation or queue) into the spawn call.
    const { type, prompt, runInBackground, signal, ...config } = intent;
    const spawnOptions: SpawnOptions = {
      ...config,
      isBackground: runInBackground,
      signal,
    };
    const agentId = this.deps.spawn(type, prompt, spawnOptions);

    // Phase right after the synchronous spawn tells admitted (spawned) vs queued.
    const spawn = this.deps.getSpawn(agentId);
    if (spawn?.lifecycle.phase === "queued") {
      return {
        status: "queued",
        agentId,
        queuePosition: this.queuePositionOf(agentId),
      };
    }
    return { status: "admitted", agentId };
  }

  /** Release a spawn's pools and drain the queue. Idempotent. */
  async release(agentId: string): Promise<void> {
    const spawn = this.deps.getSpawn(agentId);
    if (spawn) {
      const reservation = this.reservations.get(spawn);
      if (reservation) {
        for (const pool of reservation) {
          pool.spawned = Math.max(0, pool.spawned - 1);
        }
        this.reservations.delete(spawn);
      }
    }
    // A queued spawn holds no pool; still drop its entry so the id never lingers.
    this.cancelQueued(agentId);
    this.drainQueue();
  }

  /** Concurrency admission at spawn time: a reservation now, or a FIFO queue entry. */
  admitSpawn(
    modelKey: string | undefined,
    queued: { id: string; start: (reservation: PoolReservation) => boolean },
  ): SpawnAdmission {
    const reservation = this.applicablePools(modelKey);
    if (!this.hasRoom(reservation)) {
      this.queue.push({ id: queued.id, modelKey, start: queued.start });
      return { kind: "queue" };
    }
    return { kind: "start", reservation };
  }

  /** Charge every pool in the reservation and remember it, so release can give them back. */
  reserve(spawn: AgentSpawn, reservation: PoolReservation): void {
    for (const pool of reservation) pool.spawned++;
    this.reservations.set(spawn, reservation);
  }

  /**
   * Charge a run that returns to active without an admission, which is a revived turn.
   * The message is already in the agent's pane, so the run cannot wait for room: a pool
   * that is full is charged past its limit, and the next admission reads the true count.
   */
  reacquire(spawn: AgentSpawn, modelKey: string | undefined): void {
    if (this.reservations.has(spawn)) return;
    this.reserve(spawn, this.applicablePools(modelKey));
  }

  /** Drop a queued spawn (queued stop). */
  cancelQueued(id: string): void {
    this.queue = this.queue.filter((entry) => entry.id !== id);
  }

  /** Drop every queued spawn (manager dispose). */
  clearQueue(): void {
    this.queue = [];
  }

  /** Update the configured limits and drain the queue. */
  setConcurrency(config: ConcurrencyConfig): void {
    this.setLimits(config);
    this.drainQueue();
  }

  // ── Private ──

  /**
   * Bring the three levels in line with the config. A pool that stays configured keeps
   * its counter and only takes the new ceiling, so raising or lowering a limit cannot
   * lose track of the spawns already charged to it.
   */
  private setLimits(config: ConcurrencyConfig): void {
    this.globalPool.limit = clampLimit(config.default);
    this.syncPools(this.providerPools, config.providers ?? {});
    this.syncPools(this.modelPools, config.models ?? {});
  }

  /**
   * Give every configured key a pool and drop the pools whose key the config no longer
   * names. A dropped pool's spawns keep counting against the levels that still apply to
   * them; only the level that no longer exists stops counting them.
   */
  private syncPools(
    pools: Map<string, ConcurrencyPool>,
    configured: Record<string, number>,
  ): void {
    for (const [key, limit] of Object.entries(configured)) {
      const pool = pools.get(key);
      if (pool) pool.limit = clampLimit(limit);
      else pools.set(key, { limit: clampLimit(limit), spawned: 0 });
    }
    for (const key of pools.keys()) {
      if (!(key in configured)) pools.delete(key);
    }
  }

  /**
   * The pools one spawn counts against, most specific first: its model's pool when the
   * model has a limit, its provider's pool when the provider has one, and the global
   * pool, which every spawn counts against. A spawn with no model selection has only
   * the global pool.
   */
  private applicablePools(modelKey: string | undefined): PoolReservation {
    const pools: ConcurrencyPool[] = [];
    if (modelKey) {
      const modelPool = this.modelPools.get(modelKey);
      if (modelPool) pools.push(modelPool);
      const providerPool = this.providerPools.get(providerOf(modelKey));
      if (providerPool) pools.push(providerPool);
    }
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
      const reservation = this.applicablePools(entry.modelKey);
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

  /** 1-based FIFO position of a queued spawn, or 0 when it is not queued. */
  private queuePositionOf(agentId: string): number {
    return this.queue.findIndex((entry) => entry.id === agentId) + 1;
  }
}

/**
 * task-registry.ts — the admission workflow for subagent tasks: task dedup
 * (findTaskDedup / TaskDedup / TaskAlreadyInFlightError), per-slug admission
 * serialization, and the spawn call. Admission is non-destructive: a duplicate
 * is rejected and the existing attempt is never touched — the registry holds no
 * kill capability. Shell-free: every external dependency is injected via
 * TaskRegistryDeps (fakes in tests).
 *
 * Concurrency accounting lives in concurrency-pools.ts; this layer owns only the
 * task identity that decides whether a spawn may happen at all, and delegates the
 * pool verbs to its ConcurrencyPools.
 */

import type { LiveAttempt } from "./agents/agent-host.js";
import type { SpawnIntent } from "./spawn/spawn-coordinator.js";
import type { SpawnOptions } from "./agents/agent-manager.js";
import type { SubagentType } from "./agents/types.js";
import {
  ConcurrencyPools,
  type ConcurrencyConfig,
  type PoolIdentity,
  type PoolReservation,
  type SpawnAdmission,
} from "./concurrency-pools.js";
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

/** Admission workflow over a task's identity, with pool accounting delegated to ConcurrencyPools. */
export class HerdrTaskRegistry implements TaskRegistry {
  /** Tail of the admission chain per task slug, so two requests for one slug cannot interleave. */
  private admissionBySlug = new Map<string, Promise<AdmissionResult>>();

  private readonly pools: ConcurrencyPools;

  constructor(
    private deps: TaskRegistryDeps,
    initialConcurrency?: ConcurrencyConfig,
  ) {
    this.pools = new ConcurrencyPools(initialConcurrency);
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
        queuePosition: this.pools.queuePosition(agentId),
      };
    }
    return { status: "admitted", agentId };
  }

  /** Release a spawn's pools and drain the queue. Idempotent. */
  async release(agentId: string): Promise<void> {
    this.pools.release(agentId);
  }

  /** Concurrency admission at spawn time: a reservation now, or a FIFO queue entry. */
  admitSpawn(
    identity: PoolIdentity,
    queued: { id: string; start: (reservation: PoolReservation) => boolean },
  ): SpawnAdmission {
    return this.pools.admitSpawn(identity, queued);
  }

  /** Charge every pool in the reservation and remember it, so release can give them back. */
  reserve(spawn: AgentSpawn, reservation: PoolReservation): void {
    this.pools.reserve(spawn.id, reservation);
  }

  /**
   * Charge a run that returns to active without an admission, which is a revived turn.
   * The message is already in the agent's pane, so the run cannot wait for room: a pool
   * that is full is charged past its limit, and the next admission reads the true count.
   */
  reacquire(spawn: AgentSpawn, identity: PoolIdentity): void {
    this.pools.reacquire(spawn.id, identity);
  }

  /** Drop a queued spawn (queued stop). */
  cancelQueued(id: string): void {
    this.pools.cancelQueued(id);
  }

  /** Drop every queued spawn (manager dispose). */
  clearQueue(): void {
    this.pools.clearQueue();
  }

  /** Update the configured limits and drain the queue. */
  setConcurrency(config: ConcurrencyConfig): void {
    this.pools.setConcurrency(config);
  }
}

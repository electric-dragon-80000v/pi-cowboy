/**
 * agent-spawn-store.ts — Shell-owned canonical AgentSpawn store.
 * Exports AgentSpawnStore, SpawnIdCollisionError.
 *
 * The manager is per-session, so spawns live here in the shell: a spawn
 * outlives its session and stays visible and cleanable. A `/reload`
 * re-imports the extension and rebuilds this store empty — which is why the
 * store publishes every registration, save and drop to a bound observer
 * (`AgentSpawnObserver`, implemented by the session journal) and why the shell
 * seeds it from that observer's replay at session start. No I/O or lifecycle
 * logic here; the observer owns the I/O and the store stays shell-free. The
 * only scoping is the lifecycle phase, on request.
 */

import { ALL_AGENT_PHASES } from "../types.js";
import type { AgentPhase, AgentSpawn } from "../types.js";
import { generateSpawnId, generateUniqueSpawnId } from "../spawn/spawn-id.js";
import type { AgentSpawnObserver } from "./spawn-journal.js";

/**
 * Thrown when `add` gets an id the store already owns. Overwriting would
 * destroy the live spawn and the stop/cleanup/steer execution it carries, so
 * the original is left untouched.
 */
export class SpawnIdCollisionError extends Error {
  readonly spawnId: string;
  constructor(spawnId: string) {
    super(
      `Spawn id ${spawnId} is already registered — an id belongs to exactly one spawn from creation until its explicit drop.`,
    );
    this.name = "SpawnIdCollisionError";
    this.spawnId = spawnId;
  }
}

/** Process-lifetime spawn retention by id; drops only on explicit drop. */
export class AgentSpawnStore {
  private spawns = new Map<string, AgentSpawn>();
  /** Where this store mirrors itself; null until the shell binds it (and after shutdown). */
  private observer: AgentSpawnObserver | null = null;
  /**
   * Bind the backing store. The shell wires the session journal here at session
   * start and unbinds it at shutdown, so a store that outlives a session never
   * writes through the previous one.
   */
  setObserver(observer: AgentSpawnObserver | null): void {
    this.observer = observer;
  }

  /**
   * Unbind, but only while `observer` is still the bound one.
   *
   * A teardown that captured its observer can outlive a replacement session's
   * start, which binds a new one; clearing unconditionally would leave that session
   * with nothing mirroring it. Compare-and-clear is what makes "only what this
   * teardown owns is taken away" true here, the same way the runtime slot guards
   * itself in events.ts.
   */
  clearObserver(observer: AgentSpawnObserver): void {
    if (this.observer === observer) this.observer = null;
  }

  /**
   * Register a spawn at creation. A duplicate id throws and leaves the
   * original untouched; callers mint through `mint()`, so a collision is a bug.
   *
   * Ids are the only key. Two spawns on one task slug are kept: a `/resume` into a
   * branch written before a later spawn can surface exactly that, and dropping
   * either would lose a live run. Dedup reads active phases, so the pair refuses a
   * new spawn for that slug rather than running two — see `reportSlugCollision` in
   * spawn-adoption.ts, which names it when adoption creates one.
   */
  add(spawn: AgentSpawn): void {
    if (this.spawns.has(spawn.id)) {
      throw new SpawnIdCollisionError(spawn.id);
    }
    this.spawns.set(spawn.id, spawn);
    this.observer?.record(spawn);
  }

  /**
   * Publish a spawn whose state moved. Callers mutate the spawn in place — this
   * store holds the object, never a copy — so `save` is how a writer says its
   * fields are worth reading again. A spawn this store does not hold is ignored:
   * the store is the only thing that can vouch for an id.
   */
  save(spawn: AgentSpawn): void {
    if (this.spawns.get(spawn.id) !== spawn) return;
    this.observer?.record(spawn);
  }

  /**
   * Mint an id no registered spawn holds, settled ones included: a retained
   * spawn still owns its id. `mint` is injectable so collisions are testable.
   */
  mint(mint: () => string = generateSpawnId): string {
    return generateUniqueSpawnId((id) => this.spawns.has(id), mint);
  }

  /** Look one spawn up by id, never phase-filtered. */
  get(id: string): AgentSpawn | undefined {
    return this.spawns.get(id);
  }

  /** Drop a spawn once its resources are gone (cleanup success, Clear). */
  drop(id: string): void {
    if (this.spawns.delete(id)) this.observer?.forget(id);
  }

  /** Spawns in the given phases (default: all), in insertion order. */
  list(phases: readonly AgentPhase[] = ALL_AGENT_PHASES): AgentSpawn[] {
    return [...this.spawns.values()].filter((spawn) =>
      phases.includes(spawn.lifecycle.phase),
    );
  }
}

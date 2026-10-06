/**
 * agent-spawn-store.ts — Shell-owned canonical AgentSpawn store.
 * Exports AgentSpawnStore, SpawnIdCollisionError.
 *
 * The manager is per-session, so spawns live here in the shell: a spawn
 * outlives its session and stays visible and cleanable. A `/reload`
 * re-imports the extension and rebuilds this store empty. No I/O or
 * lifecycle logic; the only scoping is the lifecycle phase, on request.
 */

import { ALL_AGENT_PHASES } from "../types.js";
import type { AgentPhase, AgentSpawn } from "../types.js";
import { generateSpawnId, generateUniqueSpawnId } from "../spawn/spawn-id.js";

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

  /**
   * Register a spawn at creation. A duplicate id throws and leaves the
   * original untouched; callers mint through `mint()`, so a collision is a bug.
   */
  add(spawn: AgentSpawn): void {
    if (this.spawns.has(spawn.id)) {
      throw new SpawnIdCollisionError(spawn.id);
    }
    this.spawns.set(spawn.id, spawn);
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
    this.spawns.delete(id);
  }

  /** Spawns in the given phases (default: all), in insertion order. */
  list(phases: readonly AgentPhase[] = ALL_AGENT_PHASES): AgentSpawn[] {
    return [...this.spawns.values()].filter((spawn) =>
      phases.includes(spawn.lifecycle.phase),
    );
  }
}

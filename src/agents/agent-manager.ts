/**
 * agent-manager.ts — Fleet controller for independently running subagents.
 * Exports AgentManager; re-exports spawn and steer types.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  getAgentSpawns,
  getCoordinatorOrNull,
  getPiInstance,
  getSessionCtx,
} from "../shell.js";
import { subagentResultFileFor } from "../paths.js";
import {
  ConcurrencyPools,
  type ConcurrencyConfig,
  type PoolReservation,
} from "../concurrency-pools.js";
import { HerdrTaskRegistry } from "../task-registry.js";
import { createLogger } from "../logger.js";
import { errorMessage } from "../utils.js";
import {
  ACTIVE_AGENT_PHASES,
  ALL_AGENT_PHASES,
  hasOutcome,
  lifecycleStartTime,
  type AgentPhase,
  type AgentSpawn,
  type StopInitiator,
  type WorktreeRetentionReason,
} from "../types.js";
import { FileDeliverable } from "../subagent/deliverable.js";
import { removeResultArtifacts } from "../subagent/result-artifacts.js";
import type { SupervisorTransport } from "../subagent/pane-supervisor.js";
import type { ExecutionRuntime } from "./agent-host.js";
import { createCleanup } from "./agent-cleanup.js";
import {
  createMultiplexerAgentAssets,
  type AgentAssets,
  type LocateResult,
} from "./agent-assets.js";
import type { CleanupOptions, CleanupReport } from "./cleanup-policy.js";
import {
  DISPOSE_QUEUED_MESSAGE,
  SubagentSession,
  type ResolvedSpawnOptions,
  type SpawnArgs,
  type SpawnOptions,
  type SteerOutcome,
} from "./subagent-session.js";
import { resolveHarnessType } from "./spawn-defaults.js";
import type { SubagentType } from "./types.js";

export type { SpawnOptions, SteerOutcome } from "./subagent-session.js";

/**
 * The transport a session's manager runs on: the session's runtime, which
 * `ExecutionRuntime` builds once per parent session (agent-host.ts). The runtime is
 * bound once here, so every spawn, every cleanup and the registry's dedup check
 * reuse the same host, placements and pane; a multiplexer that opens a connection
 * or starts a service in its `create` would otherwise leak one per call.
 */
export function createAgentManagerTransport(
  runtime: ExecutionRuntime,
): SupervisorTransport {
  return {
    createHost: () => runtime.host,
    createPane: () => runtime.pane,
    createPlacements: () => runtime.placements,
    createDeliverable: (resultFile) => new FileDeliverable(resultFile),
  };
}

type OnAgentComplete = (spawn: AgentSpawn) => void;

/** A report from an agent that already settled: news beyond its recorded result. */
type OnAgentFollowUp = (spawn: AgentSpawn, deliverable: string) => void;

const log = createLogger("manager");

/**
 * The keep reason a cleanup report carries for a spawn that stays listed. A
 * refusal for a live or contested run names no worktree state, so only a
 * dirty or unverifiable reason is recordable; an unconfirmed removal is
 * recorded as unverifiable with the removal's detail.
 */
function retentionForReport(
  report: CleanupReport,
): WorktreeRetentionReason | undefined {
  if (report.outcome.kind === "refused") {
    const reason = report.outcome.reason;
    return reason.kind === "dirty" || reason.kind === "unverifiable"
      ? reason
      : undefined;
  }
  if (report.worktree.kind === "removal-failed") {
    return {
      kind: "unverifiable",
      detail: `the removal was not confirmed (${report.worktree.detail})`,
    };
  }
  return undefined;
}

/** Fleet controller; each session owns exactly one lifecycle. */
export class AgentManager {
  /** Live sessions by id; the spawn itself stays identity-stable. */
  private readonly sessions = new Map<string, SubagentSession>();
  private onComplete?: OnAgentComplete;
  private onFollowUp?: OnAgentFollowUp;
  /**
   * Teardowns in flight, by agent id. One teardown owns an id's artifacts at a
   * time: a cleanup that arrives while one runs waits for it instead of racing
   * it for the same checkout.
   */
  private readonly teardowns = new Map<string, Promise<unknown>>();
  /** The resource limiter the fleet drives directly; sessions charge their capacity to it. */
  private readonly pools: ConcurrencyPools;
  /** Task identity and admission serialization; pool accounting lives in `pools`. */
  private readonly registry: HerdrTaskRegistry;

  constructor(
    pools: ConcurrencyPools,
    private readonly transport: SupervisorTransport,
  ) {
    this.pools = pools;
    this.registry = new HerdrTaskRegistry({
      listAgents: () => this.listAgents(ACTIVE_AGENT_PHASES),
      spawn: (type, prompt, options) =>
        this.spawn(getPiInstance(), getSessionCtx(), type, prompt, options),
      getSpawn: (id) => this.getSpawn(id),
      findTaskAttempts: (taskSlug) =>
        this.transport.createHost(getPiInstance()).findAttempts(taskSlug),
      queuePosition: (id) => this.pools.queuePosition(id),
    });
  }

  getRegistry(): HerdrTaskRegistry {
    return this.registry;
  }
  setConcurrency(config: ConcurrencyConfig): void {
    this.pools.setConcurrency(config);
  }
  setOnComplete(cb: OnAgentComplete): void {
    this.onComplete = cb;
  }
  setOnFollowUp(cb: OnAgentFollowUp): void {
    this.onFollowUp = cb;
  }
  /**
   * Mint a spawn id unique across every retained spawn, settled ones included:
   * a retained spawn still owns its id, branch, worktree, and herdr name.
   */
  mintSpawnId(): string {
    return getAgentSpawns().mint();
  }

  spawn(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: SubagentType,
    prompt: string,
    options: SpawnOptions,
  ): string {
    // The caller mints the id, so it matches the branch/worktree/herdr suffix.
    const id = options.spawnId;
    // Resolve the harness once, on the spawn path: the pool identity, a queued
    // drain, a revived turn, and the launch plan all read this one value. The
    // caller's validated `harness_type` wins over the template/config chain.
    const { requestedHarness, ...rest } = options;
    const resolvedOptions: ResolvedSpawnOptions = {
      ...rest,
      harness: resolveHarnessType(type, requestedHarness),
    };
    const args: SpawnArgs = { pi, ctx, type, prompt, options: resolvedOptions };
    const admission = this.pools.admitSpawn(
      {
        harness: resolvedOptions.harness,
        modelKey: resolvedOptions.modelSelection?.key,
      },
      {
        id,
        start: (reservation) => this.startSession(id, args, reservation),
      },
    );
    let session: SubagentSession;
    try {
      // Registration refuses a duplicate id; release the granted admission first.
      session = new SubagentSession({
        id,
        args,
        deps: {
          transport: this.transport,
          pools: this.pools,
          onRunEnded: (spawn) => this.notifyComplete(spawn),
          onFollowUpResult: (spawn, deliverable) =>
            this.notifyFollowUp(spawn, deliverable),
        },
      });
    } catch (err) {
      this.pools.release(id);
      throw err;
    }
    this.sessions.set(id, session);
    if (resolvedOptions.signal?.aborted) {
      void session.abort("user");
      return id;
    }
    if (admission.kind === "queue") return id;
    try {
      session.start(admission.reservation);
    } catch (err) {
      session.rollbackStart();
      this.pools.release(id);
      this.sessions.delete(id);
      // A start that never happened leaves no spawn: an orphan would trip dedup on retry.
      getAgentSpawns().drop(id);
      throw err;
    }
    return id;
  }

  private startSession(
    id: string,
    _args: SpawnArgs,
    reservation: PoolReservation,
  ): boolean {
    const session = this.sessions.get(id);
    if (!session || !session.isQueued()) return false;
    try {
      session.start(reservation);
    } catch (err) {
      // Queued-start failure keeps the reservation (asymmetric with direct spawn).
      session.settleStartFailure(err);
    }
    return true;
  }

  /**
   * Route a message to the agent's session. Unknown ids are refused with the
   * reason; settled agents revive in their session. See SubagentSession.
   */
  async steer(id: string, message: string): Promise<SteerOutcome> {
    // Steer revives a settled agent, whose worktree a teardown may be removing.
    if (this.teardowns.has(id)) {
      return {
        kind: "refused",
        reason: `agent ${id} is being cleaned up, so its worktree is on its way out — wait for the report before steering it.`,
      };
    }
    const session = this.sessions.get(id);
    if (!session) {
      return {
        kind: "refused",
        reason: `no live session tracks agent ${id} — check the id from its spawn or completion result (a cleaned-up agent is gone for good).`,
      };
    }
    return session.steer(message);
  }

  /** One spawn by id, unfiltered, so cleanup reaches settled spawns too. */
  getSpawn(id: string): AgentSpawn | undefined {
    return getAgentSpawns().get(id);
  }

  /** Assets seam, built per call so probes run against the current shell. */
  private assets(): AgentAssets {
    const pi = getPiInstance();
    // The multiplexer's own host and placement catalog, from the session's transport:
    // the manager never picks a multiplexer for the cleanup and status paths.
    return createMultiplexerAgentAssets(
      pi,
      this.transport.createHost(pi),
      this.transport.createPlacements(pi),
    );
  }

  /**
   * Locate one agent's artifacts. Read-only: nothing is stopped, removed, or
   * released. Covers ids no session tracks (a `/reload` rebuilt the store).
   */
  async locate(id: string): Promise<LocateResult> {
    return this.assets().locate(id, this.getSpawn(id));
  }

  /**
   * Retained spawns in the given phases (default: all), newest start first.
   * Pass ACTIVE_AGENT_PHASES for in-flight work, ALL_AGENT_PHASES for status.
   */
  listAgents(phases: readonly AgentPhase[] = ALL_AGENT_PHASES): AgentSpawn[] {
    return getAgentSpawns()
      .list(phases)
      .sort(
        (a, b) =>
          lifecycleStartTime(b.lifecycle) - lifecycleStartTime(a.lifecycle),
      );
  }

  async abort(id: string, initiator?: StopInitiator): Promise<boolean> {
    return (await this.sessions.get(id)?.abort(initiator)) ?? false;
  }

  private notifyComplete(spawn: AgentSpawn): void {
    try {
      this.onComplete?.(spawn);
    } catch (err) {
      // The listener's throw never fails the settle, but the completion it was
      // meant to announce must not vanish with it.
      log.warn("completion notification failed", {
        spawnId: spawn.id,
        detail: errorMessage(err),
      });
    }
  }

  private notifyFollowUp(spawn: AgentSpawn, deliverable: string): void {
    try {
      this.onFollowUp?.(spawn, deliverable);
    } catch (err) {
      // The run it reports on is already settled, so a failed announcement
      // costs the report, never the run.
      log.warn("follow-up notification failed", {
        spawnId: spawn.id,
        detail: errorMessage(err),
      });
    }
  }

  /**
   * Record why a spawn's checkout survived. The caller reports the outcome and
   * the reason rides the spawn, so status still states it after the menu leaves.
   */
  private recordRetention(
    spawn: AgentSpawn,
    reason: WorktreeRetentionReason,
  ): void {
    const lifecycle = spawn.lifecycle;
    // The reason lives on the ended phases; an active spawn records none.
    if (hasOutcome(lifecycle)) {
      lifecycle.worktreeRetentionReason = reason;
    }
  }

  /**
   * Drop runtime session and store entry for good, and with them the run's
   * staging directory. The removal is keyed on the id, not the session: a
   * disposal leaves a settled spawn tracked with no session at all, and only
   * the canonical path can still name the directory that run wrote to.
   */
  dropSpawn(spawn: AgentSpawn): void {
    this.sessions.get(spawn.id)?.drop();
    this.sessions.delete(spawn.id);
    removeResultArtifacts(subagentResultFileFor(spawn.id));
    getAgentSpawns().drop(spawn.id);
  }

  async cleanup(id: string, opts?: CleanupOptions): Promise<CleanupReport> {
    const run = this.runCleanup(id, this.teardowns.get(id), opts);
    this.teardowns.set(id, run);
    try {
      return await run;
    } finally {
      // Only the newest teardown clears the id; an older one leaves it alone.
      if (this.teardowns.get(id) === run) this.teardowns.delete(id);
    }
  }

  /** Clean one agent up, after whatever teardown for its id is already running. */
  private async runCleanup(
    id: string,
    inFlight: Promise<unknown> | undefined,
    opts: CleanupOptions | undefined,
  ): Promise<CleanupReport> {
    // The earlier teardown's failure is its own report; this one still runs.
    await inFlight?.catch(() => {});
    // Before the teardown, which is slow enough for a pending nudge to fire.
    getCoordinatorOrNull()?.dropNudge(id);
    // Whether the spawn is tracked now: only a tracked run has a recorded
    // result, so it is the only one whose staging directory may be removed
    // without losing something nobody has read (see cleanup's report).
    const tracked = this.getSpawn(id) !== undefined;
    const report = await createCleanup(this.assets()).cleanupAgent(
      id,
      {
        getSpawn: (rid) => this.getSpawn(rid),
        dropSpawn: (spawn) => this.dropSpawn(spawn),
      },
      opts,
    );
    // A spawn the teardown kept stays listed with the reason its checkout
    // survived; a dropped spawn has no record left to annotate.
    const kept = this.getSpawn(id);
    if (kept !== undefined) {
      const retention = retentionForReport(report);
      if (retention !== undefined) this.recordRetention(kept, retention);
    }
    // A teardown that finished the run takes the staging directory with it even
    // when its spawn is kept (a failed or unconfirmed removal): the artifacts
    // are ephemeral, and a later retry does not read them. A refusal removed
    // nothing, so it leaves them where they are.
    if (tracked && report.outcome.kind === "torn-down") {
      removeResultArtifacts(subagentResultFileFor(id));
    }
    return report;
  }

  /**
   * Dispose every runtime session. The shell-owned spawn store stays: settled
   * spawns must stay cleanable and untracked live ones stay visible.
   */
  dispose(): void {
    this.pools.clearQueue();
    for (const session of this.sessions.values()) session.settleForDispose();
    this.sessions.clear();
  }
}

export { DISPOSE_QUEUED_MESSAGE };

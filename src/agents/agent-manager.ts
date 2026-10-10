/**
 * agent-manager.ts — Fleet controller for independently running subagents.
 * Exports AgentManager, ClearOutcome/ClearRefusal; re-exports spawn and steer
 * types.
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
import { createHerdrRuntime } from "../infrastructure/herdr-host.js";
import {
  HerdrTaskRegistry,
  type ConcurrencyConfig,
  type PoolReservation,
} from "../task-registry.js";
import { createLogger } from "../logger.js";
import { errorMessage } from "../utils.js";
import {
  ACTIVE_AGENT_PHASES,
  ALL_AGENT_PHASES,
  hasOutcome,
  lifecycleStartTime,
  lifecycleStatus,
  type AgentPhase,
  type AgentSpawn,
  type StopInitiator,
  type WorktreeRetentionReason,
} from "../types.js";
import { FileDeliverable } from "../subagent/deliverable.js";
import { removeResultArtifacts } from "../subagent/result-artifacts.js";
import type { SupervisorTransport } from "../subagent/pane-supervisor.js";
import { createCleanup, type WorktreeRemovalTarget } from "./agent-cleanup.js";
import {
  createHerdrAgentAssets,
  type AgentAssets,
  type LocateResult,
} from "./agent-assets.js";
import type { CleanupReport, WorktreeTarget } from "./cleanup-policy.js";
import {
  DISPOSE_QUEUED_MESSAGE,
  SubagentSession,
  type SpawnArgs,
  type SpawnOptions,
  type SteerOutcome,
} from "./subagent-session.js";
import type { SubagentType } from "./types.js";

export type { SpawnOptions, SteerOutcome } from "./subagent-session.js";

/** The transport the manager wires its sessions with unless the caller supplies one. */
export const defaultAgentManagerTransport: SupervisorTransport = {
  createHost: (pi) => createHerdrRuntime(pi).host,
  createDeliverable: (resultFile) => new FileDeliverable(resultFile),
};

type OnAgentComplete = (spawn: AgentSpawn) => void;

/** A report from an agent that already settled: news beyond its recorded result. */
type OnAgentFollowUp = (spawn: AgentSpawn, deliverable: string) => void;

/** Why a clear touched nothing: no such spawn, one still live, or one already clearing. */
export type ClearRefusal = "unknown-id" | "not-terminal" | "in-flight";

/**
 * What one clear did: the spawn dropped with its worktree confirmed gone, or
 * the spawn kept and listed with the reason that checkout survived.
 */
export type ClearOutcome =
  | { kind: "cleared" }
  | { kind: "kept"; path: string; reason: WorktreeRetentionReason }
  | { kind: "removal-failed"; path: string; detail: string }
  | { kind: "refused"; reason: ClearRefusal };

/** Where a spawn's owned worktree is cleaned up from; `none` means it owns none. */
type RemovalAddress =
  | { kind: "owned"; target: WorktreeRemovalTarget }
  | { kind: "unaddressable"; path: string }
  | { kind: "none" };

/**
 * Removal address for a spawn's owned checkout. An owned checkout that no
 * recorded repository cwd can reach is `unaddressable`: its teardown has no
 * place to run, which is not the same as having none left to remove.
 */
function removalAddressFor(spawn: AgentSpawn): RemovalAddress {
  const worktree = spawn.display.worktree;
  if (worktree?.kind !== "owned") return { kind: "none" };
  const repoCwd = spawn.execution.spawnCtx?.cwd;
  if (!repoCwd) return { kind: "unaddressable", path: worktree.path };
  const target: WorktreeTarget = {
    workspaceId: spawn.execution.host?.workspaceId,
    worktreePath: worktree.path,
    repoCwd,
    branchName: worktree.branch,
  };
  const host = spawn.execution.host;
  return {
    kind: "owned",
    target:
      host === undefined
        ? { kind: "detached", worktree: target, pane: null }
        : {
            kind: "adopted",
            worktree: { ...target, workspaceId: host.workspaceId },
            pane: null,
            ref: host,
          },
  };
}

const log = createLogger("manager");

function isTerminal(spawn: AgentSpawn): boolean {
  const status = lifecycleStatus(spawn.lifecycle);
  return status !== "spawned" && status !== "queued";
}

/** Fleet controller; each session owns exactly one lifecycle. */
export class AgentManager {
  /** Live sessions by id; the spawn itself stays identity-stable. */
  private readonly sessions = new Map<string, SubagentSession>();
  private onComplete?: OnAgentComplete;
  private onFollowUp?: OnAgentFollowUp;
  /**
   * Teardowns in flight, by agent id. One teardown owns an id's artifacts at a
   * time: a clear that arrives during one is refused, and a cleanup waits for
   * the running one instead of racing it for the same checkout.
   */
  private readonly teardowns = new Map<string, Promise<unknown>>();
  private readonly registry: HerdrTaskRegistry;

  constructor(
    onComplete?: OnAgentComplete,
    concurrency?: ConcurrencyConfig,
    registry?: HerdrTaskRegistry,
    private readonly transport: SupervisorTransport = defaultAgentManagerTransport,
  ) {
    this.onComplete = onComplete;
    this.registry =
      registry ??
      new HerdrTaskRegistry(
        {
          listAgents: () => this.listAgents(ACTIVE_AGENT_PHASES),
          spawn: (type, prompt, options) =>
            this.spawn(getPiInstance(), getSessionCtx(), type, prompt, options),
          getSpawn: (id) => this.getSpawn(id),
          findTaskAttempts: (taskSlug) =>
            this.transport.createHost(getPiInstance()).findAttempts(taskSlug),
        },
        concurrency,
      );
  }

  getRegistry(): HerdrTaskRegistry {
    return this.registry;
  }
  setConcurrency(config: ConcurrencyConfig): void {
    this.registry.setConcurrency(config);
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
    const args: SpawnArgs = { pi, ctx, type, prompt, options };
    const admission = this.registry.admitSpawn(options.modelSelection?.key, {
      id,
      start: (reservation) => this.startSession(id, args, reservation),
    });
    let session: SubagentSession;
    try {
      // Registration refuses a duplicate id; release the granted admission first.
      session = new SubagentSession({
        id,
        args,
        deps: {
          transport: this.transport,
          slots: this.registry,
          onRunEnded: (spawn) => this.notifyComplete(spawn),
          onFollowUpResult: (spawn, deliverable) =>
            this.notifyFollowUp(spawn, deliverable),
        },
      });
    } catch (err) {
      void this.registry.release(id);
      throw err;
    }
    this.sessions.set(id, session);
    if (options.signal?.aborted) {
      void session.abort("user");
      return id;
    }
    if (admission.kind === "queue") return id;
    try {
      session.start(admission.reservation);
    } catch (err) {
      session.rollbackStart();
      void this.registry.release(id);
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
    return createHerdrAgentAssets(getPiInstance());
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

  /**
   * Clear a terminal spawn: tear its owned checkout down first and drop the
   * spawn only once the removal is confirmed. A kept or failed removal leaves
   * the spawn listed, with the reason recorded, so the caller can report it and
   * the operator can retry it. Spawn-keyed so a spawn whose session is gone
   * stays clearable.
   */
  async clear(id: string): Promise<ClearOutcome> {
    const spawn = getAgentSpawns().get(id);
    if (!spawn) return { kind: "refused", reason: "unknown-id" };
    if (!isTerminal(spawn)) return { kind: "refused", reason: "not-terminal" };
    // The first teardown's verdict is the answer for every clear that arrives
    // while it runs; a second removal of the same checkout would race the first.
    if (this.teardowns.has(id)) return { kind: "refused", reason: "in-flight" };
    const address = removalAddressFor(spawn);
    if (address.kind === "none") {
      this.dropSpawn(spawn);
      return { kind: "cleared" };
    }
    if (address.kind === "unaddressable") {
      const reason: WorktreeRetentionReason = {
        kind: "unverifiable",
        detail: "the run recorded no repository cwd",
      };
      this.recordRetention(spawn, reason);
      return { kind: "kept", path: address.path, reason };
    }
    const removal = this.runRemoval(spawn, address.target);
    this.teardowns.set(id, removal);
    try {
      return await removal;
    } finally {
      // A cleanup may have queued behind this removal and taken the id over.
      if (this.teardowns.get(id) === removal) this.teardowns.delete(id);
    }
  }

  /** Tear one owned checkout down and settle the spawn on what it did. */
  private async runRemoval(
    spawn: AgentSpawn,
    target: WorktreeRemovalTarget,
  ): Promise<ClearOutcome> {
    const outcome = await createCleanup(this.assets()).removeWorktree(target);
    switch (outcome.kind) {
      case "removed":
      case "absent":
        this.dropSpawn(spawn);
        return { kind: "cleared" };
      case "kept":
        this.recordRetention(spawn, outcome.reason);
        return { kind: "kept", path: outcome.path, reason: outcome.reason };
      case "removal-failed":
        this.recordRetention(spawn, {
          kind: "unverifiable",
          detail: `the removal was not confirmed (${outcome.detail})`,
        });
        log.warn("worktree removal failed after clear", {
          spawnId: spawn.id,
          path: outcome.path,
          detail: outcome.detail,
        });
        return {
          kind: "removal-failed",
          path: outcome.path,
          detail: outcome.detail,
        };
    }
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
    // Clear takes only an ended spawn, so the ended phases can carry the reason.
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

  async cleanup(
    id: string,
    opts?: { force?: boolean },
  ): Promise<CleanupReport> {
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
    opts: { force?: boolean } | undefined,
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
    this.registry.clearQueue();
    for (const session of this.sessions.values()) session.settleForDispose();
    this.sessions.clear();
  }
}

export { DISPOSE_QUEUED_MESSAGE };

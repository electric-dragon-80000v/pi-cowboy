/**
 * spawn-coordinator.ts — shell-bound spawn orchestration and nudge emitter.
 * Delegates dedup/admission to task-registry.ts; keeps what the registry's shell-free
 * design excludes: rejection-to-error conversion, spawnCtx capture, awaiting, nudging,
 * and the launch announcement naming the new agent's id.
 * Admission is non-destructive: a duplicate is rejected and the existing attempt keeps running.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getPiInstance, getRuntime } from "../shell.js";
import {
  hasOutcome,
  lifecycleStatus,
  type AgentSpawn,
  type SpawnConfig,
} from "../types.js";
import type { AgentManager } from "../agents/agent-manager.js";
import {
  buildAgentDetails,
  formatResultContent,
  settledHeadline,
} from "../orchestrators/protocol.js";
import {
  type AdmissionResult,
  type TaskRegistry,
  findTaskDedup,
  TaskAlreadyInFlightError,
} from "../task-registry.js";
import type { LiveAttempt } from "../agents/agent-host.js";
import { isExtensionEnabled } from "../extension-toggle.js";
import { actionReport } from "../ui/action-report.js";
// Re-exported for the spawn suite.
export { findTaskDedup, TaskAlreadyInFlightError } from "../task-registry.js";

// --- Types ---

/** Input for spawn(). */
export interface SpawnIntent extends SpawnConfig {
  type: string;
  prompt: string;
  runInBackground: boolean;
  /** Parent run's interrupt signal; foreground spawns only. */
  signal?: AbortSignal;
}

/** Result of a spawn request. */
interface SpawnResult {
  agentId: string;
  spawn: AgentSpawn;
}

// --- Constants ---

/** Nudge batch window (ms). */
const NUDGE_DELAY_MS = 200;

// --- SpawnCoordinator ---

export class SpawnCoordinator {
  private manager: AgentManager;

  /** Background agent ids; every settlement of one nudges. */
  private backgroundAgentIds = new Set<string>();

  /** Pending nudge agent ids. */
  private pendingNudges = new Set<string>();

  /** Pending later reports by agent id, each with the report to carry. */
  private pendingFollowUps = new Map<string, string>();

  private nudgeTimer: ReturnType<typeof setTimeout> | null = null;

  /** Set during dispose to block nudge emission after session replacement. */
  private disposed = false;

  /** Unified admission layer, shared with the manager. */
  private registry: TaskRegistry;

  constructor(manager: AgentManager) {
    this.manager = manager;
    // One registry per manager: admission is the manager's own, never a second one.
    this.registry = manager.getRegistry();
  }

  /**
   * Spawn + wire tracking + (foreground) await. Converts an admit rejection into
   * TaskAlreadyInFlightError; a rejection ends nothing but this request.
   */
  async spawn(
    ctx: ExtensionContext,
    intent: SpawnIntent,
  ): Promise<SpawnResult> {
    // Dedup verifies only: a duplicate rejects the new request and leaves the existing attempt untouched.
    const admission = await this.registry.admit(intent);
    if (admission.status === "rejected") {
      // The registry only rejects on dedup, so a rejection implies a task slug.
      throw await this.inFlightError(intent.taskSlug!, admission);
    }

    const agentId = admission.agentId;
    const spawn = this.manager.getSpawn(agentId)!;
    // Keeps the UI-notify fallback reachable for later nudges.
    spawn.execution.spawnCtx = ctx;

    // Ahead of the foreground branch, which blocks on settlement — announcing
    // after it would report a launch only once the run is over.
    this.announceSpawn(ctx, spawn);

    if (intent.runInBackground) {
      this.backgroundAgentIds.add(agentId);
    } else {
      await spawn.execution.promise;
    }

    return { agentId, spawn };
  }

  /**
   * Announce an admitted spawn, naming the id stop/cleanup/steer take. Reached
   * by every spawn, and the only report the spawn wizard gives: its run returns
   * no tool result to read.
   */
  private announceSpawn(ctx: ExtensionContext, spawn: AgentSpawn): void {
    if (!ctx.hasUI) return;
    const lifecycle = spawn.lifecycle;
    // A spawn aborted on admission never launched: there is nothing to report.
    if (hasOutcome(lifecycle)) return;
    const verb = lifecycle.phase === "queued" ? "Queued" : "Spawned";
    actionReport(ctx.ui).succeeded(
      `${verb} agent ${spawn.id} (${spawn.display.type})`,
    );
  }

  /** Reconstruct the dedup evidence behind an admit rejection so the error names the conflict. */
  private async inFlightError(
    taskSlug: string,
    rejection: Extract<AdmissionResult, { status: "rejected" }>,
  ): Promise<TaskAlreadyInFlightError> {
    // Another tool call in this session owns the task.
    const spawn = this.manager.getSpawn(rejection.conflictingId);
    if (spawn) {
      return new TaskAlreadyInFlightError({ kind: "spawn", spawn }, taskSlug);
    }
    // Herdr conflict: re-read the live registry; the rejection carries only the id.
    const herdrAttempts = await getRuntime()!.host.findAttempts(taskSlug);
    const dedup = findTaskDedup([], herdrAttempts);
    if (dedup.kind !== "none") {
      return new TaskAlreadyInFlightError(dedup, taskSlug);
    }
    // The conflict vanished mid-read; still suppress the duplicate delegation.
    const attempt: LiveAttempt = { name: rejection.conflictingId };
    return new TaskAlreadyInFlightError({ kind: "herdr", attempt }, taskSlug);
  }

  /**
   * Drop everything one agent still has queued: the parent asked for the
   * teardown itself, so neither a settlement's nudge nor a report already in
   * the batch may announce assets the teardown is removing. A report that
   * arrives after this is queued afresh, not swallowed.
   */
  dropNudge(agentId: string): void {
    this.pendingNudges.delete(agentId);
    this.pendingFollowUps.delete(agentId);
  }

  /** Schedule a nudge, coalescing rapid completions within the batch window. */
  scheduleNudge(agentId: string): void {
    this.pendingNudges.add(agentId);
    this.ensureNudgeTimer();
  }

  /**
   * A settled agent reported again: it kept working after writing its result, or
   * a message reached its pane without reviving it. The report is news the
   * recorded result does not carry, so it is delivered apart from that result.
   */
  onAgentFollowUp(spawn: AgentSpawn, deliverable: string): void {
    if (!this.backgroundAgentIds.has(spawn.id)) return;
    this.pendingFollowUps.set(spawn.id, deliverable);
    this.ensureNudgeTimer();
  }

  /** One batch window serves both kinds of news; whichever is pending rides it. */
  private ensureNudgeTimer(): void {
    if (this.nudgeTimer) return;

    this.nudgeTimer = setTimeout(() => {
      this.nudgeTimer = null;
      const settlements = [...this.pendingNudges];
      this.pendingNudges.clear();
      const followUps = [...this.pendingFollowUps];
      this.pendingFollowUps.clear();

      for (const id of settlements) {
        this.emitIndividualNudge(id);
      }
      for (const [id, deliverable] of followUps) {
        this.emitFollowUp(id, deliverable);
      }
    }, NUDGE_DELAY_MS);
  }

  /**
   * Nudge on every settlement of a background agent — a revived run notifies on each
   * settlement, not just the first. Only dispose clears the set.
   */
  onAgentComplete(spawn: AgentSpawn): void {
    if (!this.backgroundAgentIds.has(spawn.id)) return;
    // A stop the parent ordered itself is not news: stop_cowboy_agent returned that
    // same settlement to the caller that made the call.
    if (stoppedByParent(spawn)) return;
    this.scheduleNudge(spawn.id);
  }

  dispose(): void {
    if (this.nudgeTimer) {
      clearTimeout(this.nudgeTimer);
      this.nudgeTimer = null;
    }
    this.pendingNudges.clear();
    this.pendingFollowUps.clear();
    this.backgroundAgentIds.clear();
    this.disposed = true;
  }

  // ── Private ──

  /** Deliver a settled agent's later report, named as news beyond its result. */
  private emitFollowUp(agentId: string, deliverable: string): void {
    // Skip if disposed: pi may be stale after session replacement.
    if (this.disposed) return;
    if (!isExtensionEnabled()) return;

    const pi = getPiInstance();
    const spawn = this.manager.getSpawn(agentId);
    if (!spawn) return;

    const details = buildAgentDetails(spawn, {
      includeRunInfo: true,
      includeStatus: true,
    });
    const headline = `[Cowboy agent "${spawn.display.type}" ${spawn.id} reported again after settling]`;

    try {
      // The run's own result is already with the parent; this is what came after it.
      pi.sendMessage(
        {
          customType: "subagent-result",
          content: `${headline}\n\n${deliverable}`,
          details,
          display: true,
        },
        {
          deliverAs: "followUp",
          triggerTurn: true,
        },
      );
    } catch {
      // sendMessage failed — fall back to the captured spawning-session context.
      const spawnCtx = spawn.execution.spawnCtx;
      if (spawnCtx) {
        try {
          spawnCtx.ui.notify(`${headline} New report available`, "info");
        } catch {
          // Spawn ctx may also be stale after session replacement.
        }
      }
    }
  }

  private emitIndividualNudge(agentId: string): void {
    // Skip if disposed: pi may be stale after session replacement.
    if (this.disposed) return;
    // The one emission point, so a settlement whose batch window straddles the
    // switch is silenced too; the settlement is not replayed on re-enable.
    if (!isExtensionEnabled()) return;

    // Read pi at call time for a fresh reference after reload.
    const pi = getPiInstance();

    const spawn = this.manager.getSpawn(agentId);
    if (!spawn) return;

    const details = buildAgentDetails(spawn, {
      includeRunInfo: true,
      includeStatus: true,
    });

    try {
      // Queued as a follow-up: a parent turn in progress finishes on its own terms,
      // so a completion never interrupts work the orchestrator already started.
      pi.sendMessage(
        {
          customType: "subagent-result",
          content: `${settledHeadline(spawn)}\n\n${formatResultContent(spawn)}`,
          details,
          display: true,
        },
        {
          deliverAs: "followUp",
          triggerTurn: true,
        },
      );
    } catch {
      // sendMessage failed — fall back to the captured spawning-session context.
      const spawnCtx = spawn.execution.spawnCtx;
      if (spawnCtx) {
        try {
          spawnCtx.ui.notify(
            `[Cowboy agent "${spawn.display.type}" ${lifecycleStatus(spawn.lifecycle)}] Result available`,
            "info",
          );
        } catch {
          // Spawn ctx may also be stale after session replacement.
        }
      }
    }
  }
}

/** Whether a settlement is a stop the parent agent requested through its own tool. */
function stoppedByParent(spawn: AgentSpawn): boolean {
  const lifecycle = spawn.lifecycle;
  return (
    hasOutcome(lifecycle) &&
    lifecycle.status === "stopped" &&
    lifecycle.stop.initiator === "agent"
  );
}

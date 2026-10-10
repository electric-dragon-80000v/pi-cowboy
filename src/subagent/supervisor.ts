/**
 * supervisor.ts — ProcessSupervisorEngine: one subagent process in a herdr pane.
 *
 * - `start(plan, ref)` launches pi into a caller-resolved host; the supervisor
 *   never creates a host, and returns on spawn acceptance, not registry presence.
 * - `adopt(ref)` binds an already-spawned run without launching (the revive seam).
 * - SETTLEMENT IS REPORT-ONLY: only the subagent's own report settles a run — a
 *   result deliverable held unchanged for one confirm poll — plus an explicit
 *   stop(). Herdr state never settles; a run with no report stays unsettled
 *   until the user stops it.
 * - SETTLEMENT IS NOT THE END OF THE WATCH: the loop keeps polling after the
 *   first report, so a run that keeps working (or is steered) reports again.
 *   Each later report goes to onFollowUp; only the first one settles.
 * - The watch ends at `stop()`, `detach()`, or `abandon()`.
 * - `stop(graceMs)` is INTERRUPT-ONLY: ctrl+c, then wait — it NEVER closes the
 *   pane, since closing it breaks the worktree removal that runs AFTER stop()
 *   returns. A pending watch always ends `stopped`, even when the process survives.
 * - `abandon()` is DISPOSAL ONLY for a discarded parent session (`/new`,
 *   `/reload`, `/fork`): polling stops, the pane/process/artifacts survive, and
 *   watch() never settles.
 * - Artifacts are NOT this engine's to remove: a settled run stays watched, so
 *   its result directory survives settlement and is removed when the run is
 *   dropped (see removeResultArtifacts in result-artifacts.ts).
 * - One supervisor per run: re-delegation and revive each use a fresh instance.
 */

import { createLogger } from "../logger.js";
import { errorMessage } from "../utils.js";
import type { AgentHost, AgentHostRef } from "../agents/agent-host.js";
import type { StopInitiator } from "../types.js";
import type { DeliverableReport, DeliverableSource } from "./deliverable.js";

const log = createLogger("supervisor");

export interface SubagentLaunchPlan {
  name?: string;
  cwd?: string;
  piArgs: string[];
  taskSlug?: string;
}

export type SubagentExitOutcome =
  | { kind: "completed"; deliverable: string }
  | { kind: "stopped"; initiator: StopInitiator };

export interface ProcessSupervisor {
  start(plan: SubagentLaunchPlan, ref: AgentHostRef): Promise<void>;
  /** Bind an already-spawned run without launching; the host is never called. */
  adopt(ref: AgentHostRef): void;
  watch(): Promise<SubagentExitOutcome>;
  stop(graceMs: number): Promise<boolean>;
  /**
   * Stop watching. The watch is over for the caller — the outcome is left as it
   * stands, and the pane, process, and artifacts are untouched.
   */
  detach(): void;
  abandon(): void;
}

/** Tunables for a ProcessSupervisorEngine. All optional; defaults are production-shaped. */
export interface ProcessSupervisorOptions {
  /** Report poll interval (ms). Default 2000. */
  pollMs?: number;
  /** Who stop() represents; the stopped outcome carries it. Default "user". */
  stopInitiator?: StopInitiator;
  /**
   * A report delivered after the run already settled: work the recorded result
   * does not carry. The run's first report settles instead of calling this.
   */
  onFollowUp?: (deliverable: string) => void;
}

const DEFAULT_POLL_MS = 2_000;

/** A promise with its resolver, for a cell that is filled in exactly once. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  // The executor runs synchronously, so the resolver exists before the promise leaves this call.
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Lifecycle of one run as this engine sees it: idle -> watching -> ended. A
 * watching run carries the host address it polls, so "watching without a host"
 * is unrepresentable and no caller has to re-check for it. Ended means the
 * loop is gone; the run's outcome, if any, lives in `outcome`.
 */
type SupervisorPhase =
  | { kind: "idle" }
  | { kind: "watching"; ref: AgentHostRef }
  | { kind: "ended" };

export class ProcessSupervisorEngine implements ProcessSupervisor {
  private readonly pollMs: number;
  private readonly stopInitiator: StopInitiator;
  private readonly onFollowUp: ((deliverable: string) => void) | undefined;

  private phase: SupervisorPhase = { kind: "idle" };
  /**
   * The run's one terminal decision, written once and never overwritten: the
   * first report or stop() sets it, and later reports are follow-ups instead.
   */
  private outcome: SubagentExitOutcome | null = null;
  /** The one settlement cell: watch() hands out this promise, settle() fills it in. */
  private readonly settlement = deferred<SubagentExitOutcome>();
  /** watch() hands out one promise per instance, so a second call has to be refused. */
  private watchIssued = false;
  /** Ends the loop's wait; set only while the loop sleeps between polls. */
  private wakeLoop: (() => void) | null = null;
  /** The last report confirmed stable and handed on, settlement or follow-up. */
  private delivered: DeliverableReport | null = null;
  /** A report seen once; a report still being written is not final. */
  private held: DeliverableReport | null = null;
  private watchStartedAt = 0;

  constructor(
    private readonly host: AgentHost,
    private readonly deliverable: DeliverableSource,
    options: ProcessSupervisorOptions = {},
  ) {
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    this.stopInitiator = options.stopInitiator ?? "user";
    this.onFollowUp = options.onFollowUp;
  }

  /**
   * Launch pi into the caller's pane (never created or closed here). Returns on
   * spawn acceptance, not registry presence. One launch per instance; a failed
   * launch reverts to idle so the caller may retry.
   */
  async start(plan: SubagentLaunchPlan, ref: AgentHostRef): Promise<void> {
    if (this.phase.kind !== "idle") {
      throw new Error(
        "ProcessSupervisor.start() may launch once per supervisor — create a fresh instance per attempt",
      );
    }
    this.phase = { kind: "watching", ref };
    try {
      await this.host.start(ref, {
        name: plan.name ?? "subagent",
        piArgs: plan.piArgs,
      });
    } catch (err) {
      // A failed launch is not a run: revert so the caller may retry, unless
      // something settled the run while the launch was in flight.
      if (this.isWatching()) this.phase = { kind: "idle" };
      throw err;
    }
  }

  /**
   * Bind an already-spawned run without launching. One adoption per instance —
   * revive with a fresh engine. Throws when this instance is not idle.
   */
  adopt(ref: AgentHostRef): void {
    if (this.phase.kind !== "idle") {
      throw new Error(
        "ProcessSupervisor.adopt() supervises one run per supervisor — create a fresh instance per attempt",
      );
    }
    this.phase = { kind: "watching", ref };
    log.debug("adopted", {
      paneId: ref.paneId,
      pollMs: this.pollMs,
      stopInitiator: this.stopInitiator,
    });
  }

  /**
   * Supervise until the run's own report artifacts supply a terminal outcome.
   * Rejects when never started or a watch is pending; resolves immediately with
   * the stored outcome after settlement. The run's single loop polls it, so a
   * host round trip slower than the interval cannot stack observations.
   */
  watch(): Promise<SubagentExitOutcome> {
    // A settled run replays its outcome; the loop may still be polling for
    // follow-ups, which do not change what this promise carries.
    if (this.outcome !== null) return Promise.resolve(this.outcome);
    switch (this.phase.kind) {
      case "idle":
        return Promise.reject(
          new Error(
            "ProcessSupervisor.watch() requires start() or adopt() first",
          ),
        );
      case "ended":
        // Detached or abandoned with no outcome: nothing will ever settle it.
        return this.settlement.promise;
      case "watching":
        break;
    }
    if (this.watchIssued) {
      return Promise.reject(
        new Error("ProcessSupervisor.watch() is already active for this run"),
      );
    }
    const { ref } = this.phase;
    this.watchIssued = true;
    this.watchStartedAt = performance.now();
    log.debug("started", {
      paneId: ref.paneId,
      pollMs: this.pollMs,
      stopInitiator: this.stopInitiator,
    });
    void this.runLoop().catch((err) => {
      // The loop's own steps absorb their failures; this is a bug worth seeing.
      log.error("poll loop failed", { errorMessage: errorMessage(err) });
    });
    return this.settlement.promise;
  }

  /**
   * Interrupt-only stop: ctrl+c, then wait graceMs. NEVER closes the pane — the
   * worktree removal runs AFTER this returns. True when the process is confirmed
   * gone (including already-gone); always ends a pending watch `stopped`.
   */
  async stop(graceMs: number): Promise<boolean> {
    const phase = this.phase;
    if (phase.kind !== "watching") {
      return false; // nothing live to stop
    }
    // A run that already reported is not this caller's to interrupt: its pane
    // stays available for a steer, and its later reports arrive as follow-ups.
    if (this.outcome !== null) return false;
    const { ref } = phase;
    const stopped = await this.host
      .stop(ref, { interruptGraceMs: graceMs, confirmMs: 0 })
      .catch((err) => {
        log.debug("host stop failed", {
          errorMessage: errorMessage(err),
        });
        return false;
      });
    log.debug("stop requested", {
      paneId: ref.paneId,
      graceMs,
      stopped,
      initiator: this.stopInitiator,
    });
    this.settle({ kind: "stopped", initiator: this.stopInitiator });
    // A stopped run is over: nothing written after this belongs to it.
    this.stopPolling("stopped");
    return stopped;
  }

  /**
   * Disposal-only teardown for a discarded parent session: stop polling, leave
   * watch() pending with NO outcome, and leave pane, process, and artifacts
   * untouched. Idempotent; a no-op once finalized.
   */
  abandon(): void {
    this.stopPolling("abandoned");
  }

  /** Stop watching a run the caller has stopped tracking. Idempotent. */
  detach(): void {
    this.stopPolling("detached");
  }

  /**
   * End the poll loop and let the run rest where it is: the outcome is not
   * changed, and the pane, process, and artifacts are untouched. A no-op once
   * the loop is gone.
   */
  private stopPolling(event: "stopped" | "detached" | "abandoned"): void {
    const phase = this.phase;
    if (phase.kind !== "watching") return;
    log.debug(event, {
      paneId: phase.ref.paneId,
      pollMs: this.pollMs,
      outcome: this.outcome?.kind ?? null,
    });
    this.phase = { kind: "ended" };
    this.endWait();
  }

  /**
   * Terminal transition: the one writer of a settled outcome, so a second
   * caller (a report landing after a stop) can never overwrite the first. The
   * loop is left running, since a settled run may still report again.
   */
  private settle(outcome: SubagentExitOutcome): void {
    if (this.phase.kind !== "watching" || this.outcome !== null) return;
    this.outcome = outcome;
    log.debug("settlement decision", {
      ...outcome,
      paneId: this.phase.ref.paneId,
      runDurationMs: this.watchStartedAt
        ? performance.now() - this.watchStartedAt
        : 0,
    });
    this.settlement.resolve(outcome);
  }

  /**
   * The run's one loop: each pass waits out an interval, then polls. It keeps
   * going past settlement, so a later report reaches onFollowUp; only a stop or
   * a detach ends the wait.
   */
  private async runLoop(): Promise<void> {
    for (;;) {
      if (!(await this.pauseUntilNextPoll())) return;
      await this.pollOnce();
    }
  }

  /**
   * Wait out one poll interval. False once the watch is over — the one question
   * a suspension point has to ask, and the only place the loop asks it. Unref'd,
   * so a pending poll never holds the process open.
   */
  private pauseUntilNextPoll(): Promise<boolean> {
    if (!this.isWatching()) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.wakeLoop = null;
        resolve(true);
      }, this.pollMs);
      timer.unref();
      this.wakeLoop = () => {
        clearTimeout(timer);
        resolve(false);
      };
    });
  }

  /** End the loop's wait: the watch is over, so no further poll happens. */
  private endWait(): void {
    this.wakeLoop?.();
    this.wakeLoop = null;
  }

  /** One poll: read the run's report, then settle the run or announce a follow-up. */
  private async pollOnce(): Promise<void> {
    const report = await this.readDeliverable();
    // No report yet: keep polling. No watchdog, turn limit, liveness probe, or
    // failed turn ends a run — only a report or an explicit stop does.
    if (report === null || report.content.trim().length === 0) {
      this.held = null;
      return;
    }
    // Byte-for-byte the report already handed on: nothing to announce, whichever
    // turn wrote it.
    if (this.delivered !== null && sameReport(this.delivered, report)) {
      this.held = null;
      return;
    }
    // First sighting or rewrite: hold one poll; a report still being edited is
    // not final.
    if (this.held === null || !sameReport(this.held, report)) {
      this.held = report;
      log.debug("deliverable held for confirmation");
      return;
    }
    this.held = null;
    this.delivered = report;
    if (this.outcome === null) {
      this.settle({ kind: "completed", deliverable: report.content });
      return;
    }
    // The run already settled: this is work done after its recorded result.
    if (this.isWatching()) this.onFollowUp?.(report.content);
  }

  /** One artifact read; a failed read is a poll with nothing in it. */
  private async readDeliverable(): Promise<DeliverableReport | null> {
    try {
      return await this.deliverable.readDeliverable();
    } catch (err) {
      log.debug("readDeliverable failed", {
        errorMessage: errorMessage(err),
      });
      return null;
    }
  }

  /** Whether this engine is still watching a run: asked at each transition and at each wait's start. */
  private isWatching(): boolean {
    return this.phase.kind === "watching";
  }
}

/** Whether two reads are the same report: same words, same write. */
function sameReport(a: DeliverableReport, b: DeliverableReport): boolean {
  return a.content === b.content && a.mtime === b.mtime;
}

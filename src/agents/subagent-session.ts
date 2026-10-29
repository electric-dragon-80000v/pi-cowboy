/**
 * subagent-session.ts — One subagent run's lifecycle and spawn projection.
 * Exports SubagentSession, buildAgentSpawn, DISPOSE_QUEUED_MESSAGE.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createLogger } from "../logger.js";
import {
  resolveMainCheckout,
  worktreeRetentionReason,
} from "../infrastructure/git-client.js";
import {
  getAgentSpawns,
  getHarnessRegistry,
  getPiInstance,
  getStore,
  getWorktreeMaterialization,
} from "../shell.js";
import { subagentResultFileFor } from "../paths.js";
import {
  removeResultArtifacts,
  removeResultFile,
} from "../subagent/result-artifacts.js";
import {
  createPaneSupervisor,
  type SupervisorTransport,
} from "../subagent/pane-supervisor.js";
import {
  type ProcessSupervisor,
  type ProcessSupervisorOptions,
  type SubagentExitOutcome,
} from "../subagent/supervisor.js";
import type {
  ConcurrencyPools,
  PoolReservation,
} from "../concurrency-pools.js";
import type {
  AgentLaunchState,
  AgentSpawn,
  ModelChoice,
  SpawnConfig,
  StopInitiator,
  WorktreeRetentionReason,
} from "../types.js";
import { lifecycleResult, lifecycleStatus } from "../types.js";
import { errorMessage, modelChoiceKey } from "../utils.js";
import {
  buildWorktreeBranch,
  slugifyWorktreeType,
} from "../spawn/worktree-policy.js";
import {
  provisionOwnedCheckout,
  type OwnedCheckout,
} from "../spawn/sandbox.js";
import type { AgentHost, AgentHostRef, DeliverOutcome } from "./agent-host.js";
import type { AnyHarnessId } from "./harness.js";
import {
  engageExecution,
  endExecutionRun,
  placeExecution,
} from "./agent-environment.js";
import {
  exportRunSession,
  renderHandoverTask,
  type HandoverFault,
  type HandoverOutcome,
} from "./handover.js";
import { buildLaunchPlan, type SubagentLaunchPlan } from "./agent-runner.js";
import {
  abortQueuedRun,
  activateRun,
  createRun,
  disposeLiveRun,
  disposeQueuedRun,
  dropRun,
  enterSettling,
  failStart,
  finishSettling,
  handoverRun,
  projectLifecycle,
  reviveRun,
  startRun,
  type RunArtifacts,
  type RunState,
} from "./run-state.js";
import type { SubagentType } from "./types.js";
import { reviveSettledRun } from "./agent-reviver.js";

export { DISPOSE_QUEUED_MESSAGE } from "./run-state.js";

const log = createLogger("session");

/** Steer verdict; refusals carry the reason. */
export type SteerOutcome =
  | { kind: "delivered" }
  /**
   * The pane took the message, but the run could not be revived, so no second
   * completion message will arrive. Distinct from a refusal: the steer landed.
   */
  | { kind: "delivered-not-revived"; reason: string }
  | { kind: "refused"; reason: string };

export interface SpawnOptions extends SpawnConfig {
  isBackground?: boolean;
  /** Parent abort signal — when aborted, the subagent is also stopped. */
  signal?: AbortSignal;
}

/**
 * Spawn options after the spawn path has resolved the harness the launch uses.
 * Carrying it here keeps admission, a queued drain, a revived turn, and the
 * launch plan on one value instead of resolving the harness again later.
 */
export interface ResolvedSpawnOptions extends SpawnOptions {
  harness: AnyHarnessId;
}

export interface SpawnArgs {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  type: SubagentType;
  prompt: string;
  options: ResolvedSpawnOptions;
}

/** Spawn is born queued and mutated in place; its identity is public API. */
export function buildAgentSpawn(
  args: SpawnArgs,
  promise: Promise<string>,
): AgentSpawn {
  const { type, options } = args;
  return {
    id: "",
    lifecycle: { phase: "queued", queuedAt: Date.now() },
    display: {
      type,
      description: options.description,
      taskSlug: options.taskSlug,
      invocation: options.invocation,
      orchestration: options.orchestration,
      worktree: options.worktree,
    },
    execution: {
      promise,
      abortController: new AbortController(),
      host: options.hostRef,
      history: [],
    },
  };
}

/** One terminal writer for the completion promise, even when host calls race. */
class CompletionGate {
  private resolve?: (value: string) => void;
  readonly promise: Promise<string>;

  constructor() {
    this.promise = new Promise<string>((resolve) => {
      this.resolve = resolve;
    });
  }

  open(value: string): void {
    const resolve = this.resolve;
    if (!resolve) return;
    this.resolve = undefined;
    resolve(value);
  }
}

export interface SubagentSessionDeps {
  transport: SupervisorTransport;
  /** The pool accountant the run charges and returns capacity through. */
  pools: ConcurrencyPools;
  /**
   * Called once per run end, whatever ended it: the settle pass, a failed
   * start, or a queued abort.
   */
  onRunEnded(spawn: AgentSpawn): void;
  /**
   * A report from a run that already settled: work the recorded result does not
   * carry, reported while the run stays settled.
   */
  onFollowUpResult(spawn: AgentSpawn, deliverable: string): void;
}

interface SubagentSessionOptions {
  id: string;
  args: SpawnArgs;
  deps: SubagentSessionDeps;
}

/**
 * Placement ownership across one launch. A started run owns its pane (the
 * pane and process stay alive for stay-alive cleanup), so only a held
 * placement is ever released: start success commits and disarms the launch's
 * single finally, while every pre-start exit still holds and releases once.
 */
type LaunchPlacement =
  | { kind: "none" }
  | { kind: "held"; host: AgentHost; ref: AgentHostRef }
  | { kind: "committed" };

type LaunchFailure = { kind: "none" } | { kind: "failed"; error: unknown };

/**
 * What a launch does about the workspace it runs in. A spawn may provision the
 * owned checkout it was named for; a handover's next run already has one and
 * must never create a second.
 */
type LaunchOrigin = { kind: "spawn" } | { kind: "handover" };

/** What a handover asks one session to do: launch the next run under another harness. */
export interface SessionHandoverRequest {
  readonly harness: AnyHarnessId;
  /** The next run's model and level; absent leaves the harness to choose. */
  readonly modelChoice?: ModelChoice;
}

/** The one shape a handover that did not happen takes. */
function faulted(fault: HandoverFault): HandoverOutcome {
  return { kind: "faulted", fault };
}

/**
 * Per-run lifecycle. State moves only through commit, which projects the
 * spawn's lifecycle from the run, so the two cannot disagree. The supervisor
 * stays an attachment, not state, so stop can detach it before waiting and
 * its watcher cannot recurse. A settled session revives on steer (see revive
 * below).
 */
export class SubagentSession {
  readonly id: string;
  private readonly args: SpawnArgs;
  private readonly deps: SubagentSessionDeps;
  private readonly gate = new CompletionGate();
  private readonly stableSpawn: AgentSpawn;
  private run: RunState;
  /** The run's launch artifacts; settlement keeps them and a revive resumes them. */
  private launchState?: AgentLaunchState;
  /** Why an owned worktree was kept; only a settled run carries one. */
  private retention?: WorktreeRetentionReason;
  /** Live supervisor attachment: launched, or adopted on revive. */
  private supervisor?: ProcessSupervisor;
  private parentBinding?: { signal: AbortSignal; handler: () => void };

  constructor({ id, args, deps }: SubagentSessionOptions) {
    this.id = id;
    this.args = args;
    this.deps = deps;
    this.stableSpawn = buildAgentSpawn(args, this.gate.promise);
    this.stableSpawn.id = id;
    const birth = this.stableSpawn.lifecycle;
    // The spawn is born queued, so the run starts from its queued time.
    this.run = createRun(
      birth.phase === "queued" ? birth.queuedAt : Date.now(),
    );
    // Registered before queue/start/settle; leaves only on explicit drop, so
    // the spawn outlives session disposal and stays listed and cleanable.
    getAgentSpawns().add(this.stableSpawn);
    this.bindParentSignal();
  }

  get spawn(): AgentSpawn {
    return this.stableSpawn;
  }

  get promise(): Promise<string> {
    return this.gate.promise;
  }

  isQueued(): boolean {
    return this.run.shell === "held" && this.run.process.kind === "queued";
  }
  isLaunching(): boolean {
    return (
      this.run.shell !== "dropped" && this.run.process.kind === "launching"
    );
  }
  isActive(): boolean {
    return this.run.shell !== "dropped" && this.run.process.kind === "active";
  }
  /**
   * A run whose terminal is decided is settled, even while the settle pass
   * still runs its probes: steer observes this, so a message landing mid-pass
   * delivers with settled semantics and revives the next turn.
   */
  isSettled(): boolean {
    return (
      this.run.shell === "held" &&
      (this.run.process.kind === "settling" ||
        this.run.process.kind === "settled")
    );
  }

  /**
   * The run's one writer: move the state, then project the spawn's lifecycle
   * from it, so a reader can never see the spawn disagree with the run.
   */
  private commit(next: RunState): void {
    this.run = next;
    this.spawn.lifecycle = projectLifecycle(next, this.artifacts);
  }

  /** What the projection reads off the session: the launch this run produced and the retention reason it recorded. */
  private get artifacts(): RunArtifacts {
    return { launch: this.launchState, retention: this.retention };
  }

  /** Project the run before the async launch; a spawn that is not queued takes no pool. */
  start(reservation?: PoolReservation): void {
    if (!this.isQueued()) return;
    if (reservation) this.deps.pools.reserve(this.id, reservation);
    this.commit(startRun(this.run, Date.now()));
    void this.launch();
  }

  rollbackStart(): void {
    this.commit(dropRun(this.run, this.artifacts));
    this.detachParentBinding();
    this.gate.open("");
  }

  settleStartFailure(err: unknown): void {
    this.commit(failStart(this.run, errorMessage(err), Date.now()));
    this.detachParentBinding();
    this.gate.open("");
    this.deps.onRunEnded(this.spawn);
  }

  /**
   * Send a message to the agent's pane. Steering a settled session revives it:
   * a fresh supervisor adopts the same host and settles the run again.
   */
  async steer(message: string): Promise<SteerOutcome> {
    if (this.isQueued()) {
      return {
        kind: "refused",
        reason: `agent ${this.id} is queued — it has no pane yet, so it cannot receive a message. Wait for a concurrency slot (or stop it).`,
      };
    }
    const ref = this.spawn.execution.host;
    if (!ref) {
      // A missing host ref means different things along a run's life, so name
      // the one this is rather than blaming cleanup every time.
      const reason = this.isLaunching()
        ? `agent ${this.id} is still starting up — its pane does not exist yet, so it cannot receive a message. Retry in a moment.`
        : this.spawn.lifecycle.phase === "never-started"
          ? `agent ${this.id} never started, so it has no pane and there is nobody to receive the message.`
          : `agent ${this.id} has no pane (it was cleaned up), so there is nobody to receive the message.`;
      return { kind: "refused", reason };
    }
    // Snapshot settlement up front: the message delivers as the run was.
    const wasSettled = this.isSettled();
    let submit: DeliverOutcome;
    try {
      submit = await this.deps.transport
        .createHost(getPiInstance())
        .deliver(ref, message);
    } catch (error) {
      submit = { kind: "not-submitted", detail: errorMessage(error) };
    }
    if (submit.kind === "not-submitted") {
      return {
        kind: "refused",
        reason: `the message could not be delivered to agent ${this.id} — ${submit.detail}`,
      };
    }
    if (wasSettled) {
      // The message is in the pane from here on, so a revive that throws is
      // reported, not thrown: the steer landed and only the second turn's
      // watch is missing.
      try {
        this.revive(ref);
      } catch (error) {
        return {
          kind: "delivered-not-revived",
          reason: `the message reached its pane, but the agent could not be revived: ${errorMessage(error)}. No completion message will arrive — read the pane for the result.`,
        };
      }
    }
    return { kind: "delivered" };
  }

  /**
   * Return a settled run to the active lifecycle. Artifact policy (result-dir
   * recreation, stale-report removal) and adoption live in agent-reviver.ts;
   * the spawn's state resets here, in the attach seam, so the run stays its
   * only writer. See agent-reviver.ts for the pane guardrails.
   */
  private revive(ref: AgentHostRef): void {
    const startedAt = Date.now();
    reviveSettledRun({
      spawn: this.spawn,
      hostRef: ref,
      transport: this.deps.transport,
      supervisorOptions: this.supervisorOptions(),
      attachSupervisor: (supervisor, launch) => {
        // The settled turn's watch has done its job; the revived turn's reports
        // are the new supervisor's to find.
        this.supervisor?.detach();
        // A revived turn is a live process again, so it takes the same pools the first
        // turn held: its model's, its provider's, its harness's, and the global limit.
        this.deps.pools.reacquire(this.id, {
          harness: this.args.options.harness,
          modelKey: modelChoiceKey(this.args.options.modelChoice),
        });
        this.supervisor = supervisor;
        this.launchState = launch;
        // A revived run has not settled yet: no report, no retention reason.
        this.retention = undefined;
        this.commit(reviveRun(this.run, startedAt));
      },
      rebindParentSignal: () => this.bindParentSignal(),
      reportOutcome: (supervisor, outcome) => {
        void this.applySupervisorOutcome(supervisor, outcome);
      },
    });
  }

  async abort(initiator?: StopInitiator): Promise<boolean> {
    const stopIssued = this.isLaunching() || this.isActive();
    const run = this.run;
    log.debug("abort requested", {
      initiator,
      process: run.shell === "dropped" ? "dropped" : run.process.kind,
      shell: run.shell,
      stopIssued,
    });
    if (this.isQueued()) {
      this.deps.pools.cancelQueued(this.id);
      this.commit(abortQueuedRun(this.run, initiator ?? "agent", Date.now()));
      this.detachParentBinding();
      this.gate.open("");
      this.deps.onRunEnded(this.spawn);
      return true;
    }
    if (!this.isLaunching() && !this.isActive()) return false;
    this.spawn.execution.abortController.abort();
    await this.stopPaneProcess();
    // Re-read the run after the stop: disposal may have moved it meanwhile.
    if (!this.isLaunching() && !this.isActive()) return false;
    this.commit(
      enterSettling(
        this.run,
        { kind: "stopped", initiator: initiator ?? "agent" },
        Date.now(),
      ),
    );
    await this.settle();
    return true;
  }

  /**
   * Hand the environment to the next run of the same spawn, under another
   * harness. Gated on a settled run — a handover reads a finished session and
   * then replaces the run that produced it — and refused as a capability gap
   * when the source harness cannot export its own session. The next run is an
   * ordinary launch: the same checkout, the same staging directory, a new pane.
   */
  async handover(request: SessionHandoverRequest): Promise<HandoverOutcome> {
    const settled = this.run;
    // A run settled before it started (stopped or failed while queued) never
    // engaged an environment, so the check below is what reports it.
    if (settled.shell !== "held" || settled.process.kind !== "settled") {
      return faulted({
        kind: "agent-not-settled",
        status: lifecycleStatus(this.spawn.lifecycle),
      });
    }
    const from = this.spawn.execution.harness;
    const ref = this.spawn.execution.host;
    // A source run is a started run at a known address; one settled without
    // starting engaged neither.
    if (from === undefined || ref === undefined || !settled.process.started) {
      return faulted({ kind: "never-started" });
    }
    const cwd = this.args.options.worktree?.path ?? this.args.ctx.cwd;

    // Export before stopping: a harness that cannot export its session must
    // change nothing at all, so the capability is the first question asked.
    const exported = await exportRunSession(
      getHarnessRegistry(),
      from,
      {
        pi: this.args.pi,
        subagentId: this.id,
        paneId: ref.paneId,
        cwd,
      },
      { maxExcludedRatio: getStore().agent.handoverMaxExcludedRatio },
    );
    if (exported.kind === "faulted") return exported;
    // A steer may have revived the run while its session was exported; that
    // session is no longer finished, so this handover no longer applies.
    if (this.run !== settled) {
      return faulted({
        kind: "agent-not-settled",
        status: lifecycleStatus(this.spawn.lifecycle),
      });
    }

    // A settled run's process may still be alive, and launching the next
    // harness anyway would put two agents in one checkout.
    let stopped: boolean;
    try {
      stopped = await this.deps.transport.createHost(this.args.pi).stop(ref, {
        interruptGraceMs: 2_000,
        confirmMs: 10_000,
      });
    } catch (error) {
      return faulted({ kind: "stop-failed", detail: errorMessage(error) });
    }
    if (!stopped) {
      return faulted({
        kind: "stop-failed",
        detail: "the source process did not confirm it was gone",
      });
    }
    // The old process is gone, so its watch has nothing left to report: a
    // follow-up would belong to the run that just ended.
    this.supervisor?.detach();
    this.supervisor = undefined;

    // The ended run's report is still on disk; the next run must settle on its
    // own (a revive resets the same file for the same reason).
    removeResultFile(this.resultFilePath());
    const task = renderHandoverTask({
      taskSlug: this.spawn.display.taskSlug,
      sourceName: getHarnessRegistry().displayName(from),
      previous: this.spawn.execution.history.map(({ harness, sessionId }) => ({
        harness,
        sessionId,
      })),
      current: { harness: from, sessionId: exported.sessionId },
      session: exported.session,
    });

    endExecutionRun(this.spawn.execution, {
      harness: from,
      host: ref,
      cwd,
      sessionId: exported.sessionId,
      startedAt: settled.process.startedAt,
      endedAt: Date.now(),
    });
    this.args.prompt = task;
    this.args.options.harness = request.harness;
    this.args.options.modelChoice = request.modelChoice;
    this.launchState = undefined;
    this.retention = undefined;
    // A handover is not an admission, like a revive: the ended run released
    // its slots, and the next one takes them back before it launches.
    this.deps.pools.reacquire(this.id, {
      harness: request.harness,
      modelKey: modelChoiceKey(request.modelChoice),
    });
    this.commit(handoverRun(this.run, Date.now()));
    // The next run belongs to the same spawn, so it answers to the same parent:
    // an abort must stop it as it would stop a revive.
    this.bindParentSignal();
    await this.launch({ kind: "handover" });
    if (!this.isActive()) {
      const lifecycle = this.spawn.lifecycle;
      return faulted({
        kind: "launch-failed",
        detail:
          lifecycle.phase === "settled" && lifecycle.status === "error"
            ? lifecycle.error
            : "the next run did not start",
      });
    }
    return {
      kind: "handed-over",
      from,
      to: request.harness,
      ...(exported.loss === undefined ? {} : { loss: exported.loss }),
    };
  }

  /**
   * Unblock awaiters without touching the pane, and let the run's artifacts go:
   * a dropped spawn has no reporters left, so its result directory is removed.
   */
  drop(): void {
    this.commit(dropRun(this.run, this.artifacts));
    // The report watch outlives settlement, so dropping the spawn is what ends
    // it; only a run whose removal is confirmed lets go of its artifacts.
    this.supervisor?.detach();
    this.supervisor = undefined;
    removeResultArtifacts(this.resultFilePath());
    this.detachParentBinding();
    this.gate.open("");
  }

  /** Parent disposal does not stop independent panes or report completion. */
  settleForDispose(): void {
    if (this.isQueued()) {
      this.commit(disposeQueuedRun(this.run, Date.now()));
      this.gate.open("");
    } else if (this.isLaunching() || this.isActive()) {
      this.commit(disposeLiveRun(this.run));
      this.gate.open("");
    }
    // Disposal stops tracking only: abandon the poll loop, leave pane and process alive.
    this.supervisor?.abandon();
    this.supervisor = undefined;
    this.detachParentBinding();
  }

  private async launch(
    origin: LaunchOrigin = { kind: "spawn" },
  ): Promise<void> {
    let placement: LaunchPlacement = { kind: "none" };
    let failure: LaunchFailure = { kind: "none" };
    // The cwd a harness teardown needs if the launch fails past the plan; a
    // failure before the plan leaves it undefined, and no harness is recorded.
    let launchCwd: string | undefined;
    try {
      const host = this.deps.transport.createHost(this.args.pi);
      const pane = this.deps.transport.createPane(this.args.pi);
      const { pi, ctx, type, prompt, options } = this.args;
      // An owned checkout is provisioned here, once the run holds a slot: a
      // queued run must not hold a worktree or a pane. A caller that already
      // provisioned one (the spawn wizard) passes its own hostRef.
      // The wizard's placement belongs to the launch that provisioned it: a
      // handover's run addresses a pane of its own, never the one it ends.
      let ref = origin.kind === "spawn" ? options.hostRef : undefined;
      if (
        origin.kind === "spawn" &&
        !ref &&
        options.worktree?.kind === "owned"
      ) {
        let checkout: OwnedCheckout;
        try {
          checkout = await provisionOwnedCheckout({
            pi,
            host,
            parentCwd: ctx.cwd,
            spawnId: this.spawn.id,
            agentType: type,
            taskSlug: options.taskSlug,
            worktreeRoot: getStore().agent.worktreeRoot,
            materialization: getWorktreeMaterialization(),
            notify: (message, kind) => ctx.ui.notify(message, kind),
          });
        } catch (err) {
          // Allocation unwound itself: no checkout exists, so the failed settle
          // must not name one.
          options.worktree = undefined;
          this.spawn.display.worktree = undefined;
          throw err;
        }
        // The fallback has no checkout: the run starts in the parent cwd like
        // any non-repo run, and the launch opens its own pane.
        options.worktree =
          checkout.kind === "owned"
            ? { kind: "owned", ...checkout.worktree }
            : undefined;
        this.spawn.display.worktree = options.worktree;
        ref = checkout.kind === "owned" ? checkout.hostRef : undefined;
      }
      // The herdr agent name: the worktree's branch for a worktree run,
      // else the pinned `cow-<task>-<id>` the sandbox was allocated under.
      const agentName =
        options.worktree?.branch ??
        buildWorktreeBranch(
          options.taskSlug ?? slugifyWorktreeType(type),
          this.id,
        );
      const plan: SubagentLaunchPlan = await buildLaunchPlan(
        pi,
        ctx,
        type,
        prompt,
        {
          agentId: this.id,
          harness: options.harness,
          modelChoice: options.modelChoice,
          fork: options.fork,
          cwd: options.worktree?.path,
          projectTrusted: options.projectTrusted,
          description: options.description,
          worktree: options.worktree,
          agentGuidance: options.orchestration.guidance,
        },
      );
      const launch: AgentLaunchState = { resultFile: plan.launch.resultFile };
      this.launchState = launch;
      launchCwd = plan.cwd;
      const harnesses = getHarnessRegistry();
      const harness = harnesses.require(plan.harness);
      if (!ref) {
        const worktree = options.worktree;
        ref = await host.hostAt({
          unit: "pane",
          cwd: plan.cwd,
          label: options.taskSlug ?? type,
          name: agentName,
          ...(worktree === undefined
            ? {}
            : {
                checkout: {
                  path: worktree.path,
                  repoCwd: await resolveMainCheckout(pi, worktree.path),
                  branch: worktree.branch,
                },
              }),
        });
      }
      placement = { kind: "held", host, ref };
      if (!this.isLaunching()) return;
      placeExecution(this.spawn.execution, ref);
      // Recorded before prepare: cleanup and a failed launch read it to tear
      // this harness's pane state down, regardless of later config changes.
      engageExecution(this.spawn.execution, plan.harness);
      // The pane exists now, so the harness can bring it into its launch state.
      await harness.prepare({
        pi,
        pane,
        paneId: ref.paneId,
        cwd: plan.cwd,
        launch: plan.launch,
        config: harnesses.config(plan.harness),
      });
      const supervisor = createPaneSupervisor({
        host,
        resultFile: launch.resultFile,
        supervisorOptions: this.supervisorOptions(),
        transport: this.deps.transport,
      });
      this.supervisor = supervisor;
      await supervisor.start(
        {
          name: agentName,
          cwd: plan.cwd,
          piArgs: plan.piArgs,
          agentMultiplexerKind: harness.agentMultiplexerKind,
          taskSlug: options.taskSlug,
        },
        ref,
      );
      placement = { kind: "committed" };
      if (!this.isLaunching()) return;
      this.commit(activateRun(this.run));
      void supervisor
        .watch()
        .then((outcome) => this.applySupervisorOutcome(supervisor, outcome));
    } catch (err) {
      failure = { kind: "failed", error: err };
    } finally {
      if (placement.kind === "held")
        await placement.host
          .release(placement.ref, "placement")
          .catch(() => {});
    }
    if (failure.kind === "failed" && this.isLaunching()) {
      // Best-effort: a failed teardown is logged, never allowed to mask the
      // launch error that caused it.
      const harnessId = this.spawn.execution.harness;
      if (harnessId !== undefined) {
        try {
          await getHarnessRegistry()
            .require(harnessId)
            .teardown({
              pi: this.args.pi,
              paneId: this.spawn.execution.host?.paneId ?? null,
              cwd: launchCwd ?? null,
              subagentId: this.spawn.id,
            });
        } catch (error) {
          log.warn("harness teardown failed after a failed launch", {
            spawnId: this.spawn.id,
            harness: harnessId,
            error: errorMessage(error),
          });
        }
      }
      this.commit(
        enterSettling(
          this.run,
          { kind: "failed", error: errorMessage(failure.error) },
          Date.now(),
        ),
      );
      await this.settle();
    }
  }

  /** Report-only: poll for the report; no liveness or turn policy. */
  private supervisorOptions(): ProcessSupervisorOptions {
    return {
      stopInitiator: "agent",
      onFollowUp: (deliverable) =>
        this.deps.onFollowUpResult(this.spawn, deliverable),
    };
  }

  /** Where the run's result artifacts live; a run that never launched still reserves the path. */
  private resultFilePath(): string {
    return this.launchState?.resultFile ?? subagentResultFileFor(this.id);
  }

  private async applySupervisorOutcome(
    supervisor: ProcessSupervisor,
    outcome: SubagentExitOutcome,
  ): Promise<void> {
    if (!this.isActive() || this.supervisor !== supervisor) return;
    log.debug("outcome mapped", {
      kind: outcome.kind,
    });
    switch (outcome.kind) {
      case "completed": {
        this.commit(
          enterSettling(
            this.run,
            { kind: "completed", result: outcome.deliverable || "" },
            Date.now(),
          ),
        );
        await this.settle();
        return;
      }
      case "stopped":
        await this.abort(outcome.initiator);
    }
  }

  private async stopPaneProcess(): Promise<void> {
    const supervisor = this.supervisor;
    if (supervisor) {
      this.supervisor = undefined;
      await supervisor.stop(2_000);
      return;
    }
    const ref = this.spawn.execution.host;
    if (!ref) return;
    await this.deps.transport
      .createHost(getPiInstance())
      .stop(ref, { interruptGraceMs: 2_000, confirmMs: 10_000 });
  }

  /**
   * Settle passes serialize: a revive can move the run out of settling while
   * a pass still awaits its probes, and the revived run settles through this
   * same method. Chained, never concurrent — a second settlement waits for
   * the in-flight pass instead of doubling its effects or racing its writes.
   */
  private settleChain: Promise<void> = Promise.resolve();

  private async settle(): Promise<void> {
    if (this.run.shell !== "held" || this.run.process.kind !== "settling")
      return;
    const previous = this.settleChain;
    let done!: () => void;
    const current = new Promise<void>((resolve) => {
      done = resolve;
    });
    this.settleChain = current;
    await previous;
    try {
      await this.runSettlePass();
    } finally {
      done();
    }
  }

  /**
   * One settlement's terminal pass. Past the first await a revive may have
   * moved the run, so per-run writes apply only to the run that entered,
   * matched by identity — the revived turn keeps its supervisor, its blank
   * retention reason, and its rebound parent binding.
   * First-settlement effects stay unconditional: a revive never re-acquires
   * a slot, and the once-only gate keeps the first run's result.
   */
  private async runSettlePass(): Promise<void> {
    const settlingRun = this.run;
    if (settlingRun.shell !== "held" || settlingRun.process.kind !== "settling")
      return;
    // The gate opens once: snapshot the entered run's result before a revive
    // can re-project the lifecycle to spawned.
    const result = lifecycleResult(this.spawn.lifecycle);
    const retention = await this.readWorktreeRetention();
    this.deps.pools.release(this.id);
    // The supervisor stays attached past settlement: its watch is what reports
    // the follow-ups a later turn produces. A revive replaces it (see revive).
    this.deps.onRunEnded(this.spawn);
    // A revive rebound the parent signal for the next turn; detach only ours.
    if (this.run === settlingRun) this.detachParentBinding();
    this.gate.open(result);
    if (this.run === settlingRun) {
      // Still ours: publish this run's probe answer, mapping the probe's clean
      // (null) to the field's absent (undefined); a revive cleared the reason
      // for the next turn, so writing after one would resurrect it.
      this.retention = retention ?? undefined;
      this.commit(finishSettling(this.run));
    }
    // A run revived mid-pass settles through its own chained pass, which runs
    // that run's probe, release, and nudge; finishing it here would settle it
    // ahead of all three.
  }

  private async readWorktreeRetention(): Promise<WorktreeRetentionReason | null> {
    const worktree = this.spawn.display.worktree;
    if (worktree?.kind !== "owned") return null;
    return worktreeRetentionReason(getPiInstance(), worktree.path);
  }

  private detachParentBinding(): void {
    const binding = this.parentBinding;
    if (!binding) return;
    this.parentBinding = undefined;
    binding.signal.removeEventListener("abort", binding.handler);
  }

  /** Parent abort stops this run; re-bound on revive since settlement detaches it. */
  private bindParentSignal(): void {
    if (this.parentBinding) return;
    const signal = this.args.options.signal;
    if (!signal || signal.aborted) return;
    const handler = () => {
      log.debug("parent signal fired", { initiator: "user" });
      void this.abort("user");
    };
    signal.addEventListener("abort", handler, { once: true });
    this.parentBinding = { signal, handler };
  }
}

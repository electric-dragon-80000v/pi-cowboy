/**
 * agent-cleanup.ts — state-changing cleanup orchestration (policy lives in cleanup-policy.ts).
 * createWorktreeTeardown: worktree/branch/pane removal over injected actuators.
 * createCleanup: settled-or-recovered run cleanup over the assets seam — all
 * runs in the environment, not only the active one.
 * WorktreeTeardown/Cleanup: the two planes. WorktreeTeardownOutcome: removal result.
 * WorktreeRemovalTarget: the tree and panes a teardown removes through.
 * AgentCleanupRegistry: spawn lookup/drop surface.
 * Report-gated (only ended runs are cleaned up; live runs are refused, never stopped);
 * ordered: gate before removal, workspace before pane, branch only after confirmed checkout removal.
 */

import type { AgentSpawn, WorktreeRetentionReason } from "../types.js";
import { hasOutcome } from "../types.js";
import type { BranchCleanupResult } from "../infrastructure/git-client.js";
import { createLogger } from "../logger.js";
import { errorMessage } from "../utils.js";
import type {
  AgentMultiplexer,
  AgentHostRef,
  HostObservation,
} from "./agent-host.js";
import type {
  AgentAssets,
  CleanupDeps,
  Located,
  RunTeardown,
} from "./agent-assets.js";
import {
  ambiguousReport,
  assembleReport,
  assessRemovability,
  forcedFields,
  keptReport,
  paneDispositionFor,
  planRecovered,
  recordedSettlement,
  recoveryGate,
  recoveryRefusalReason,
  removalMechanismOf,
  shouldDropSpawn,
  type CleanupOptions,
  type CleanupReport,
  type DiscoveryBasis,
  type PaneOutcome,
  type RemovablePlan,
  type RemovalOutcomes,
  type SettlementVerdict,
  type WorktreeKeptReason,
  type WorktreeOutcome,
  type WorktreeRemovalMechanism,
  type WorktreeTarget,
} from "./cleanup-policy.js";

export type { CleanupDeps } from "./agent-assets.js";

const log = createLogger("cleanup");

/** The agent-tracking surface cleanup needs — injected by the caller. */
export interface AgentCleanupRegistry {
  getSpawn(id: string): AgentSpawn | undefined;
  /** Drop a terminal spawn from tracking (after its resources are gone). */
  dropSpawn(spawn: AgentSpawn): void;
}

/* ── Addresses ─────────────────────────────────────────────────────────── */

/** Actuator address: memory's ref refreshed from the multiplexer's live report; recovered runs rebuild it with `paneCreated` false; no pane address means no ref (git plane removes the checkout). `multiplexer` is the session's multiplexer, so the address a persisted spawn carries names the multiplexer that minted it. */
function hostRefFor(
  located: Located,
  multiplexer: AgentMultiplexer,
): AgentHostRef | undefined {
  const pane = located.pane;
  const workspaceId = pane?.workspaceId ?? located.worktree?.workspaceId;
  if (pane === null || workspaceId === undefined) return undefined;
  return {
    multiplexer,
    name: located.branch,
    paneId: pane.paneId,
    tabId: pane.tabId,
    workspaceId,
    paneCreated: located.paneCreated,
  };
}

/* ── Removal ───────────────────────────────────────────────────────────── */

/** Remove the extension-owned worktree (failures reported, not hidden); a missing ref/workspace means never adopted, so the git fallback removes it. */
async function removeOwnedTree(
  deps: CleanupDeps,
  worktree: WorktreeTarget,
  ref?: AgentHostRef,
): Promise<Extract<WorktreeOutcome, { kind: "removed" | "removal-failed" }>> {
  const viaHost = ref !== undefined && worktree.workspaceId !== undefined;
  const removed = viaHost
    ? await deps.removeWorktree(ref)
    : await deps.removeGitWorktree(worktree.worktreePath, worktree.repoCwd);
  if (!removed) {
    return {
      kind: "removal-failed",
      path: worktree.worktreePath,
      detail: viaHost
        ? "herdr did not confirm the worktree removal"
        : "git did not confirm the worktree removal",
    };
  }
  return { kind: "removed", path: worktree.worktreePath };
}

/**
 * Pane outcomes for a removal, one per pane known to the environment: a removed
 * tree takes its workspace's panes with it; a pane in another workspace (such as
 * an earlier run's pane left behind by a handover) survives and is closed only if
 * the extension created it; a surviving tree keeps every pane it hosts.
 */
async function paneOutcomes(
  deps: CleanupDeps,
  panes: readonly AgentHostRef[],
  removal:
    | { readonly kind: "retained" }
    | {
        readonly kind: "removed";
        readonly mechanism: WorktreeRemovalMechanism | null;
        readonly workspaceId: string | undefined;
      },
): Promise<readonly PaneOutcome[]> {
  const outcomes: PaneOutcome[] = [];
  for (const pane of panes) {
    const disposition = paneDispositionFor(pane, removal);
    switch (disposition.kind) {
      case "closed-with-workspace":
        outcomes.push({ kind: "closed", paneId: pane.paneId });
        break;
      case "close":
        await deps.closePane(pane);
        outcomes.push({ kind: "closed", paneId: pane.paneId });
        break;
      case "leave-open":
        outcomes.push({ kind: "open", paneId: pane.paneId });
        break;
    }
  }
  return outcomes;
}

/**
 * Pane outcomes for a checkout proven absent: the settlement verdict never
 * reads a pane on the tracked path, so read each here and state only what was
 * observed. A live pane stays open; a gone address is reported gone (never
 * closed — the extension did not close it); an unreadable pane is reported
 * unknown (never evidence either way, and the drop does not rest on it).
 */
async function paneOutcomesForAbsentTree(
  assets: AgentAssets,
  panes: readonly AgentHostRef[],
): Promise<readonly PaneOutcome[]> {
  const outcomes: PaneOutcome[] = [];
  for (const pane of panes) {
    let observation: HostObservation | undefined;
    try {
      observation = await assets.observe(pane);
    } catch {
      outcomes.push({ kind: "unknown", paneId: pane.paneId });
      continue;
    }
    outcomes.push(
      observation === undefined
        ? { kind: "gone", paneId: pane.paneId }
        : { kind: "open", paneId: pane.paneId },
    );
  }
  return outcomes;
}

async function removeResources(
  deps: CleanupDeps,
  plan: RemovablePlan,
  address: AgentHostRef | undefined,
): Promise<RemovalOutcomes> {
  if (plan.kind === "no-worktree") {
    return {
      panes: await paneOutcomes(deps, plan.panes, {
        kind: "removed",
        mechanism: null,
        workspaceId: undefined,
      }),
      worktree: { kind: "none" },
      branch: { kind: "not-applicable" },
    };
  }
  const { worktree, panes } = plan;
  const outcome = await removeOwnedTree(deps, worktree, address);
  if (outcome.kind === "removed") {
    return {
      panes: await paneOutcomes(deps, panes, {
        kind: "removed",
        mechanism: removalMechanismOf(worktree),
        workspaceId: worktree.workspaceId,
      }),
      worktree: outcome,
      branch: await deps.deleteBranch({
        branch: worktree.branchName,
        worktreePath: worktree.worktreePath,
        repoCwd: worktree.repoCwd,
      }),
    };
  }
  return {
    panes: await paneOutcomes(deps, panes, { kind: "retained" }),
    worktree: outcome,
    branch: { kind: "not-applicable" },
  };
}

/* ── Shared worktree teardown ──────────────────────────────────────────── */

export type WorktreeTeardownOutcome =
  | {
      kind: "removed";
      path: string;
      branchName: string;
      via: WorktreeRemovalMechanism;
      branch: BranchCleanupResult;
    }
  | { kind: "kept"; path: string; reason: WorktreeRetentionReason }
  | { kind: "absent"; path?: string }
  | { kind: "removal-failed"; path: string; detail: string };

/**
 * Removal target: the tree, the address through which it is removed, and every pane
 * known to the environment (current first). The address is the current
 * placement's — a removal releases that workspace, and an ended run's pane may
 * sit in another one — while each pane carries its own address, so closing a pane
 * never depends on callers having to pair them up.
 */
export interface WorktreeRemovalTarget {
  readonly worktree: WorktreeTarget;
  /** The placement whose workspace the removal releases; absent removes through git. */
  readonly address: AgentHostRef | undefined;
  readonly panes: readonly AgentHostRef[];
}

/** The state-changing teardown plane: worktree, then branch, then pane. */
interface WorktreeTeardown {
  /** Tear down one worktree; a detached target runs only the git fallback; never stops an agent. */
  removeWorktree(
    target: WorktreeRemovalTarget,
    opts?: CleanupOptions,
  ): Promise<WorktreeTeardownOutcome>;
}

interface Cleanup extends WorktreeTeardown {
  /** Tear down one settled (or recovered) run's artifacts, then report. */
  cleanupAgent(
    agentId: string,
    registry: AgentCleanupRegistry,
    opts?: CleanupOptions,
  ): Promise<CleanupReport>;
}

/** Bind the teardown plane over its actuators; an absent tree reports before any gate or removal runs. */
export function createWorktreeTeardown(deps: CleanupDeps): WorktreeTeardown {
  return {
    async removeWorktree(
      target: WorktreeRemovalTarget,
      opts?: CleanupOptions,
    ): Promise<WorktreeTeardownOutcome> {
      const { worktree, panes, address } = target;
      try {
        // Applies to multiplexer and git targets alike: a rolled-back create has neither checkout nor workspace.
        if (!(await deps.worktreeExists(worktree.worktreePath))) {
          return { kind: "absent", path: worktree.worktreePath };
        }

        const before = await assessRemovability(
          deps.isWorktreeDirty,
          opts,
          worktree,
        );
        if (before.kind === "kept") {
          return {
            kind: "kept",
            path: worktree.worktreePath,
            reason: before.reason,
          };
        }

        const outcome = await removeOwnedTree(deps, worktree, address);
        if (outcome.kind === "removal-failed") return outcome;
        const mechanism = removalMechanismOf(worktree);
        // Panes close before branch cleanup so a git-owned pane only closes after confirmed checkout removal.
        await paneOutcomes(deps, panes, {
          kind: "removed",
          mechanism,
          workspaceId: worktree.workspaceId,
        });
        const branch = await deps.deleteBranch({
          branch: worktree.branchName,
          worktreePath: worktree.worktreePath,
          repoCwd: worktree.repoCwd,
        });
        return {
          kind: "removed",
          path: worktree.worktreePath,
          branchName: worktree.branchName,
          via: mechanism,
          branch,
        };
      } catch (err: unknown) {
        return {
          kind: "removal-failed",
          path: worktree.worktreePath,
          detail: errorMessage(err),
        };
      }
    },
  };
}

/* ── The environment ───────────────────────────────────────────────────── */

/**
 * Every pane known to the environment, current first: the located pane (a live
 * read, which may correct a stale record), followed by the panes that earlier
 * runs engaged. Each address appears only once — a handover may reuse a pane,
 * but it remains a single pane.
 */
function environmentPanes(
  current: AgentHostRef | undefined,
  hint: AgentSpawn | undefined,
): readonly AgentHostRef[] {
  const panes: AgentHostRef[] = current === undefined ? [] : [current];
  for (const run of hint === undefined ? [] : hint.execution.history) {
    if (panes.some((known) => known.paneId === run.host.paneId)) continue;
    panes.push(run.host);
  }
  return panes;
}

/**
 * The runs whose harness state cleanup must undo, oldest first: every ended run at the
 * pane and tree it prepared, followed by the active run at the address cleanup
 * located — the live read is fresher than the record, and that tree is the one
 * the dirty probe is about to read.
 */
function teardownRuns(
  hint: AgentSpawn | undefined,
  located: Located,
): readonly RunTeardown[] {
  if (hint === undefined) return [];
  const ended = hint.execution.history.map((run) => ({
    harness: run.harness,
    paneId: run.host.paneId,
    cwd: run.cwd,
  }));
  const active =
    hint.execution.harness === undefined
      ? []
      : [
          {
            harness: hint.execution.harness,
            paneId: located.pane?.paneId ?? null,
            cwd: located.worktree?.path ?? null,
          },
        ];
  return [...ended, ...active];
}

/* ── The cleanup plane ─────────────────────────────────────────────────── */

/** Settlement gate conclusion, plus the outcome the report will carry; refusals name why nothing was touched. */
type CleanupVerdict =
  | { kind: "torn-down"; settlement: SettlementVerdict }
  | {
      kind: "refused";
      settlement: SettlementVerdict;
      reason: WorktreeKeptReason;
      /** Whether the operator override can change this refusal (see keptReport). */
      forceable: boolean;
    };

/** Bind state-changing cleanup over the assets seam (the composition all callers use). */
export function createCleanup(assets: AgentAssets): Cleanup {
  const teardown = createWorktreeTeardown(assets);

  /** Recovered-path verdict carrying the unread deliverable. */
  function recovered(
    agentId: string,
    basis: DiscoveryBasis,
  ): SettlementVerdict {
    return {
      kind: "discovered",
      basis,
      deliverable: assets.deliverable(agentId),
    };
  }

  async function verdictFor(
    agentId: string,
    located: Located,
    hint: AgentSpawn | undefined,
    opts?: CleanupOptions,
  ): Promise<CleanupVerdict> {
    // Memory is the only settlement witness; a live run is refused outright (no probe, no stop).
    if (hint !== undefined) {
      const settlement = recordedSettlement(hint);
      return hasOutcome(hint.lifecycle)
        ? { kind: "torn-down", settlement }
        : {
            kind: "refused",
            settlement,
            reason: { kind: "agent-active", phase: hint.lifecycle.phase },
            // Force never stops a run — see stop_cowboy_agent.
            forceable: false,
          };
    }

    // No recorded end: force overrides without reading; otherwise the multiplexer's live read decides (unreadable refuses — never evidence the run is over).
    if (opts?.force !== undefined) {
      return {
        kind: "torn-down",
        settlement: recovered(agentId, { kind: "forced" }),
      };
    }
    let observation: HostObservation | undefined;
    if (located.pane !== null) {
      try {
        observation = await assets.observe(located.pane);
      } catch (err: unknown) {
        const basis: DiscoveryBasis = {
          kind: "pane-unreadable",
          detail: errorMessage(err),
        };
        return {
          kind: "refused",
          settlement: recovered(agentId, basis),
          reason: recoveryRefusalReason(basis),
          // Force overrides the read it could not make; the refusal is bypassable.
          forceable: true,
        };
      }
    }
    const gate = recoveryGate(observation);
    return gate.kind === "allow"
      ? { kind: "torn-down", settlement: recovered(agentId, gate.basis) }
      : {
          kind: "refused",
          settlement: recovered(agentId, gate.basis),
          reason: recoveryRefusalReason(gate.basis),
          // A pane still reporting `working` is exactly what force exists to override.
          forceable: true,
        };
  }

  /** Clean up one ended run end-to-end (best effort); a refusal removes nothing — no tree, branch, pane, or stop. */
  async function cleanupAgent(
    agentId: string,
    registry: AgentCleanupRegistry,
    opts?: CleanupOptions,
  ): Promise<CleanupReport> {
    const hint = registry.getSpawn(agentId);
    const located = await assets.locate(agentId, hint);
    if (located.kind === "not-found") {
      throw new Error(`Agent ${agentId} not found.`);
    }
    if (located.kind === "ambiguous") {
      // Contested id: cleanup arbitrates nothing, the orchestrator decides by hand.
      return ambiguousReport(
        agentId,
        hint === undefined ? "recovered" : "tracked",
        hint === undefined
          ? recovered(agentId, { kind: "artifacts-ambiguous" })
          : recordedSettlement(hint),
        located.candidates.map((candidate) => candidate.worktreePath),
      );
    }

    const current = hostRefFor(located, assets.multiplexer);
    const plan = planRecovered(located, environmentPanes(current, hint));
    const verdict = await verdictFor(agentId, located, hint, opts);
    if (verdict.kind === "refused") {
      return keptReport(agentId, located.source, plan, verdict.settlement, {
        reason: verdict.reason,
        forceable: verdict.forceable,
      });
    }

    // Ordered before the dirty probe — see Harness.teardown. Every run the
    // environment engaged is undone, not only the active one: a handover's
    // outgoing harness left its own pane state behind.
    const runs = teardownRuns(hint, located);
    if (runs.length > 0) {
      try {
        await assets.teardownEnvironment({ subagentId: agentId, runs });
      } catch (err: unknown) {
        // The seam isolates each run's failure; this guards against faults in
        // teardown itself so cleanup still reaches the worktree.
        log.warn("environment teardown failed during cleanup", {
          spawnId: agentId,
          error: errorMessage(err),
        });
      }
    }

    if (plan.kind === "worktree-unlocatable") {
      // An unlocatable tree whose path is absent from disk is already gone:
      // absence is established from the path alone (no repo cwd can address
      // a removal or a dirty probe at a directory that is not there), and
      // the branch stays — only a confirmed checkout removal earns a delete.
      if (
        plan.worktreePath !== null &&
        !(await assets.worktreeExists(plan.worktreePath))
      ) {
        const report: CleanupReport = {
          agentId,
          source: located.source,
          // Even this hand-built report carries the marker: a forced pass that
          // lands here must not read as a routine "already gone".
          outcome: { kind: "torn-down", ...forcedFields(opts) },
          branchName: plan.branchName,
          settlement: verdict.settlement,
          panes: await paneOutcomesForAbsentTree(assets, plan.panes),
          worktree: { kind: "absent", path: plan.worktreePath },
          branch: { kind: "not-applicable" },
        };
        // A recovered run has no record to forget; drop only tracked spawns.
        if (shouldDropSpawn(report) && hint !== undefined)
          registry.dropSpawn(hint);
        return report;
      }
      return keptReport(agentId, located.source, plan, verdict.settlement, {
        reason: {
          kind: "unverifiable",
          detail: "missing worktree path or repo cwd",
        },
        // Force cannot address a removal with no repo cwd — not bypassable.
        forceable: false,
      });
    }

    if (plan.kind === "worktree") {
      const gate = await assessRemovability(
        assets.isWorktreeDirty,
        opts,
        plan.worktree,
      );
      if (gate.kind === "kept") {
        return keptReport(agentId, located.source, plan, verdict.settlement, {
          reason: gate.reason,
          // The dirty/unverifiable probe is exactly what force skips.
          forceable: true,
        });
      }
    }

    const removal = await removeResources(assets, plan, current);
    const report = assembleReport(
      agentId,
      located.source,
      plan,
      verdict.settlement,
      removal,
      opts,
    );
    // A recovered run has no record to forget; drop only tracked spawns.
    if (shouldDropSpawn(report) && hint !== undefined) registry.dropSpawn(hint);
    return report;
  }

  return { ...teardown, cleanupAgent };
}

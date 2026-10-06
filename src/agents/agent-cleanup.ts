/**
 * agent-cleanup.ts — state-changing cleanup orchestration (policy lives in cleanup-policy.ts).
 * createWorktreeTeardown: worktree/branch/pane removal over injected actuators.
 * createCleanup: settled-or-recovered run cleanup over the assets seam.
 * WorktreeTeardown/Cleanup: the two planes. WorktreeTeardownOutcome: removal result.
 * WorktreeRemovalTarget: the address a teardown removes through.
 * AgentCleanupRegistry: spawn lookup/drop surface.
 * Report-gated (only ended runs are cleaned up; live runs are refused, never stopped);
 * ordered: gate before removal, workspace before pane, branch only after confirmed checkout removal.
 */

import type { AgentSpawn, WorktreeRetentionReason } from "../types.js";
import { hasOutcome } from "../types.js";
import type { BranchCleanupResult } from "../infrastructure/git-client.js";
import { errorMessage } from "../utils.js";
import type { AgentHostRef, HostObservation } from "./agent-host.js";
import type { AgentAssets, CleanupDeps, Located } from "./agent-assets.js";
import {
  ambiguousReport,
  assembleReport,
  assessRemovability,
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
  type LocatedPane,
  type PaneOutcome,
  type PaneTarget,
  type RemovablePlan,
  type RemovalOutcomes,
  type SettlementVerdict,
  type WorktreeKeptReason,
  type WorktreeOutcome,
  type WorktreeRemovalMechanism,
  type WorktreeTarget,
} from "./cleanup-policy.js";

export type { CleanupDeps } from "./agent-assets.js";

/** The agent-tracking surface cleanup needs — injected by the caller. */
export interface AgentCleanupRegistry {
  getSpawn(id: string): AgentSpawn | undefined;
  /** Drop a terminal spawn from tracking (after its resources are gone). */
  dropSpawn(spawn: AgentSpawn): void;
}

/* ── Addresses ─────────────────────────────────────────────────────────── */

/** Actuator address: memory's ref refreshed from herdr's live report; recovered runs rebuild it with `paneCreated` false; no pane address means no ref (git plane removes the checkout). */
function hostRefFor(located: Located): AgentHostRef | undefined {
  const pane = located.pane;
  const workspaceId = pane?.workspaceId ?? located.worktree?.workspaceId;
  if (pane === null || workspaceId === undefined) return undefined;
  return {
    engine: "herdr",
    name: located.branch,
    paneId: pane.paneId,
    tabId: pane.tabId,
    workspaceId,
    paneCreated: located.paneCreated,
  };
}

/* ── Removal ───────────────────────────────────────────────────────────── */

/** Close a self-created pane; a missing ref is incoherent (same address implies both), so it throws. */
async function closeOwnedPane(
  deps: CleanupDeps,
  pane: PaneTarget,
  ref?: AgentHostRef,
): Promise<PaneOutcome> {
  if (!ref)
    throw new Error(`cleanup has a pane (${pane.paneId}) with no host address`);
  await deps.closePane(ref);
  return { kind: "closed", paneId: pane.paneId };
}

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

/** Pane outcome for a removal: a removed tree takes its pane with it; a surviving tree still hosts its pane, which is never ours to close. */
async function paneOutcomeFor(
  deps: CleanupDeps,
  pane: PaneTarget | null,
  mechanism: WorktreeRemovalMechanism | null,
  removed: boolean,
  ref?: AgentHostRef,
): Promise<PaneOutcome> {
  if (pane === null) return { kind: "none" };
  const disposition = paneDispositionFor(pane, mechanism, removed);
  switch (disposition.kind) {
    case "none":
      return { kind: "none" };
    case "closed-with-workspace":
      return { kind: "closed", paneId: pane.paneId };
    case "close":
      return closeOwnedPane(deps, pane, ref);
    case "leave-open":
      return { kind: "open", paneId: pane.paneId };
  }
}

/**
 * Pane outcome for a checkout proven absent: the settlement verdict never
 * reads the pane on the tracked path, so read it here and state only what
 * was observed. A live pane stays open; a gone address is reported gone
 * (never closed — the extension did not close it); an unreadable pane is
 * reported unknown (never evidence either way, and the drop does not rest
 * on it). No pane address means none.
 */
async function paneOutcomeForAbsentTree(
  assets: AgentAssets,
  pane: LocatedPane | null,
): Promise<PaneOutcome> {
  if (pane === null) return { kind: "none" };
  let observation: HostObservation | undefined;
  try {
    observation = await assets.observe(pane);
  } catch {
    return { kind: "unknown", paneId: pane.paneId };
  }
  return observation === undefined
    ? { kind: "gone", paneId: pane.paneId }
    : { kind: "open", paneId: pane.paneId };
}

async function removeResources(
  deps: CleanupDeps,
  plan: RemovablePlan,
  ref?: AgentHostRef,
): Promise<RemovalOutcomes> {
  if (plan.kind === "no-worktree") {
    return {
      pane: await paneOutcomeFor(deps, plan.pane, null, true, ref),
      worktree: { kind: "none" },
      branch: { kind: "not-applicable" },
    };
  }
  const { worktree, pane } = plan;
  const outcome = await removeOwnedTree(deps, worktree, ref);
  if (outcome.kind === "removed") {
    return {
      pane: await paneOutcomeFor(
        deps,
        pane,
        removalMechanismOf(worktree),
        true,
        ref,
      ),
      worktree: outcome,
      branch: await deps.deleteBranch(worktree.worktreePath, worktree.repoCwd),
    };
  }
  return {
    pane: await paneOutcomeFor(
      deps,
      pane,
      removalMechanismOf(worktree),
      false,
      ref,
    ),
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

/** A checkout herdr adopted: removal rides the host address. */
export type AdoptedWorktreeTarget = WorktreeTarget & { workspaceId: string };

/** A pane the extension created: the only pane cleanup may close. */
type SelfCreatedPaneTarget = PaneTarget & { origin: "self-created" };

/**
 * Removal target: each legal case carries exactly the address it uses. A
 * host-adopted tree removes through its ref; a git-only tree closes a
 * self-created pane through its ref; a detached tree removes through git
 * and carries no ref.
 */
export type WorktreeRemovalTarget =
  | {
      kind: "adopted";
      worktree: AdoptedWorktreeTarget;
      pane: PaneTarget | null;
      ref: AgentHostRef;
    }
  | {
      kind: "closing-pane";
      worktree: WorktreeTarget;
      pane: SelfCreatedPaneTarget;
      ref: AgentHostRef;
    }
  | { kind: "detached"; worktree: WorktreeTarget; pane: PaneTarget | null };

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
      const worktree = target.worktree;
      const pane = target.pane;
      const ref = target.kind === "detached" ? undefined : target.ref;
      try {
        // Applies to herdr and git targets alike: a rolled-back create has neither checkout nor workspace.
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

        const outcome = await removeOwnedTree(deps, worktree, ref);
        if (outcome.kind === "removal-failed") return outcome;
        const mechanism = removalMechanismOf(worktree);
        // Pane closes before branch cleanup so a git-owned pane only closes after confirmed checkout removal.
        await paneOutcomeFor(deps, pane, mechanism, true, ref);
        const branch = await deps.deleteBranch(
          worktree.worktreePath,
          worktree.repoCwd,
        );
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

/* ── The cleanup plane ─────────────────────────────────────────────────── */

/** Settlement gate conclusion, plus the outcome the report will carry; refusals name why nothing was touched. */
type CleanupVerdict =
  | { kind: "torn-down"; settlement: SettlementVerdict }
  | {
      kind: "refused";
      settlement: SettlementVerdict;
      reason: WorktreeKeptReason;
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
          };
    }

    // No recorded end: force overrides without reading; otherwise herdr's live read decides (unreadable refuses — never evidence the run is over).
    if (opts?.force === true) {
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

    const plan = planRecovered(located);
    const verdict = await verdictFor(agentId, located, hint, opts);
    if (verdict.kind === "refused") {
      return keptReport(
        agentId,
        located.source,
        plan,
        verdict.settlement,
        verdict.reason,
        "open",
      );
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
          outcome: { kind: "torn-down" },
          branchName: plan.branchName,
          settlement: verdict.settlement,
          pane: await paneOutcomeForAbsentTree(assets, located.pane),
          worktree: { kind: "absent", path: plan.worktreePath },
          branch: { kind: "not-applicable" },
        };
        // A recovered run has no record to forget; drop only tracked spawns.
        if (shouldDropSpawn(report) && hint !== undefined)
          registry.dropSpawn(hint);
        return report;
      }
      return keptReport(
        agentId,
        located.source,
        plan,
        verdict.settlement,
        {
          kind: "unverifiable",
          detail: "missing worktree path or repo cwd",
        },
        "open",
      );
    }

    if (plan.kind === "worktree") {
      const gate = await assessRemovability(
        assets.isWorktreeDirty,
        opts,
        plan.worktree,
      );
      if (gate.kind === "kept") {
        return keptReport(
          agentId,
          located.source,
          plan,
          verdict.settlement,
          gate.reason,
          "open",
        );
      }
    }

    const removal = await removeResources(assets, plan, hostRefFor(located));
    const report = assembleReport(
      agentId,
      located.source,
      plan,
      verdict.settlement,
      removal,
    );
    // A recovered run has no record to forget; drop only tracked spawns.
    if (shouldDropSpawn(report) && hint !== undefined) registry.dropSpawn(hint);
    return report;
  }

  return { ...teardown, cleanupAgent };
}

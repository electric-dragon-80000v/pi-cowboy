/**
 * cleanup-policy.ts — pure cleanup decisions (no I/O).
 * Located artifacts: LocatedWorktree/LocatedPane/LocatedArtifacts.
 * Plan: CleanupPlan/planRecovered. Gate: GateOutcome/assessRemovability.
 * Settlement: SettlementVerdict/recordedSettlement/recoveryGate/recoveryRefusalReason.
 * Report: CleanupReport/keptReport/ambiguousReport/assembleReport/forcedFields/isForceableRefusal/shouldDropSpawn.
 * Removal: RemovalOutcomes/RemovablePlan/WorktreeRemovalMechanism/PaneDisposition/removalMechanismOf/paneDispositionFor.
 * Probes: WorktreeDirtyProbe. Options: CleanupOptions. Source: CleanupSource. Basis: DiscoveryBasis.
 */

import type {
  ActivePhase,
  AgentPhase,
  AgentSpawn,
  WorktreeRetentionReason,
} from "../types.js";
import type { BranchCleanupResult } from "../infrastructure/git-client.js";
import { assertNever } from "../utils.js";
import type { AgentHostRef, HostObservation } from "./agent-host.js";
/** Refusal for a live run: cleanup never stops an agent (a stale registry entry is not evidence work is over; see stop_cowboy_agent). */
type AgentActiveReason = {
  kind: "agent-active";
  phase: ActivePhase;
};

/** Refusal for a recovered run: pane still `working`, or unreadable (never evidence the run is over); basis says which. */
type RecoveredRefusalReason = {
  kind: "recovered-refusal";
  basis: DiscoveryBasis;
};

/** Refusal for a contested id: cleanup picks neither artifact, the report lists both. */
type AmbiguousArtifactsReason = {
  kind: "ambiguous-artifacts";
  candidates: readonly string[];
};

/** Why a worktree was kept instead of removed. */
export type WorktreeKeptReason =
  | WorktreeRetentionReason
  | AgentActiveReason
  | RecoveredRefusalReason
  | AmbiguousArtifactsReason;

/* ── Report shape ──────────────────────────────────────────────────────── */

/** Artifact provenance: `tracked` (spawn record named them) or `recovered` (discovery found them). */
export type CleanupSource = "tracked" | "recovered";

/** What the multiplexer's live read showed for a recovered run (`forced` is the operator override). */
export type DiscoveryBasis =
  | { kind: "pane-absent" }
  | { kind: "pane-not-working"; state: HostObservation["state"] }
  | { kind: "forced" }
  | { kind: "pane-working" }
  | { kind: "pane-unreadable"; detail: string }
  | { kind: "artifacts-ambiguous" };

/** Recovered run's deliverable; reported, never deleted (nobody has read it). */
export interface RecoveredDeliverable {
  path: string;
  /** Whether a deliverable was actually written (an agent may have died first). */
  present: boolean;
}

/** The tracked-path verdict: memory's recorded lifecycle phase is the answer. */
interface RecordedSettlement {
  kind: "recorded";
  phase: AgentPhase;
}

/** Recovered-path verdict: the multiplexer's live read plus the unread deliverable. */
interface DiscoveredSettlement {
  kind: "discovered";
  basis: DiscoveryBasis;
  deliverable: RecoveredDeliverable;
}

/** How cleanup established the run is over: `recorded` (memory is the only settlement witness) or `discovered` (the multiplexer's live read + unread deliverable). */
export type SettlementVerdict = RecordedSettlement | DiscoveredSettlement;

export function recordedSettlement(spawn: AgentSpawn): RecordedSettlement {
  return { kind: "recorded", phase: spawn.lifecycle.phase };
}

/**
 * What cleanup reports for one pane the environment knew. `open` is a pane
 * cleanup left standing — one the seam observed live, or one nothing touched
 * because the run was refused; `gone` is stated only for an address the
 * multiplexer no longer answers (never `closed`: the extension did not close
 * it); `unknown` is stated only when the read itself failed (never evidence
 * either way).
 */
export type PaneOutcome =
  | { kind: "closed"; paneId: string }
  | { kind: "open"; paneId: string }
  | { kind: "gone"; paneId: string }
  | { kind: "unknown"; paneId: string };

export type WorktreeOutcome =
  | { kind: "removed"; path: string }
  | { kind: "removal-failed"; path: string; detail: string }
  /** `path` null when the run never recorded one; the reason to keep it rides the report's verdict. */
  | { kind: "kept"; path: string | null }
  | { kind: "absent"; path: string }
  | { kind: "none" };

/** The override a forced teardown carries: the refusal it bypassed (menu-only; the tool never forces). */
export type ForcedOverride = { reason?: WorktreeKeptReason };

/**
 * What cleanup did with the run as a whole: tore down its artifacts, or refused
 * to touch them and says why. Only a teardown can carry `forced`; only a refusal
 * carries `forceable` — whether the operator override (`CleanupOptions.force`)
 * can change the answer. The menu offers Force only for a forceable refusal;
 * every other refusal is final.
 */
export type CleanupVerdictOutcome =
  | { kind: "torn-down"; forced?: ForcedOverride }
  | { kind: "refused"; reason: WorktreeKeptReason; forceable: boolean };

/** Structured cleanup result for the orchestrator (not prose); report-gated and best effort — unsettled runs are refused, the rest reports what it could not remove. */
export interface CleanupReport {
  agentId: string;
  /** Where the plan's artifacts came from (see CleanupSource). */
  source: CleanupSource;
  /** The verdict itself: a refusal always names its reason, whether or not a worktree was at stake. */
  outcome: CleanupVerdictOutcome;
  /** The run's established end-state; cleanup never changes run state, only tears down ended runs. */
  settlement: SettlementVerdict;
  /** Every pane the environment knew, after cleanup; empty = it never had one. */
  panes: readonly PaneOutcome[];
  /** The extension-owned worktree after cleanup (none = never created one; absent = already gone from disk). */
  worktree: WorktreeOutcome;
  /** What happened to the agent's branch. */
  branch: BranchCleanupResult;
  /** Branch ref; invariant: present iff the worktree existed (pinned at worktree-create time). */
  branchName?: string;
}

export interface CleanupOptions {
  /** Skip the removability gate: remove the worktree even when dirty/unverifiable. `reason` is the refusal this override bypassed. */
  force?: ForcedOverride;
}

/* ── Located artifacts (plain data) ───────────────────────────────────── */

/** Checkout for one agent id. `repoCwd` derives from the checkout itself — a wrong-repo cwd would delete a same-named branch elsewhere; absent means unresolvable (a refusal, not a fallback). */
interface LocatedWorktree {
  path: string;
  repoCwd?: string;
  workspaceId?: string;
}

/** Pane addressing a run: a live placement record or memory's address. */
export interface LocatedPane {
  paneId: string;
  tabId?: string;
  workspaceId?: string;
}

/** Locator answer for one agent id. Provenance is memory-only; addresses are live probes, which may correct a stale record. */
export interface LocatedArtifacts {
  id: string;
  /** The run's branch (`cow-<slug>-<id>`), from memory or the discovered checkout. */
  branch: string;
  /** Provenance: the extension created this tree (memory, or the extension-worktree rule). */
  worktreeManaged: boolean;
  /** Provenance: the extension created this pane. Never claimed for a recovered run. */
  paneCreated: boolean;
  /** The checkout memory named or discovery found; null when nothing on disk answers. */
  worktree: LocatedWorktree | null;
  /** The pane addressing this run; null when nothing addresses one. */
  pane: LocatedPane | null;
}

/* ── Stage 1: plan (pure) ──────────────────────────────────────────────── */

export interface WorktreeTarget {
  /** Absent for a git-only checkout or a reconstructed spawn without a placement identity. */
  workspaceId?: string;
  worktreePath: string;
  repoCwd: string;
  branchName: string;
}

/**
 * What a run owns: no partial worktree state — an unresolved managed tree is
 * `worktree-unlocatable`, never `no-worktree`; `null` is genuine absence.
 * `panes` is every pane the environment knows, the current one first; only a
 * pane the extension created is ever closed.
 */
export type CleanupPlan =
  | {
      kind: "worktree";
      worktree: WorktreeTarget;
      panes: readonly AgentHostRef[];
    }
  | {
      kind: "worktree-unlocatable";
      branchName: string;
      /** null = no path was ever recorded or discovered for the worktree. */
      worktreePath: string | null;
      panes: readonly AgentHostRef[];
    }
  | { kind: "no-worktree"; panes: readonly AgentHostRef[] };

/** Narrow located artifacts into a plan (pure): resolved managed tree → worktree (missing workspace still goes via git); unresolved managed tree → worktree-unlocatable (never no-worktree, so nothing leaks). The panes are the caller's environment's, current first. */
export function planRecovered(
  artifacts: LocatedArtifacts,
  panes: readonly AgentHostRef[],
): CleanupPlan {
  const worktree = artifacts.worktree;
  if (worktree !== null && worktree.repoCwd !== undefined) {
    return {
      kind: "worktree",
      worktree: {
        workspaceId: worktree.workspaceId,
        worktreePath: worktree.path,
        repoCwd: worktree.repoCwd,
        branchName: artifacts.branch,
      },
      panes,
    };
  }
  if (artifacts.worktreeManaged) {
    return {
      kind: "worktree-unlocatable",
      branchName: artifacts.branch,
      worktreePath: worktree?.path ?? null,
      panes,
    };
  }
  return { kind: "no-worktree", panes };
}

/* ── Stage 2 + 3 gate: removability (the only way removing can lose work) ─ */

export type GateOutcome =
  { kind: "removable" } | { kind: "kept"; reason: WorktreeRetentionReason };

type WorktreeDirtyProbe = (
  worktreePath: string,
) => Promise<boolean | undefined>;

/** Removability gate: dirty/unverifiable blocks (the only way removal loses work); unmerged does not (the branch survives in the repo); force skips the probe. */
export async function assessRemovability(
  isDirty: WorktreeDirtyProbe,
  opts: CleanupOptions | undefined,
  worktree: WorktreeTarget,
): Promise<GateOutcome> {
  if (opts?.force !== undefined) return { kind: "removable" };
  const dirty = await isDirty(worktree.worktreePath);
  if (dirty === undefined) {
    return {
      kind: "kept",
      reason: { kind: "unverifiable", detail: "git status probe failed" },
    };
  }
  return dirty
    ? { kind: "kept", reason: { kind: "dirty" } }
    : { kind: "removable" };
}

/* ── Removal ───────────────────────────────────────────────────────────── */

export type RemovalOutcomes = {
  panes: readonly PaneOutcome[];
  worktree: WorktreeOutcome;
  branch: BranchCleanupResult;
};

/** The plan kinds that can actually be removed (unlocatable never reaches removal). */
export type RemovablePlan = Extract<
  CleanupPlan,
  { kind: "worktree" | "no-worktree" }
>;

/* ── Stage 4: the recovered-path settlement gate (pure) ───────────────── */

/**
 * Recovered-path settlement: tear down only when the multiplexer's read cannot show
 * live work (pane gone or non-working); `working` refuses. Unreadable reads
 * never reach here — the caller refuses on a throw. (Refusing anything but
 * gone panes would be a one-line change to the second branch.)
 */
export type RecoveryGate =
  | { kind: "allow"; basis: DiscoveryBasis }
  | { kind: "refuse"; basis: DiscoveryBasis };

export function recoveryGate(
  observation: HostObservation | undefined,
): RecoveryGate {
  if (observation === undefined) {
    return { kind: "allow", basis: { kind: "pane-absent" } };
  }
  switch (observation.state) {
    case "working":
      return { kind: "refuse", basis: { kind: "pane-working" } };
    case "idle":
    case "blocked":
    case "done":
    case "unknown":
      return {
        kind: "allow",
        basis: { kind: "pane-not-working", state: observation.state },
      };
    default:
      return assertNever(observation.state);
  }
}

export function recoveryRefusalReason(
  basis: DiscoveryBasis,
): WorktreeKeptReason {
  switch (basis.kind) {
    case "pane-working":
      return { kind: "recovered-refusal", basis };
    case "pane-unreadable":
      return {
        kind: "unverifiable",
        detail: `the pane state could not be read (${basis.detail})`,
      };
    case "pane-absent":
    case "pane-not-working":
    case "forced":
    case "artifacts-ambiguous":
      // The gate allows these bases and pre-gate ambiguity refuses before it,
      // so no caller passes one here; the generic detail is a safety net.
      return {
        kind: "unverifiable",
        detail: "the run's end could not be established",
      };
  }
}

/* ── Stage 5: report + record-keeping (pure) ───────────────────────────── */

/** Refusal report shared by all early returns; the reason rides the verdict, so it survives even with no worktree to name. `refusal.forceable` marks a refusal the operator override can change (see CleanupVerdictOutcome). A refusal closes nothing, so its pane is always reported open. */
export function keptReport(
  agentId: string,
  source: CleanupSource,
  plan: CleanupPlan,
  settlement: SettlementVerdict,
  refusal: { reason: WorktreeKeptReason; forceable: boolean },
): CleanupReport {
  const worktree: WorktreeOutcome =
    plan.kind === "worktree"
      ? { kind: "kept", path: plan.worktree.worktreePath }
      : plan.kind === "worktree-unlocatable"
        ? { kind: "kept", path: plan.worktreePath }
        : { kind: "none" };
  return {
    agentId,
    source,
    outcome: {
      kind: "refused",
      reason: refusal.reason,
      forceable: refusal.forceable,
    },
    branchName:
      plan.kind === "worktree"
        ? plan.worktree.branchName
        : plan.kind === "worktree-unlocatable"
          ? plan.branchName
          : undefined,
    settlement,
    // A refusal closes nothing, so every pane the environment knew is still open.
    panes: plan.panes.map((pane) => ({ kind: "open", paneId: pane.paneId })),
    worktree,
    branch: { kind: "not-applicable" },
  };
}

/** Contested-id report: cleanup removes nothing (not even the branch) and lists candidates for the orchestrator. */
export function ambiguousReport(
  agentId: string,
  source: CleanupSource,
  settlement: SettlementVerdict,
  candidates: readonly string[],
): CleanupReport {
  return {
    agentId,
    source,
    outcome: {
      kind: "refused",
      reason: { kind: "ambiguous-artifacts", candidates },
      forceable: false,
    },
    settlement,
    panes: [],
    worktree: { kind: "kept", path: null },
    branch: { kind: "not-applicable" },
  };
}

/**
 * The `forced` marker a teardown earned by overriding a removability gate, as a
 * fragment for its `torn-down` outcome (`{}` for a routine teardown). The tool
 * never forces, so only the menu sets it — and every teardown path spreads this,
 * so the marker is invariant.
 */
export function forcedFields(opts?: CleanupOptions): {
  forced?: ForcedOverride;
} {
  return opts?.force !== undefined ? { forced: opts.force } : {};
}

export function assembleReport(
  agentId: string,
  source: CleanupSource,
  plan: CleanupPlan,
  settlement: SettlementVerdict,
  removal: RemovalOutcomes,
  opts?: CleanupOptions,
): CleanupReport {
  return {
    agentId,
    source,
    // A forced teardown states it overrode a gate, so its report line cannot be
    // mistaken for a routine one (see forcedFields).
    outcome: { kind: "torn-down", ...forcedFields(opts) },
    branchName: plan.kind === "worktree" ? plan.worktree.branchName : undefined,
    settlement,
    panes: removal.panes,
    worktree: removal.worktree,
    branch: removal.branch,
  };
}

/** A report whose refusal the operator override can change — `isForceableRefusal` narrows to it. */
export type ForceableRefusedReport = CleanupReport & {
  outcome: { kind: "refused"; forceable: true };
};

/**
 * Whether the operator override can change a refusal's answer. The menu offers
 * Force only for these: a live run, a contested id, and a tree with no address
 * force can reach are final refusals, not candidates for a second attempt.
 */
export function isForceableRefusal(
  report: CleanupReport,
): report is ForceableRefusedReport {
  return report.outcome.kind === "refused" && report.outcome.forceable;
}

/**
 * Drop a spawn once its tracked resources are gone; a kept/failed tree
 * keeps its spawn so status still shows why. An absent tree drops too: a
 * checkout that is not on disk cannot be removed and holds no work, and the
 * branch is deliberately NOT deleted on that path (its commits live in the
 * object store), so nothing recordable is lost by forgetting the record.
 */
export function shouldDropSpawn(report: CleanupReport): boolean {
  if (report.worktree.kind === "removed") return true;
  if (report.worktree.kind === "absent") return true;
  if (report.worktree.kind === "none") {
    return report.panes.every((pane) => pane.kind === "closed");
  }
  return false;
}

export type WorktreeRemovalMechanism = "multiplexer" | "git";

type PaneDisposition =
  | { kind: "closed-with-workspace" }
  | { kind: "close" }
  | { kind: "leave-open" };

export function removalMechanismOf(
  worktree: WorktreeTarget,
): WorktreeRemovalMechanism {
  return worktree.workspaceId !== undefined ? "multiplexer" : "git";
}

/**
 * Whether removing the tree also takes this pane with it. A multiplexer
 * removal destroys the placements of the workspace it releases, so a pane in
 * that workspace goes with it — but a pane in another workspace (an earlier
 * run's, left behind by a handover) survives it and is handled by ownership
 * instead. An unrecorded workspace cannot be told apart from the removed one,
 * so it keeps the answer the removal implies. A pane the extension did not
 * create is never closed by cleanup, however its workspace fared.
 */
export function paneDispositionFor(
  pane: AgentHostRef,
  mechanism: WorktreeRemovalMechanism | null,
  removed: boolean,
  treeWorkspaceId: string | undefined,
): PaneDisposition {
  if (!removed) return { kind: "leave-open" };
  const inRemovedWorkspace =
    treeWorkspaceId === undefined || pane.workspaceId === treeWorkspaceId;
  if (mechanism === "multiplexer" && inRemovedWorkspace) {
    return { kind: "closed-with-workspace" };
  }
  // A git-side removal, or a plan with no tree at all, leaves the pane standing: only a pane the extension created may be closed.
  switch (mechanism) {
    case "multiplexer":
    case "git":
    case null:
      return pane.paneCreated ? { kind: "close" } : { kind: "leave-open" };
    default:
      return assertNever(mechanism);
  }
}

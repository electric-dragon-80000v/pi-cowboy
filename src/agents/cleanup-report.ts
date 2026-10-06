/**
 * cleanup-report.ts — a CleanupReport as prose: the summary the cleanup tool
 * returns and the one line the menus notify. Each artifact's wording is
 * written once here, so the tool's report and the menu's toast agree.
 */

import type { BranchCleanupResult } from "../infrastructure/git-client.js";
import type {
  CleanupReport,
  DiscoveryBasis,
  PaneOutcome,
  SettlementVerdict,
  WorktreeKeptReason,
  WorktreeOutcome,
} from "./cleanup-policy.js";

function formatBasis(basis: DiscoveryBasis): string {
  switch (basis.kind) {
    case "pane-absent":
      return "pane-absent";
    case "pane-not-working":
      return `pane-not-working: ${basis.state}`;
    case "forced":
      return "forced";
    case "pane-working":
      return "pane-working";
    case "pane-unreadable":
      return `pane-unreadable: ${basis.detail}`;
    case "artifacts-ambiguous":
      return "artifacts-ambiguous";
  }
}

/** A recovered run reports `unrecorded`, never an end nobody witnessed. */
function formatSettlement(settlement: SettlementVerdict): string {
  return settlement.kind === "recorded"
    ? settlement.phase
    : `unrecorded (basis: ${formatBasis(settlement.basis)})`;
}

function formatKeptReason(reason: WorktreeKeptReason): string {
  switch (reason.kind) {
    case "dirty":
      return "has uncommitted changes";
    case "unverifiable":
      return `state could not be verified (${reason.detail})`;
    case "agent-active":
      return `the agent is still ${reason.phase} and has not reported a result — stop it with stop_cowboy_agent, then clean up`;
    case "recovered-refusal":
      return `no settlement was recorded and herdr still reports the agent at work (${formatBasis(reason.basis)}) — stop it before retrying`;
    case "ambiguous-artifacts":
      return `two artifacts answer to this id (${reason.candidates.join(", ")}) — nothing was removed; work out which run owns the id before removing either by hand`;
  }
}

function paneText(pane: PaneOutcome): string {
  switch (pane.kind) {
    case "closed":
      return "closed";
    case "open":
      return "open";
    case "gone":
      return "gone (herdr has no such pane)";
    case "unknown":
      return "unknown (the pane was not read)";
    case "none":
      return "none";
  }
}

function worktreeText(worktree: WorktreeOutcome): string {
  switch (worktree.kind) {
    case "removed":
      return `removed (${worktree.path})`;
    case "removal-failed":
      return `NOT removed — ${worktree.detail} (${worktree.path})`;
    case "kept":
      return `kept${
        worktree.path ? ` (${worktree.path})` : " (worktree path not recorded)"
      }`;
    case "absent":
      return `already gone (${worktree.path})`;
    case "none":
      return "none (agent ran without a worktree)";
  }
}

function branchText(report: CleanupReport): string {
  const branch: BranchCleanupResult = report.branch;
  const text =
    branch.kind === "deleted"
      ? "deleted"
      : branch.kind === "kept"
        ? `kept (${branch.reason})`
        : branch.kind === "delete-failed"
          ? `NOT deleted — ${branch.detail}`
          : "not applicable";
  return `${text}${report.branchName ? ` (${report.branchName})` : ""}`;
}

/** The report's opening line: a refusal says it refused and why; a teardown says it finished. */
function headline(report: CleanupReport): string {
  return report.outcome.kind === "refused"
    ? `Did not clean up agent ${report.agentId}: ${formatKeptReason(
        report.outcome.reason,
      )}`
    : `Cleaned up agent ${report.agentId}:`;
}

/** The tool's report: what happened to the run, its pane, worktree and branch. */
export function renderCleanupReport(report: CleanupReport): string {
  const lines = [
    headline(report),
    `  agent status: ${formatSettlement(report.settlement)}`,
    `  pane: ${paneText(report.pane)}`,
    `  worktree: ${worktreeText(report.worktree)}`,
    `  branch: ${branchText(report)}`,
  ];
  if (report.source === "recovered") {
    lines.push(
      "  recovered: no spawn record survived — this verdict rests on discovery (herdr's live read plus the worktree on disk)",
    );
  }
  if (report.settlement.kind === "discovered") {
    const { path, present } = report.settlement.deliverable;
    lines.push(
      present
        ? `  deliverable: UNREAD at ${path} — read it before deleting the directory`
        : `  deliverable: none written (${path} does not exist)`,
    );
  }
  return lines.join("\n");
}

/** The same report as one notification-sized line. */
export function summarizeCleanupReport(report: CleanupReport): string {
  const pane =
    report.pane.kind === "closed"
      ? "pane closed"
      : report.pane.kind === "open"
        ? "pane left open"
        : report.pane.kind === "gone"
          ? "pane already gone"
          : report.pane.kind === "unknown"
            ? "pane state unknown"
            : "no pane";
  return report.outcome.kind === "refused"
    ? `${headline(report)} ${pane}`
    : `${headline(report)} ${pane}, worktree ${worktreeText(
        report.worktree,
      )}, branch ${branchText(report)}`;
}

/** Whether the teardown left something behind that only the operator can settle. */
export function cleanupNeedsAttention(report: CleanupReport): boolean {
  return (
    report.outcome.kind === "refused" ||
    report.worktree.kind === "kept" ||
    report.worktree.kind === "removal-failed" ||
    report.branch.kind === "delete-failed"
  );
}

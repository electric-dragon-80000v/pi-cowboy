/**
 * cleanup-report.ts — a CleanupReport as prose: the summary the cleanup tool
 * returns and the one line the menus notify. Each artifact's wording is
 * written once here, so the tool's report and the menu's toast agree.
 */

import type { BranchCleanupResult } from "../infrastructure/git-client.js";
import type {
  CleanupReport,
  DiscoveryBasis,
  ForcedOverride,
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

/** The refusal wording, shared by the report and the menu's force dialog. */
export function formatKeptReason(reason: WorktreeKeptReason): string {
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
  }
}

/** Every pane's outcome on one line; an environment that never had one says so. */
function panesText(panes: readonly PaneOutcome[]): string {
  return panes.length === 0
    ? "none (the agent never had a pane)"
    : panes.map((pane) => `${pane.paneId} ${paneText(pane)}`).join(", ");
}

/** One pane phrase, for the notification-sized summary. */
function paneSummary(pane: PaneOutcome): string {
  switch (pane.kind) {
    case "closed":
      return "pane closed";
    case "open":
      return "pane left open";
    case "gone":
      return "pane already gone";
    case "unknown":
      return "pane state unknown";
  }
}

/** One line for every pane: a single pane reads as it always did; several are counted by outcome. */
function panesSummary(panes: readonly PaneOutcome[]): string {
  if (panes.length === 0) return "no pane";
  if (panes.length === 1) return paneSummary(panes[0]!);
  const counts = new Map<PaneOutcome["kind"], number>();
  for (const pane of panes)
    counts.set(pane.kind, (counts.get(pane.kind) ?? 0) + 1);
  const tally = [...counts]
    .map(([kind, count]) => `${count} ${kind}`)
    .join(", ");
  return `${panes.length} panes (${tally})`;
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

/** The forced clause a teardown earned by overriding a gate; empty otherwise. */
function forcedClause(forced: ForcedOverride | undefined): string {
  if (!forced) return "";
  return ` forced${forced.reason ? ` — ${formatKeptReason(forced.reason)}` : ""}`;
}

/** The report's opening line: a refusal says it refused and why; a teardown says it finished, and whether an operator override was in play. */
function headline(report: CleanupReport): string {
  return report.outcome.kind === "refused"
    ? `Did not clean up agent ${report.agentId}: ${formatKeptReason(
        report.outcome.reason,
      )}`
    : `Cleaned up agent ${report.agentId}${forcedClause(report.outcome.forced)}:`;
}

/** The tool's report: what happened to the run, its panes, worktree and branch. */
export function renderCleanupReport(report: CleanupReport): string {
  const lines = [
    headline(report),
    `  agent status: ${formatSettlement(report.settlement)}`,
    `  panes: ${panesText(report.panes)}`,
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
  const pane = panesSummary(report.panes);
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

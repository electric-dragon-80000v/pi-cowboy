/**
 * handover-export.ts — what an exported handover is: the artifact one run's
 * read produces, the reasons it produces none, and how each answer reads.
 *
 * The read, the loss policy and the task text belong to the handover's own
 * modules; this one names the artifact and the outcome of writing it to a file
 * instead of launching a run with it.
 */

import * as path from "node:path";
import type { AnyHarnessId, HarnessExportLoss } from "./harness.js";
import { handoverFileName, handoverFilePath } from "./handover-file.js";
import type { HandoverSourceFault } from "./handover.js";
import type { ToolSeverity } from "./tool-result.js";

/**
 * An export-only's result: the artifact the next harness would have been given.
 * Nothing was stopped or launched, so this is a description of a file, not of
 * a run.
 */
export interface HandoverExportArtifact {
  /** The absolute path the artifact is offered at; the writer may choose another. */
  readonly defaultPath: string;
  /** The exact artifact text: `renderHandoverTask`'s output. */
  readonly text: string;
  readonly sessionId: string;
  readonly loss?: HarnessExportLoss;
}

/**
 * Why an export-only did not happen: no readable source run, or a source run
 * that is being replaced by a handover and so has no settled session to read.
 */
export type HandoverExportFault =
  | HandoverSourceFault
  | { readonly kind: "handover-in-progress"; readonly detail: string };

/** What an export-only did: produced the artifact, or named why it could not. */
export type HandoverExportOutcome =
  | ({ readonly kind: "prepared" } & HandoverExportArtifact)
  | { readonly kind: "faulted"; readonly fault: HandoverExportFault };

/** A successful export: for whom it was read, and what it produced. */
export type PreparedHandoverExport = Extract<
  HandoverExportOutcome,
  { kind: "prepared" }
>;

/**
 * The name an export is filed under: the run's checkout directory, or the
 * parent-cwd fallback when it ran without a worktree. The directory name is
 * the worktree's own name — the same one herdr labels the workspace with, not
 * the branch checked out in it.
 */
export function exportWorktreeName(
  worktree: { readonly path: string } | undefined,
  agentId: string,
): string {
  return worktree === undefined
    ? `main-${agentId}`
    : path.basename(worktree.path);
}

/** Everything the artifact is named and written from. */
export interface HandoverExportRequest {
  /** The run's worktree name, or `main-<agent id>` when it ran without one. */
  readonly worktree: string;
  /** The harness that ran the session, which names it in the file name. */
  readonly harness: AnyHarnessId;
  readonly sessionId: string;
  /** The handover task text — what the next harness would have been given. */
  readonly text: string;
  readonly loss?: HarnessExportLoss;
}

/** The artifact one ready export describes: its text and the path it is offered at. */
export function handoverExportArtifact(
  request: HandoverExportRequest,
): PreparedHandoverExport {
  return {
    kind: "prepared",
    defaultPath: handoverFilePath(
      handoverFileName({
        worktree: request.worktree,
        harness: request.harness,
        sessionId: request.sessionId,
      }),
    ),
    text: request.text,
    sessionId: request.sessionId,
    ...(request.loss === undefined ? {} : { loss: request.loss }),
  };
}

/** Why an export produced nothing, phrased to read after the agent id. */
export function handoverExportFaultReason(fault: HandoverExportFault): string {
  switch (fault.kind) {
    case "agent-unknown":
      return "not found — check the id from its spawn or completion result.";
    case "agent-not-settled":
      return `is still ${fault.status} — its session cannot be read while the run is in that state. Nothing was changed.`;
    case "harness-cannot-export-session":
      return `was not exported: harness "${fault.harness}" cannot export its own session, so there is nothing to write.`;
    case "never-started":
      return "was not exported: it never started, so there is no session to export.";
    case "handover-in-progress":
      return `was not exported: ${fault.detail}`;
    case "session-empty":
      return `was not exported: harness "${fault.harness}" returned an empty session.`;
    case "session-export-failed":
      return `was not exported: harness "${fault.harness}" could not export its session (${fault.detail}).`;
  }
}

/**
 * How an export reads: an artifact written without loss is the success. A run
 * that was not exported because there was nothing to read, or because a
 * handover owns it, is a refusal; a harness that could not produce its session
 * is a failure.
 */
export function handoverExportSeverity(
  outcome: HandoverExportOutcome,
): ToolSeverity {
  if (outcome.kind === "prepared") {
    return outcome.loss === undefined ? "success" : "warning";
  }
  switch (outcome.fault.kind) {
    case "agent-unknown":
    case "agent-not-settled":
    case "harness-cannot-export-session":
    case "never-started":
    case "handover-in-progress":
      return "warning";
    case "session-empty":
    case "session-export-failed":
      return "error";
  }
}

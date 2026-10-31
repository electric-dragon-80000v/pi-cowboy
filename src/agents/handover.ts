/**
 * handover.ts — the vocabulary one spawn's handover speaks.
 *
 * A handover ends the run that holds an environment and launches the next one
 * under another harness, handing over the session the first one had. This
 * module holds what every layer shares: the outcome and its faults, the
 * severity a fault is reported at, the source run's session export, and the
 * task text the next run starts from. Nothing here touches a pane or a file —
 * the session performs the handover, and the tool reports it.
 *
 * A harness that cannot export its own session cannot be a source. That is a
 * capability gap, not a failure — nothing was stopped and nothing changed —
 * and the fault's own kind says so, so no separate severity exists.
 */

import { z } from "zod";
import type { AgentStatus } from "../types.js";
import type { HarnessRegistry } from "./harness/harness-registry.js";
import type { ToolSeverity } from "./tool-result.js";
import {
  canReadHandoverRecords,
  SessionExportError,
  type AnyHarnessId,
  type HandoverRecordSource,
  type HarnessExport,
  type HarnessExportLoss,
  type HarnessExportRequest,
  type SessionExportFault,
} from "./harness.js";

const HandoverSessionChainSchema = z
  .array(z.object({ harness: z.string(), sessionId: z.string() }))
  .nonempty();

/** The maximum share of complete native records a completed export may omit. */
export interface SessionExportPolicy {
  readonly maxExcludedRatio: number;
}

/** By default, up to half a session's complete native records may be lost before handover is refused. */
export const DEFAULT_MAX_EXCLUDED_RATIO = 0.5;

/**
 * Why a settled run has no session to carry forward: the answers a source read
 * can give, before anything is stopped, archived, or written.
 */
export type HandoverSourceFault =
  | { readonly kind: "agent-unknown" }
  /** A run still doing its own work has no finished session to hand over. */
  | { readonly kind: "agent-not-settled"; readonly status: AgentStatus }
  /** The source harness has no record reader — or is no longer registered. */
  | {
      readonly kind: "harness-cannot-export-session";
      readonly harness: AnyHarnessId;
    }
  /** A run that never started engaged no harness and no placement, so there is nothing to export. */
  | { readonly kind: "never-started" }
  | { readonly kind: "session-empty"; readonly harness: AnyHarnessId }
  | {
      readonly kind: "session-export-failed";
      readonly harness: AnyHarnessId;
      readonly detail: string;
      readonly exportFault?: SessionExportFault;
    };

/** Why a handover did not happen. Data, never a throw: a caller reports it. */
export type HandoverFault =
  | HandoverSourceFault
  /** The old process could not be stopped; the checkout is not handed over under it. */
  | { readonly kind: "stop-failed"; readonly detail: string }
  /** The request itself was refused before anything was touched (harness, model). */
  | { readonly kind: "request-refused"; readonly detail: string }
  | { readonly kind: "launch-failed"; readonly detail: string };

/** What a handover did: moved the run to another harness, or named why it did not. */
export type HandoverOutcome =
  | {
      readonly kind: "handed-over";
      readonly from: AnyHarnessId;
      readonly to: AnyHarnessId;
      /** Countable source records the shared export had to omit. */
      readonly loss?: HarnessExportLoss;
    }
  | { readonly kind: "faulted"; readonly fault: HandoverFault };

/**
 * The clause a handover or an export appends when the shared read had to omit
 * complete native records: the same count, worded once.
 */
export function handoverLossClause(loss: HarnessExportLoss): string {
  return ` ${loss.excluded} of ${loss.total} session records could not be read and were omitted from the transcript.`;
}

/**
 * How a handover outcome reads: a completed handover is the success. A run
 * that was not handed over because the request could not be served — an
 * unknown or live agent, a harness that cannot export, a request refused — is
 * a refusal; a run that could not be stopped, exported, or relaunched is a
 * failure.
 */
export function handoverSeverity(outcome: HandoverOutcome): ToolSeverity {
  if (outcome.kind === "handed-over") {
    return outcome.loss === undefined ? "success" : "warning";
  }
  switch (outcome.fault.kind) {
    case "agent-unknown":
    case "agent-not-settled":
    case "harness-cannot-export-session":
    case "never-started":
    case "request-refused":
      return "warning";
    case "stop-failed":
    case "session-empty":
    case "session-export-failed":
    case "launch-failed":
      return "error";
  }
}

/** One run's session as its harness exported it, or the fault that stopped it. */
export type RunSession =
  | {
      readonly kind: "exported";
      readonly sessionId: string;
      readonly session: string;
      /** Countable source records the shared export had to omit. */
      readonly loss?: HarnessExportLoss;
    }
  | { readonly kind: "faulted"; readonly fault: HandoverSourceFault };

/** The whole-number percentage the human-facing loss report prints. */
function percentOf(ratio: number): number {
  return Math.round(ratio * 100);
}

/** The detail a refusal gives when its record loss exceeds the policy. */
function lossDetail(
  loss: HarnessExportLoss,
  policy: SessionExportPolicy,
): string {
  const share = percentOf(loss.excluded / loss.total);
  return (
    `${loss.excluded} of ${loss.total} session records could not be read — ${share}%, ` +
    `over the ${percentOf(policy.maxExcludedRatio)}% limit set by agent.handoverMaxExcludedRatio`
  );
}

/**
 * Complete one harness's classified native records into the handover artifact.
 * The include/exclude decision lives here, not in a reader: `user` and
 * `assistant` become turns, `compaction` becomes the summary the transcript
 * starts from, and `thinking`, `tool-call` and `other` are left out.
 *
 * Every record after the last compaction is a complete native session entry, so
 * one this export deliberately leaves out still counts in the denominator and
 * an unparseable entry also counts as loss. Records before the last compaction
 * are discarded with the history that compaction replaced, and count toward
 * neither.
 */
export function completeHandoverExport(
  source: HandoverRecordSource,
): HarnessExport {
  let session = "";
  let total = 0;
  let excluded = 0;

  for (const record of source.records) {
    if (record.kind === "compaction") {
      // A compaction replaces every record before it, so the transcript and the
      // loss counts it carries start over here; only the latest one survives.
      // A blank summary — a condensation the harness could not read back —
      // carries no replacement prose, so it starts nothing and the transcript
      // before it stays.
      if (record.content.trim() === "") {
        total += 1;
        continue;
      }
      session = `## Compaction\n\n${escapeContentHeadings(record.content)}`;
      total = 1;
      excluded = 0;
      continue;
    }
    total += 1;
    switch (record.kind) {
      case "user":
      case "assistant": {
        const role = record.kind === "user" ? "User" : "Assistant";
        session += `${session === "" ? "" : "\n\n"}## ${role}\n\n${escapeContentHeadings(record.content)}`;
        break;
      }
      case "thinking":
      case "tool-call":
      case "other":
        break;
      case "unparseable":
        excluded += 1;
        break;
    }
  }

  const loss = excluded === 0 ? undefined : { excluded, total };
  return {
    sessionId: source.sessionId,
    session: session === "" ? "" : `${session}\n`,
    ...(loss === undefined ? {} : { loss }),
  };
}

/**
 * A content heading must not be mistaken for a role boundary in the artifact.
 * Fenced code is untouched: there a leading hash is literal content.
 */
function escapeContentHeadings(text: string): string {
  let fence: string | undefined;
  return text
    .split("\n")
    .map((line) => {
      const fenceMatch = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (fenceMatch !== null) {
        const marker = fenceMatch[1]!;
        if (fence === undefined) {
          fence = marker;
        } else if (
          marker[0] === fence[0] &&
          marker.length >= fence.length &&
          fenceMatch[2]!.trim() === ""
        ) {
          fence = undefined;
        }
        return line;
      }
      if (fence !== undefined) return line;

      const headingMatch = /^( {0,3})#{1,6}(?=\s|$)/.exec(line);
      if (headingMatch === null) return line;
      const indent = headingMatch[1]!;
      return `${indent}\\${line.slice(indent.length)}`;
    })
    .join("\n");
}

/**
 * Export one ended run's session through the harness that ran it. The reader
 * owns native discovery and record classification; this shared layer renders,
 * counts, and applies policy before anything stops the source run.
 */
export async function exportRunSession(
  harnesses: HarnessRegistry,
  from: AnyHarnessId,
  request: HarnessExportRequest,
  policy: SessionExportPolicy,
): Promise<RunSession> {
  const harness = harnesses.get(from);
  if (harness === undefined || !canReadHandoverRecords(harness)) {
    return {
      kind: "faulted",
      fault: { kind: "harness-cannot-export-session", harness: from },
    };
  }

  let source: HandoverRecordSource;
  try {
    source = await harness.readHandoverRecords(request);
  } catch (error) {
    return {
      kind: "faulted",
      fault: {
        kind: "session-export-failed",
        harness: from,
        detail: error instanceof Error ? error.message : String(error),
        ...(error instanceof SessionExportError
          ? { exportFault: error.fault }
          : {}),
      },
    };
  }
  if (source.sessionId.trim() === "") {
    return {
      kind: "faulted",
      fault: {
        kind: "session-export-failed",
        harness: from,
        detail: "the harness named no session id for the run it exported",
      },
    };
  }

  const exported = completeHandoverExport(source);
  const loss = exported.loss;
  if (
    loss !== undefined &&
    loss.total > 0 &&
    loss.excluded / loss.total > policy.maxExcludedRatio
  ) {
    return {
      kind: "faulted",
      fault: {
        kind: "session-export-failed",
        harness: from,
        detail: lossDetail(loss, policy),
      },
    };
  }
  if (exported.session.trim() === "") {
    return { kind: "faulted", fault: { kind: "session-empty", harness: from } };
  }
  return {
    kind: "exported",
    sessionId: exported.sessionId,
    session: exported.session,
    ...(loss === undefined ? {} : { loss }),
  };
}

/** One run of a handover chain: the harness that ran it, and the id it gave its session. */
export interface HandoverSessionRef {
  readonly harness: AnyHarnessId;
  /** Harness's own id for the session — what it resumes that session by. */
  readonly sessionId: string;
}

const MARKER_OPEN = "<<pi-cowboy-handover";
const MARKER_CLOSE = ">>";

/**
 * The line that says where an inherited session starts, carrying the chain
 * that led to it, oldest first. A handover task embeds the previous run's
 * session verbatim, so a later export of that run contains both its own work
 * and a transcript that is not its own; the marker is how that boundary and
 * the session ids are found without reading the transcript for anything else.
 * JSON keeps every id on one line and needs no escaping of its own.
 */
export function renderHandoverMarker(
  chain: readonly HandoverSessionRef[],
): string {
  // Only the two fields travel: a caller holding a fuller run record cannot
  // make the marker any heavier than the ref it stands for.
  const refs = chain.map(({ harness, sessionId }) => ({ harness, sessionId }));
  return `${MARKER_OPEN} ${JSON.stringify(refs)}${MARKER_CLOSE}`;
}

/**
 * The chain a handover task named, or undefined when the text carries no
 * readable marker. The first marker line is the outermost one: a chain's older
 * marker sits inside the quoted session, after this one.
 */
export function parseHandoverMarker(
  text: string,
): readonly HandoverSessionRef[] | undefined {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(`${MARKER_OPEN} `)) continue;
    if (!trimmed.endsWith(MARKER_CLOSE)) return undefined;
    const json = trimmed.slice(MARKER_OPEN.length + 1, -MARKER_CLOSE.length);
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return undefined;
    }
    const chain = HandoverSessionChainSchema.safeParse(parsed);
    return chain.success ? chain.data : undefined;
  }
  return undefined;
}

/** What the next run is told about the run it continues. */
export interface HandoverTaskRequest {
  readonly taskSlug: string | undefined;
  /** The harness the quoted session came from, as its settings row names it. */
  readonly sourceName: string;
  /** Sessions this spawn handed over before this one, oldest first. */
  readonly previous: readonly HandoverSessionRef[];
  /** The session being handed over: the one quoted below. */
  readonly current: HandoverSessionRef;
  readonly session: string;
}

/**
 * The task text the next run launches with. It is an ordinary task file — the
 * target harness reads it exactly as it reads any other, because the handover
 * is a prompt, not a protocol. The session is quoted last, after the
 * instruction to read the checkout, so the next harness reads the workspace
 * before it reads the session.
 */
export function renderHandoverTask(request: HandoverTaskRequest): string {
  const task =
    request.taskSlug === undefined
      ? "You are continuing this task in this workspace."
      : `You are continuing work on task "${request.taskSlug}" in this workspace.`;
  return [
    task,
    `This task was previously handled by another agent harness (${request.sourceName}).`,
    `The previous run's session id is "${request.current.sessionId}".`,
    renderHandoverMarker([...request.previous, request.current]),
    "",
    "The session of the previous run is quoted below. Review it together with the current state of the files in this repository, then proceed with the task.",
    "",
    "---",
    "",
    request.session,
    "",
  ].join("\n");
}

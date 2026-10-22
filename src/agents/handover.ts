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

import type { AgentStatus } from "../types.js";
import type { HarnessRegistry } from "./harness/harness-registry.js";
import type { ToolSeverity } from "./tool-result.js";
import {
  canExportForHandover,
  type AnyHarnessId,
  type HarnessExport,
  type HarnessExportRequest,
} from "./harness.js";

/** Why a handover did not happen. Data, never a throw: a caller reports it. */
export type HandoverFault =
  | { readonly kind: "agent-unknown" }
  /** A run still doing its own work has no finished session to hand over. */
  | { readonly kind: "agent-not-settled"; readonly status: AgentStatus }
  /** The source harness has no `exportForHandover` — or is no longer registered. */
  | {
      readonly kind: "harness-cannot-export-session";
      readonly harness: AnyHarnessId;
    }
  /** A run that never started engaged no harness and no placement, so there is nothing to export. */
  | { readonly kind: "never-started" }
  /** The old process could not be stopped; the checkout is not handed over under it. */
  | { readonly kind: "stop-failed"; readonly detail: string }
  | { readonly kind: "session-empty"; readonly harness: AnyHarnessId }
  | {
      readonly kind: "session-export-failed";
      readonly harness: AnyHarnessId;
      readonly detail: string;
    }
  /** The request itself was refused before anything was touched (harness, model). */
  | { readonly kind: "request-refused"; readonly detail: string }
  | { readonly kind: "launch-failed"; readonly detail: string };

/** What a handover did: moved the run to another harness, or named why it did not. */
export type HandoverOutcome =
  | {
      readonly kind: "handed-over";
      readonly from: AnyHarnessId;
      readonly to: AnyHarnessId;
    }
  | { readonly kind: "faulted"; readonly fault: HandoverFault };

/**
 * How a handover outcome reads: a completed handover is the success. A run
 * that was not handed over because the request could not be served — an
 * unknown or live agent, a harness that cannot export, a request refused — is
 * a refusal; a run that could not be stopped, exported, or relaunched is a
 * failure.
 */
export function handoverSeverity(outcome: HandoverOutcome): ToolSeverity {
  if (outcome.kind === "handed-over") return "success";
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
    }
  | { readonly kind: "faulted"; readonly fault: HandoverFault };

/**
 * Export one ended run's session through the harness that ran it. The
 * capability is the first question: a harness that cannot export its session
 * is a fault before anything is stopped or exported. The harness owns where
 * its session lives and which id names it; this owns the rules around it: a
 * throw is the harness's failure, an idless export is a broken one (the next
 * run's task would name a session it cannot reach), and an empty answer is no
 * session — a handover that handed over nothing would tell the next harness
 * nothing it could not guess.
 */
export async function exportRunSession(
  harnesses: HarnessRegistry,
  from: AnyHarnessId,
  request: HarnessExportRequest,
): Promise<RunSession> {
  const harness = harnesses.get(from);
  if (harness === undefined || !canExportForHandover(harness)) {
    return {
      kind: "faulted",
      fault: { kind: "harness-cannot-export-session", harness: from },
    };
  }

  let exported: HarnessExport;
  try {
    exported = await harness.exportForHandover(request);
  } catch (error) {
    return {
      kind: "faulted",
      fault: {
        kind: "session-export-failed",
        harness: from,
        detail: error instanceof Error ? error.message : String(error),
      },
    };
  }
  if (exported.sessionId.trim() === "") {
    return {
      kind: "faulted",
      fault: {
        kind: "session-export-failed",
        harness: from,
        detail: "the harness named no session id for the run it exported",
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
    if (!isSessionChain(parsed)) return undefined;
    return parsed.map(({ harness, sessionId }) => ({ harness, sessionId }));
  }
  return undefined;
}

/** A non-empty list of refs, each naming a harness and a session id. */
function isSessionChain(value: unknown): value is HandoverSessionRef[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry: unknown) => {
      if (typeof entry !== "object" || entry === null) return false;
      const ref = entry as { harness?: unknown; sessionId?: unknown };
      return (
        typeof ref.harness === "string" && typeof ref.sessionId === "string"
      );
    })
  );
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

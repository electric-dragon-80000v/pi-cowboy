/**
 * pane-supervisor.ts — Build the supervisor for one child process in a pane.
 *
 * Both attempt origins need the same construction: the deliverable the
 * supervisor polls, wrapped in a ProcessSupervisorEngine. This module builds
 * that and nothing else — launching the process (start), binding a live one
 * (adopt), and beginning the watch all stay with the caller, which owns the
 * placement and the checkpoint that may discard it.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  AgentHost,
  PaneControl,
  PlacementCatalog,
} from "../agents/agent-host.js";
import type { DeliverableSource } from "./deliverable.js";
import {
  ProcessSupervisorEngine,
  type ProcessSupervisor,
  type ProcessSupervisorOptions,
} from "./supervisor.js";

/** Narrow transport a supervisor is wired from: its host and the deliverable to poll. */
export interface SupervisorTransport {
  createHost(pi: ExtensionAPI): AgentHost;
  /** The pane surface a harness prepares through; the multiplexer's own, minted per parent session. */
  createPane(pi: ExtensionAPI): PaneControl;
  /** The multiplexer's view of the placements it owns; the cleanup/status paths read it. */
  createPlacements(pi: ExtensionAPI): PlacementCatalog;
  /** The report source the supervisor polls; a result file in production. */
  createDeliverable(resultFile: string): DeliverableSource;
}

/** What a supervisor is built from: the placement, its artifacts, and the transport wiring it. */
export interface PaneSupervisorInput {
  /** Caller-created host: placement (hostAt) predates the supervisor, so it cannot mint it. */
  host: AgentHost;
  resultFile: string;
  supervisorOptions?: ProcessSupervisorOptions;
  transport: SupervisorTransport;
}

/** Wire the deliverable and the multiplexer over it. Starts, adopts, and watches nothing. */
export function createPaneSupervisor(
  input: PaneSupervisorInput,
): ProcessSupervisor {
  const deliverable = input.transport.createDeliverable(input.resultFile);
  return new ProcessSupervisorEngine(
    input.host,
    deliverable,
    input.supervisorOptions,
  );
}

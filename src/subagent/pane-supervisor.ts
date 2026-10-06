/**
 * pane-supervisor.ts — Build the supervisor for one child process in a pane.
 *
 * Both attempt origins need the same construction: a SubagentIPC whose
 * onFrame carries the child's frames, wrapped in a ProcessSupervisorEngine (a
 * constructor that takes exactly that IPC). This module builds that pair and
 * nothing else —
 * launching the process (start), binding a live one (adopt), and beginning the
 * watch all stay with the caller, which owns the placement and the checkpoint
 * that may discard it, and which also drives the channel (IPC start/close).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentHost } from "../agents/agent-host.js";
import type { SubagentIPC, SubagentIPCOptions } from "./ipc.js";
import type { SubagentIpcFrame } from "./ipc-protocol.js";
import {
  ProcessSupervisorEngine,
  type ProcessSupervisor,
  type ProcessSupervisorOptions,
} from "./supervisor.js";

/**
 * Narrow transport a supervisor is wired from. Declared here so neither call
 * site imports the other's transport type; both satisfy it structurally.
 */
export interface SupervisorTransport {
  createHost(pi: ExtensionAPI): AgentHost;
  createIpc(options: SubagentIPCOptions): SubagentIPC;
}

/** What a supervisor is built from: the placement, its artifacts, and the transport wiring it. */
export interface PaneSupervisorInput {
  /** Caller-created host: placement (hostAt) predates the IPC, so the supervisor cannot mint it. */
  host: AgentHost;
  resultFile: string;
  supervisorOptions?: ProcessSupervisorOptions;
  transport: SupervisorTransport;
  /** Identity carried by the readiness endpoint. */
  agentId: string;
  /** Every recognized frame the child sends; the caller decides what each kind means. */
  onFrame?: (frame: SubagentIpcFrame) => void;
}

/** One attempt's pair: the engine that supervises it, and the channel that carries its frames. */
interface SupervisedRun {
  supervisor: ProcessSupervisor;
  ipc: SubagentIPC;
}

/** Wire the IPC and the engine over it. Starts, adopts, watches, and binds nothing. */
export function createPaneSupervisor(
  input: PaneSupervisorInput,
): SupervisedRun {
  const ipc = input.transport.createIpc({
    agentId: input.agentId,
    resultFile: input.resultFile,
    onFrame: input.onFrame,
  });
  return {
    supervisor: new ProcessSupervisorEngine(
      input.host,
      ipc,
      input.supervisorOptions,
    ),
    ipc,
  };
}

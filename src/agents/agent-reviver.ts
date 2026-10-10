/**
 * agent-reviver.ts — Return a settled run to active. Exports reviveSettledRun.
 *
 * The pane still holds a live pi process, so a delivered message starts a
 * second turn. The result dir is recreated empty first: settlement deletes it
 * (child writes would fail ENOENT) and a stale report would settle the
 * revive with the first run's outcome. A fresh supervisor adopts the host
 * (one run per instance). A revive is not an admission, so the run cannot wait
 * for room: it charges its pools immediately and can pass a limit. The promise
 * keeps the first run's gate: it opened with the first
 * turn's result, so the revived turn is reported through its completion message
 * alone.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getPiInstance } from "../shell.js";
import { subagentResultFileFor } from "../paths.js";
import type {
  ProcessSupervisor,
  ProcessSupervisorOptions,
  SubagentExitOutcome,
} from "../subagent/supervisor.js";
import {
  createPaneSupervisor,
  type SupervisorTransport,
} from "../subagent/pane-supervisor.js";
import type { AgentLaunchState, AgentSpawn } from "../types.js";
import type { AgentHostRef } from "./agent-host.js";
import { ensureResultDir } from "./result-file-permissions.js";

interface AgentReviveRequest {
  spawn: AgentSpawn;
  hostRef: AgentHostRef;
  transport: SupervisorTransport;
  supervisorOptions: ProcessSupervisorOptions;
  /** Attach the adopted supervisor, and the launch the revived turn resumes, as the session's live run. */
  attachSupervisor(
    supervisor: ProcessSupervisor,
    launch: AgentLaunchState,
  ): void;
  /** Re-bind the parent abort signal (settlement detached it). */
  rebindParentSignal(): void;
  /** Feed the revived run's terminal outcome back to the session. */
  reportOutcome(
    supervisor: ProcessSupervisor,
    outcome: SubagentExitOutcome,
  ): void;
}

/**
 * Reset settlement artifacts, adopt the host with a fresh supervisor, and arm
 * the second-settlement watch. The spawn's state stays with the session: the
 * attach seam returns the run to active, so this function writes none of it.
 * Synchronous: the message is already delivered, so nothing here waits on
 * the agent.
 */
export function reviveSettledRun(request: AgentReviveRequest): void {
  const { spawn, hostRef, transport } = request;
  const launch = resumeLaunch(spawn);
  const resultDir = path.dirname(launch.resultFile);
  // Reused dir: enforce owner-only mode even when it exists, so the revive
  // fails instead of continuing with world-readable secrets.
  ensureResultDir(resultDir);
  fs.rmSync(launch.resultFile, { force: true });

  const supervisor = createPaneSupervisor({
    host: transport.createHost(getPiInstance()),
    resultFile: launch.resultFile,
    supervisorOptions: request.supervisorOptions,
    transport,
  });
  // Adopted, never launched: the pane already holds the run's pi process.
  supervisor.adopt(hostRef);
  request.attachSupervisor(supervisor, launch);
  request.rebindParentSignal();
  void supervisor
    .watch()
    .then((outcome) => request.reportOutcome(supervisor, outcome));
}

/**
 * What the revived turn resumes: the settled turn's own artifacts, or a fresh
 * report path for a run that settled before it launched anything.
 */
function resumeLaunch(spawn: AgentSpawn): AgentLaunchState {
  const { lifecycle } = spawn;
  const resumed = lifecycle.phase === "settled" ? lifecycle.launch : undefined;
  return {
    resultFile: resumed?.resultFile ?? subagentResultFileFor(spawn.id),
  };
}

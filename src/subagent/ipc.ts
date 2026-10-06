/**
 * subagent/ipc.ts — SubagentIPC: the parent↔subagent message plane.
 *
 * The parent half is the HerdrSubagentIPC: a result file the child writes and
 * the readiness endpoint the child announces its boot on.
 */

import fs from "node:fs";
import * as path from "node:path";
import { createLogger } from "../logger.js";
import { errorMessage } from "../utils.js";
import { parseSubagentFrame, type SubagentIpcFrame } from "./ipc-protocol.js";
import {
  createIpcServer,
  getIpcAddress,
  type IpcMessage,
  type IpcServer,
} from "./socket-ipc.js";

const log = createLogger("ipc");

/** A read of the run's result file: what the child last wrote, and when. */
export interface DeliverableReport {
  content: string;
  /**
   * The file's modification time. Read with the content so a rewrite that
   * repeats the same words still counts as a report the caller has not seen.
   */
  mtime: number;
}

export interface SubagentIPC {
  readDeliverable(): Promise<DeliverableReport | null>;
  /**
   * Bind the run's endpoint so the child can announce its boot. Absent on a
   * transport with no endpoint. Rejects on a failed bind, which the caller
   * decides how to treat.
   */
  start?(): Promise<void>;
  /** Release the endpoint, leaving the run's artifacts alone. Idempotent. */
  close?(): Promise<void>;
}

// --- IPC implementation ---

/** Construction options for HerdrSubagentIPC. */
export interface SubagentIPCOptions {
  /** The run's identity: names the readiness endpoint and validates its frames. */
  agentId: string;
  /** Absolute path of the result file the subagent writes its deliverable to. */
  resultFile: string;
  /**
   * Every recognized frame the child sends over the run's connection, in arrival
   * order. The channel forwards frames; what each kind means is the caller's.
   */
  onFrame?: (frame: SubagentIpcFrame) => void;
}

/** SubagentIPC for a subagent in a herdr pane: files, readiness channel, teardown. */
export class HerdrSubagentIPC implements SubagentIPC {
  private readonly agentId: string;
  private readonly resultFile: string;
  private readonly onFrame: ((frame: SubagentIpcFrame) => void) | undefined;
  private channel: IpcServer | null = null;

  constructor(options: SubagentIPCOptions) {
    this.agentId = options.agentId;
    this.resultFile = options.resultFile;
    this.onFrame = options.onFrame;
  }

  /**
   * Bind the run's endpoint. Resolves once listening, so the caller launches the
   * child only when the parent is already reachable. One bind per run.
   */
  async start(): Promise<void> {
    if (this.channel !== null) return;
    const address = getIpcAddress(this.agentId);
    this.channel = await createIpcServer(address, {
      onMessage: (message) => this.handleFrame(message),
      onError: (error) =>
        log.warn("readiness channel error", {
          agentId: this.agentId,
          errorMessage: errorMessage(error),
        }),
    });
    log.debug("readiness channel bound", { agentId: this.agentId, address });
  }

  /** Idempotent: close the channel and unlink the endpoint. */
  async close(): Promise<void> {
    const server = this.channel;
    if (server === null) return;
    this.channel = null;
    await server.close().catch((error) => {
      log.warn("readiness channel close failed", {
        agentId: this.agentId,
        errorMessage: errorMessage(error),
      });
    });
  }

  /**
   * One frame from the child. A frame this run cannot claim — unparseable, or
   * naming another agent — is dropped; the channel stays up either way.
   */
  private handleFrame(message: IpcMessage): void {
    const frame = parseSubagentFrame(message);
    if (frame === null) {
      log.debug("ignoring unrecognized frame", { agentId: this.agentId });
      return;
    }
    if (frame.agentId !== this.agentId) {
      log.warn("ignoring frame for another agent", {
        agentId: this.agentId,
        announcedAgentId: frame.agentId,
      });
      return;
    }
    log.debug("received frame", { agentId: this.agentId, kind: frame.kind });
    this.onFrame?.(frame);
  }

  /**
   * The child's last report, or null when it is absent, unreadable, or blank —
   * the run has not finished. The content rides with the file's modification
   * time, because a rewritten report of the same words is still news. The stamp
   * is sampled before the content: a write landing between the two calls leaves
   * the pair understating the file rather than overstating it, and the next poll
   * corrects it.
   */
  async readDeliverable(): Promise<DeliverableReport | null> {
    try {
      const mtime = fs.statSync(this.resultFile).mtimeMs;
      const content = fs.readFileSync(this.resultFile, "utf-8").trim();
      if (!content) return null;
      return { content, mtime };
    } catch {
      return null;
    }
  }
}

/**
 * Remove a run's result directory. Best effort, and safe when it is already
 * gone — the files are ephemeral temp-dir artifacts.
 *
 * The artifacts outlive settlement: a settled run stays watched, so the child
 * may keep writing reports to this same directory until the run is dropped.
 */
export function removeResultArtifacts(resultFile: string): void {
  try {
    fs.rmSync(path.dirname(resultFile), { recursive: true, force: true });
  } catch {
    // Best effort: the agent's files are ephemeral temp-dir artifacts.
  }
}

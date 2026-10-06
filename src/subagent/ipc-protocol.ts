/**
 * ipc-protocol.ts — the readiness handshake both ends share.
 *
 * The parent binds a per-agent endpoint before launching a subagent; the child
 * pi process connects at boot and sends one ready frame carrying its own pid.
 * The frame shape, its validation, and the child's one call live together here
 * so the two ends cannot drift.
 */

import { createLogger } from "../logger.js";
import { detectSubagentSpawn } from "../shell.js";
import { errorMessage } from "../utils.js";
import {
  createIpcClient,
  getIpcAddress,
  type IpcClient,
  type IpcMessage,
} from "./socket-ipc.js";

const log = createLogger("handshake");

/** A booting subagent announcing that its own pi process is up. */
interface ReadyFrame {
  kind: "ready";
  agentId: string;
  /** The announcer's pid — the subagent pi process itself, not a pane or herdr. */
  pid: number;
}

/** Frames the orchestrator recognizes. Future message kinds join this union. */
export type SubagentIpcFrame = ReadyFrame;

/** The ready frame a child sends for itself; `pid` is a parameter so no test needs a child process. */
export function readyFrameFor(
  agentId: string,
  pid: number = process.pid,
): ReadyFrame {
  return { kind: "ready", agentId, pid };
}

/** Narrow an untrusted frame to the recognized union; null for anything unrecognized. */
export function parseSubagentFrame(value: unknown): SubagentIpcFrame | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const { kind, agentId, pid } = value as Record<string, unknown>;
  if (kind !== "ready") return null;
  if (typeof agentId !== "string" || agentId === "") return null;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0)
    return null;
  return { kind: "ready", agentId, pid };
}

/** How the child reaches its parent; injectable so a test needs no listener. */
interface AnnounceDeps {
  createClient?: (address: string) => Promise<IpcClient>;
}

/**
 * Tell the parent this process booted. Fire-and-forget and never throwing: the
 * parent may have no listener (extensions disabled, a listener that failed to
 * bind), and a missing handshake must not disturb the subagent's own work.
 */
export function announceSubagentReady(
  agentId: string,
  deps: AnnounceDeps = {},
): void {
  const createClient = deps.createClient ?? createIpcClient;
  void sendReady(agentId, createClient).catch((error) => {
    log.warn("subagent readiness handshake failed", {
      agentId,
      errorMessage: errorMessage(error),
    });
  });
}

/**
 * The delegated process's boot action. True when this argv carries a subagent
 * token (the caller stays inert — and the parent was told); false for a root
 * session, which announces nothing.
 */
export function announceReadyForSpawn(
  argv: readonly string[] = process.argv,
  announce: (agentId: string) => void = announceSubagentReady,
): boolean {
  const agentId = detectSubagentSpawn(argv);
  if (agentId === undefined) return false;
  announce(agentId);
  return true;
}

async function sendReady(
  agentId: string,
  createClient: (address: string) => Promise<IpcClient>,
): Promise<void> {
  const client = await createClient(getIpcAddress(agentId));
  try {
    const frame: IpcMessage = { ...readyFrameFor(agentId) };
    client.send(frame);
  } finally {
    // Flush the frame, then close; a disconnect failure cannot undo delivery.
    await client.disconnect().catch(() => {});
  }
}

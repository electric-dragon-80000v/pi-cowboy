/**
 * subagent/socket-ipc.ts — local IPC transport: newline-delimited JSON over node:net.
 *
 * One address per channel (a Unix domain socket under os.tmpdir() on POSIX, a
 * named pipe on Windows), one server, any number of clients. A frame is one JSON
 * object on one line; the reader tolerates split chunks, CRLF endings, and blank
 * lines, and never throws on a malformed peer. The message payload is the
 * caller's contract — the transport only requires a JSON object.
 */

import { createHash } from "node:crypto";
import { unlinkSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** One frame: a JSON object. Arrays and scalars are not messages and are dropped. */
export type IpcMessage = Record<string, unknown>;

/**
 * Longest frame body tolerated without a newline. A peer that sends more has that
 * frame dropped — a truncated giant frame must not be mistaken for a message.
 */
export const MAX_FRAME_CHARS = 1_048_576;

/** Longest sanitized id carried in an address, keeping the POSIX path inside sun_path's 104-byte limit. */
const MAX_ADDRESS_ID_CHARS = 32;

/** Characters an agent id keeps in an address; every other character becomes "_". */
const UNSAFE_ADDRESS_CHARS = /[^A-Za-z0-9._-]/g;

/** One character an address can carry; an id with none has no address to be distinct in. */
const SAFE_ADDRESS_CHAR = /[A-Za-z0-9._-]/;

/** A named pipe is not a filesystem entry, so nothing may be unlinked for one. */
const NAMED_PIPE_PREFIX = "\\\\.\\pipe\\";

/**
 * The address a local IPC channel for `agentId` listens on. `platform` is a
 * parameter so the Windows and POSIX shapes are both testable from one host.
 */
export function getIpcAddress(
  agentId: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const safe = sanitizeAddressId(agentId);
  return platform === "win32"
    ? `${NAMED_PIPE_PREFIX}cowboy-${safe}`
    : join(tmpdir(), `cowboy-ipc-${safe}.sock`);
}

/** Incremental NDJSON reader: push decoded text, receive whole messages. */
interface NdjsonDecoder {
  push(chunk: string): void;
}

/**
 * Build a decoder for one byte stream. `onMessage` sees every complete frame in
 * order; `onError` sees each dropped frame (malformed JSON, non-object JSON,
 * oversized). Without `onError` those frames are dropped silently.
 */
export function createNdjsonDecoder(
  onMessage: (message: IpcMessage) => void,
  onError?: (error: Error) => void,
): NdjsonDecoder {
  let buffer = "";
  // Once a frame is dropped for size, everything up to its terminating newline is
  // that frame's tail; without this, the tail would be read as the next frame.
  let discardingOversized = false;

  return {
    push(chunk: string): void {
      buffer += chunk;

      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");

        if (discardingOversized) {
          discardingOversized = false;
          continue;
        }
        if (line) parseFrame(line, onMessage, onError);
      }

      if (discardingOversized) {
        // Only the next newline matters; the retained tail is discarded frames.
        buffer = "";
      } else if (buffer.length > MAX_FRAME_CHARS) {
        onError?.(
          new Error(
            `ipc: dropping a ${buffer.length}-char frame with no newline within ${MAX_FRAME_CHARS} chars`,
          ),
        );
        buffer = "";
        discardingOversized = true;
      }
    },
  };
}

/** Server-side callbacks. Sockets never emit an unhandled "error" while these are wired. */
export interface IpcServerOptions {
  /** Every complete frame from every connected client. */
  onMessage: (message: IpcMessage) => void;
  /** Fires once per accepted connection, before any of its frames, with its id. */
  onConnect?: (connectionId: string) => void;
  /** Fires once when a connection's socket closes, for any reason. */
  onDisconnect?: (connectionId: string) => void;
  /** Socket failures and dropped frames. */
  onError?: (error: Error) => void;
}

export interface IpcServer {
  readonly address: string;
  /** Send one frame to every connected client. */
  broadcast(message: IpcMessage): void;
  /** Send one frame to the connection with this id (an id from `onConnect`). */
  send(connectionId: string, message: IpcMessage): void;
  /** Idempotent: destroy the connections, stop listening, remove a POSIX socket file. */
  close(): Promise<void>;
}

/** Client-side callbacks. */
export interface IpcClientOptions {
  /** Incoming frames. A client without this is send-only and ignores what the server writes. */
  onMessage?: (message: IpcMessage) => void;
  /** Socket failures and dropped frames. */
  onError?: (error: Error) => void;
}

export interface IpcClient {
  readonly address: string;
  /** Send one frame to the server. Throws once the client is disconnected. */
  send(message: IpcMessage): void;
  /** Idempotent: end the socket and resolve once it is closed. */
  disconnect(): Promise<void>;
}

/**
 * Listen on `address`. Resolves once the socket is bound, and rejects if the bind
 * fails — including EADDRINUSE from a live peer, since a leftover socket file is
 * removed before binding but a live listener is not something this can detect.
 */
export async function createIpcServer(
  address: string,
  options: IpcServerOptions,
): Promise<IpcServer> {
  const report = (error: Error): void => options.onError?.(error);
  const server = createServer();
  const connections = new Map<string, Socket>();
  let nextConnectionId = 1;
  let closed = false;

  discardSocketFile(address, report);

  server.on("connection", (socket) => {
    const connectionId = `c${nextConnectionId++}`;
    connections.set(connectionId, socket);
    socket.setEncoding("utf8");
    const decoder = createNdjsonDecoder(options.onMessage, report);
    // setEncoding makes this a string at runtime; toString() is the no-op the Buffer typing asks for.
    socket.on("data", (chunk) => decoder.push(chunk.toString()));
    socket.on("error", report);
    socket.on("close", () => {
      connections.delete(connectionId);
      options.onDisconnect?.(connectionId);
    });
    options.onConnect?.(connectionId);
  });

  await new Promise<void>((resolve, reject) => {
    const onBindError = (error: Error): void => reject(error);
    server.once("error", onBindError);
    server.listen(address, () => {
      server.off("error", onBindError);
      server.on("error", report);
      resolve();
    });
  });

  return {
    address,
    broadcast(message: IpcMessage): void {
      if (closed) throw new Error("ipc: server is closed");
      const line = `${JSON.stringify(message)}\n`;
      for (const socket of connections.values()) socket.write(line);
    },
    send(connectionId: string, message: IpcMessage): void {
      if (closed) throw new Error("ipc: server is closed");
      const socket = connections.get(connectionId);
      if (!socket) throw new Error(`ipc: unknown connection ${connectionId}`);
      socket.write(`${JSON.stringify(message)}\n`);
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      for (const socket of connections.values()) socket.destroy();
      connections.clear();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      discardSocketFile(address, report);
    },
  };
}

/**
 * Connect to `address`. Resolves once connected, and rejects if the connection
 * fails (a missing listener is the common case). A socket "error" never goes
 * unhandled: before the connect settles it rejects this promise, after that it
 * goes to `onError`.
 */
export async function createIpcClient(
  address: string,
  options: IpcClientOptions = {},
): Promise<IpcClient> {
  const socket = connect(address);
  let disconnected = false;
  let rejectConnect: ((error: Error) => void) | null = null;

  socket.setEncoding("utf8");
  socket.on("error", (error) => {
    if (rejectConnect) rejectConnect(error);
    else options.onError?.(error);
  });

  const { onMessage } = options;
  if (onMessage) {
    const decoder = createNdjsonDecoder(onMessage, options.onError);
    socket.on("data", (chunk) => decoder.push(chunk.toString()));
  }

  await new Promise<void>((resolve, reject) => {
    rejectConnect = (error: Error): void => reject(error);
    socket.once("connect", () => {
      rejectConnect = null;
      resolve();
    });
  });

  return {
    address,
    send(message: IpcMessage): void {
      if (disconnected) throw new Error("ipc: client is disconnected");
      socket.write(`${JSON.stringify(message)}\n`);
    },
    async disconnect(): Promise<void> {
      if (disconnected) return;
      disconnected = true;
      await new Promise<void>((resolve) => {
        if (socket.destroyed || socket.readyState === "closed") {
          resolve();
          return;
        }
        // Flush what is queued, then destroy: the peer's FIN is not what ends
        // this socket, and an inbound stream nobody reads (a send-only client)
        // would keep "close" back forever while we waited for it.
        socket.once("close", () => resolve());
        socket.end(() => socket.destroy());
      });
    },
  };
}

/** Compact an agent id into address characters, hashing what truncation would otherwise merge. */
function sanitizeAddressId(agentId: string): string {
  if (!SAFE_ADDRESS_CHAR.test(agentId)) {
    throw new Error(
      "getIpcAddress requires an agent id with at least one [A-Za-z0-9._-] character",
    );
  }
  const safe = agentId.replace(UNSAFE_ADDRESS_CHARS, "_");
  if (safe.length <= MAX_ADDRESS_ID_CHARS) return safe;
  const digest = createHash("sha256").update(agentId).digest("hex");
  // "-" + 8 hex chars fills the cap, so two long ids sharing a prefix stay distinct.
  return `${safe.slice(0, MAX_ADDRESS_ID_CHARS - 9)}-${digest.slice(0, 8)}`;
}

function isNamedPipeAddress(address: string): boolean {
  return address.startsWith(NAMED_PIPE_PREFIX);
}

/** Best-effort removal of a stale POSIX socket file; failures are reported, never thrown. */
function discardSocketFile(
  address: string,
  report: (error: Error) => void,
): void {
  if (isNamedPipeAddress(address)) return;
  try {
    unlinkSync(address);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") report(error as Error);
  }
}

function parseFrame(
  line: string,
  onMessage: (message: IpcMessage) => void,
  onError?: (error: Error) => void,
): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    onError?.(
      new Error(`ipc: dropping an unparsable ${line.length}-char frame`),
    );
    return;
  }
  if (!isIpcMessage(parsed)) {
    onError?.(
      new Error(`ipc: dropping a non-object ${line.length}-char frame`),
    );
    return;
  }
  onMessage(parsed);
}

function isIpcMessage(value: unknown): value is IpcMessage {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * ipc-protocol.test.ts — the readiness handshake: the frame the child sends,
 * the validation the parent applies to it, and the argv decision that gates the
 * announce. The announce tests bind a real endpoint and play the parent.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  announceReadyForSpawn,
  announceSubagentReady,
  parseSubagentFrame,
  readyFrameFor,
} from "../src/subagent/ipc-protocol.js";
import { subagentTokenFor } from "../src/shell.js";
import {
  createIpcServer,
  getIpcAddress,
  type IpcClient,
  type IpcMessage,
  type IpcServer,
} from "../src/subagent/socket-ipc.js";

const openServers: IpcServer[] = [];
let agentCounter = 0;

/** A fresh agent id per call: one endpoint per id, and none shared across workers. */
function freshAgentId(): string {
  agentCounter += 1;
  return `handshake-test-${process.pid}-${agentCounter}`;
}

async function startServer(
  agentId: string,
  onMessage: (message: IpcMessage) => void,
): Promise<IpcServer> {
  const server = await createIpcServer(getIpcAddress(agentId), { onMessage });
  openServers.push(server);
  return server;
}

/** A promise someone else fills in — how these tests wait without polling. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

afterEach(async () => {
  for (const server of openServers.splice(0)) await server.close();
});

describe("readyFrameFor", () => {
  it("announces the calling process itself", () => {
    expect(readyFrameFor("abc12345")).toEqual({
      kind: "ready",
      agentId: "abc12345",
      pid: process.pid,
    });
  });

  it("takes an explicit pid", () => {
    expect(readyFrameFor("abc12345", 4242)).toEqual({
      kind: "ready",
      agentId: "abc12345",
      pid: 4242,
    });
  });
});

describe("parseSubagentFrame", () => {
  it("accepts a ready frame and drops unknown fields", () => {
    expect(
      parseSubagentFrame({
        kind: "ready",
        agentId: "abc12345",
        pid: 7,
        note: "ignored",
      }),
    ).toEqual({ kind: "ready", agentId: "abc12345", pid: 7 });
  });

  it("rejects anything that is not a ready frame", () => {
    expect(
      parseSubagentFrame({ kind: "tick", agentId: "a", pid: 7 }),
    ).toBeNull();
    expect(
      parseSubagentFrame({ kind: "ready", agentId: "a", pid: 7.5 }),
    ).toBeNull();
    expect(
      parseSubagentFrame({ kind: "ready", agentId: "a", pid: 0 }),
    ).toBeNull();
    expect(
      parseSubagentFrame({ kind: "ready", agentId: "a", pid: -3 }),
    ).toBeNull();
    expect(
      parseSubagentFrame({ kind: "ready", agentId: "a", pid: "7" }),
    ).toBeNull();
    expect(parseSubagentFrame({ kind: "ready", agentId: "a" })).toBeNull();
    expect(
      parseSubagentFrame({ kind: "ready", agentId: "", pid: 7 }),
    ).toBeNull();
    expect(parseSubagentFrame({ kind: "ready", pid: 7 })).toBeNull();
    expect(
      parseSubagentFrame({ kind: "ready", agentId: 5, pid: 7 }),
    ).toBeNull();
    expect(parseSubagentFrame({})).toBeNull();
    expect(parseSubagentFrame(null)).toBeNull();
    expect(
      parseSubagentFrame([{ kind: "ready", agentId: "a", pid: 7 }]),
    ).toBeNull();
    expect(parseSubagentFrame(42)).toBeNull();
    expect(parseSubagentFrame("ready")).toBeNull();
  });
});

describe("announceSubagentReady", () => {
  it("sends one ready frame carrying this process's pid", async () => {
    const agentId = freshAgentId();
    const arrived = deferred<IpcMessage>();
    await startServer(agentId, arrived.resolve);

    announceSubagentReady(agentId);

    expect(await arrived.promise).toEqual({
      kind: "ready",
      agentId,
      pid: process.pid,
    });
  });

  it("flushes the frame and disconnects the client it opened", async () => {
    const sent: IpcMessage[] = [];
    const disconnected = deferred<void>();
    const client: IpcClient = {
      address: "stub",
      send: (message) => sent.push(message),
      disconnect: async () => {
        disconnected.resolve();
      },
    };

    announceSubagentReady("abc12345", { createClient: async () => client });
    await disconnected.promise;

    expect(sent).toEqual([
      { kind: "ready", agentId: "abc12345", pid: process.pid },
    ]);
  });

  it("swallows a failed connect: a missing parent is not the child's problem", async () => {
    const failed = deferred<void>();
    const createClient = async (): Promise<IpcClient> => {
      failed.resolve();
      throw new Error("nothing is listening");
    };

    expect(() =>
      announceSubagentReady(freshAgentId(), { createClient }),
    ).not.toThrow();
    await failed.promise;
    // The rejection went to the internal warn path; unhandled, vitest fails this file.
    await new Promise((resolve) => setImmediate(resolve));
  });
});

describe("announceReadyForSpawn", () => {
  it("announces the id carried by the argv subagent token", () => {
    const announced: string[] = [];

    const isSpawn = announceReadyForSpawn(
      [
        "pi",
        "--append-system-prompt",
        subagentTokenFor("abc12345"),
        "@task.md",
      ],
      (agentId) => announced.push(agentId),
    );

    expect(isSpawn).toBe(true);
    expect(announced).toEqual(["abc12345"]);
  });

  it("announces nothing in a root session", () => {
    const announced: string[] = [];

    const isSpawn = announceReadyForSpawn(
      ["pi", "--print", "hello"],
      (agentId) => announced.push(agentId),
    );

    expect(isSpawn).toBe(false);
    expect(announced).toEqual([]);
  });
});

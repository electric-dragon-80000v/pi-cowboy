/**
 * socket-ipc.test.ts — the NDJSON socket transport: addresses, framing, round
 * trips, and teardown.
 *
 * The socket tests bind real Unix domain sockets under os.tmpdir(); they are
 * skipped on Windows, where addresses are named pipes and no filesystem path
 * exists to hand to net.connect.
 */

import { existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createIpcClient,
  createIpcServer,
  createNdjsonDecoder,
  getIpcAddress,
  MAX_FRAME_CHARS,
  type IpcClient,
  type IpcClientOptions,
  type IpcMessage,
  type IpcServer,
  type IpcServerOptions,
} from "../src/subagent/socket-ipc.js";

const isWindows = process.platform === "win32";

const socketPaths: string[] = [];
const openServers: IpcServer[] = [];
const openClients: IpcClient[] = [];

let addressCounter = 0;

/** A socket path nothing else in this worker's process can collide with. */
function freshAddress(): string {
  addressCounter += 1;
  const address = join(
    tmpdir(),
    `cowboy-ipc-test-${process.pid}-${addressCounter}.sock`,
  );
  socketPaths.push(address);
  return address;
}

async function startServer(
  address: string,
  options: IpcServerOptions,
): Promise<IpcServer> {
  const server = await createIpcServer(address, options);
  openServers.push(server);
  return server;
}

async function startClient(
  address: string,
  options: IpcClientOptions = {},
): Promise<IpcClient> {
  const client = await createIpcClient(address, options);
  openClients.push(client);
  return client;
}

interface Recorder<T> {
  items: T[];
  next(): Promise<T>;
  /** Function-typed property rather than a method: tests hand this to the transport as a bare callback (`onMessage: received.push`). */
  push: (value: T) => void;
}

/** Ordered values with an await-able tail, so assertions neither poll nor sleep. */
function recorder<T>(): Recorder<T> {
  const items: T[] = [];
  const waiters: ((value: T) => void)[] = [];
  return {
    items,
    next(): Promise<T> {
      const queued = items.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      return new Promise((resolve) => waiters.push(resolve));
    },
    push(value: T): void {
      const waiter = waiters.shift();
      if (waiter) waiter(value);
      else items.push(value);
    },
  };
}

/** Every socket this file opened is closed and every socket file removed, whatever the test did. */
afterEach(async () => {
  for (const client of openClients.splice(0)) await client.disconnect();
  for (const server of openServers.splice(0)) await server.close();
  for (const path of socketPaths.splice(0)) rmSync(path, { force: true });
});

describe("getIpcAddress", () => {
  it("builds a POSIX socket path under tmpdir", () => {
    const expected = join(tmpdir(), "cowboy-ipc-agent-1.sock");
    expect(getIpcAddress("agent-1", "linux")).toBe(expected);
    expect(getIpcAddress("agent-1", "darwin")).toBe(expected);
  });

  it("builds a Windows named pipe address", () => {
    expect(getIpcAddress("agent-1", "win32")).toBe(
      "\\\\.\\pipe\\cowboy-agent-1",
    );
  });

  it("replaces characters an address cannot carry", () => {
    expect(getIpcAddress("a/b c:d", "linux")).toBe(
      join(tmpdir(), "cowboy-ipc-a_b_c_d.sock"),
    );
  });

  it("rejects an id with no address-safe character", () => {
    expect(() => getIpcAddress("///", "linux")).toThrow(/agent id/);
    expect(() => getIpcAddress("", "win32")).toThrow(/agent id/);
  });

  it("keeps long ids short, distinct, and inside the sun_path limit", () => {
    const shared = "x".repeat(200);
    const first = getIpcAddress(`${shared}-one`, "linux");
    const second = getIpcAddress(`${shared}-two`, "linux");

    expect(basename(first)).toHaveLength(
      "cowboy-ipc-".length + 32 + ".sock".length,
    );
    expect(Buffer.byteLength(first)).toBeLessThan(104);
    expect(first).not.toBe(second);
  });
});

describe("createNdjsonDecoder", () => {
  it("parses a frame pushed whole", () => {
    const frames = recorder<IpcMessage>();
    const decoder = createNdjsonDecoder(frames.push);

    decoder.push('{"kind":"hello","n":1}\n');

    expect(frames.items).toEqual([{ kind: "hello", n: 1 }]);
  });

  it("reassembles a frame split across chunks", () => {
    const frames = recorder<IpcMessage>();
    const decoder = createNdjsonDecoder(frames.push);

    decoder.push('{"kind":"hel');
    expect(frames.items).toEqual([]);
    decoder.push('lo","n":1}\n');

    expect(frames.items).toEqual([{ kind: "hello", n: 1 }]);
  });

  it("reassembles a frame split at the newline", () => {
    const frames = recorder<IpcMessage>();
    const decoder = createNdjsonDecoder(frames.push);

    decoder.push('{"ok":true}');
    expect(frames.items).toEqual([]);
    decoder.push("\n");

    expect(frames.items).toEqual([{ ok: true }]);
  });

  it("parses several frames from one chunk, in order", () => {
    const frames = recorder<IpcMessage>();
    const decoder = createNdjsonDecoder(frames.push);

    decoder.push('{"n":1}\n{"n":2}\n{"n":3}\n');

    expect(frames.items).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });

  it("ignores blank lines and CRLF endings", () => {
    const frames = recorder<IpcMessage>();
    const decoder = createNdjsonDecoder(frames.push);

    decoder.push('\n\r\n{"ok":1}\r\n');

    expect(frames.items).toEqual([{ ok: 1 }]);
  });

  it("drops malformed frames and keeps parsing the rest", () => {
    const errors: Error[] = [];
    const frames = recorder<IpcMessage>();
    const decoder = createNdjsonDecoder(frames.push, (error) =>
      errors.push(error),
    );

    decoder.push('not json at all {\n{"ok":true}\n');

    expect(frames.items).toEqual([{ ok: true }]);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("unparsable");
  });

  it("drops non-object JSON frames", () => {
    const errors: Error[] = [];
    const frames = recorder<IpcMessage>();
    const decoder = createNdjsonDecoder(frames.push, (error) =>
      errors.push(error),
    );

    decoder.push('42\n[1,2]\nnull\n"text"\n{"ok":1}\n');

    expect(frames.items).toEqual([{ ok: 1 }]);
    expect(errors).toHaveLength(4);
    expect(errors[0].message).toContain("non-object");
  });

  it("drops malformed frames silently without an onError handler", () => {
    const frames = recorder<IpcMessage>();
    const decoder = createNdjsonDecoder(frames.push);

    expect(() => decoder.push("not json\n")).not.toThrow();

    expect(frames.items).toEqual([]);
  });

  it("drops an oversized frame and resyncs at its terminating newline", () => {
    const errors: Error[] = [];
    const frames = recorder<IpcMessage>();
    const decoder = createNdjsonDecoder(frames.push, (error) =>
      errors.push(error),
    );

    decoder.push(`{"big":"${"x".repeat(MAX_FRAME_CHARS)}`);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("no newline");

    // The dropped frame's tail leads; only what follows its newline is a frame.
    decoder.push('"}\n{"ok":1}\n');

    expect(errors).toHaveLength(1);
    expect(frames.items).toEqual([{ ok: 1 }]);
  });
});

describe.skipIf(isWindows)("socket round trips", () => {
  it("delivers a client frame to the server", async () => {
    const received = recorder<IpcMessage>();
    const server = await startServer(freshAddress(), {
      onMessage: received.push,
    });
    const client = await startClient(server.address);

    client.send({ kind: "hello", nested: { n: 1 } });

    expect(await received.next()).toEqual({
      kind: "hello",
      nested: { n: 1 },
    });
  });

  it("keeps two sends on one connection as two frames", async () => {
    const received = recorder<IpcMessage>();
    const server = await startServer(freshAddress(), {
      onMessage: received.push,
    });
    const client = await startClient(server.address);

    client.send({ n: 1 });
    client.send({ n: 2, text: "héllo 🌵" });

    expect(await received.next()).toEqual({ n: 1 });
    expect(await received.next()).toEqual({ n: 2, text: "héllo 🌵" });
  });

  it("reassembles a frame larger than one socket chunk", async () => {
    const received = recorder<IpcMessage>();
    const server = await startServer(freshAddress(), {
      onMessage: received.push,
    });
    const client = await startClient(server.address);
    const payload = "x".repeat(200_000);

    client.send({ big: payload });

    expect(await received.next()).toEqual({ big: payload });
  });

  it("broadcasts a server frame to every connected client", async () => {
    const server = await startServer(freshAddress(), { onMessage: () => {} });
    const first = recorder<IpcMessage>();
    const second = recorder<IpcMessage>();
    await startClient(server.address, { onMessage: first.push });
    await startClient(server.address, { onMessage: second.push });

    server.broadcast({ kind: "tick" });

    expect(await first.next()).toEqual({ kind: "tick" });
    expect(await second.next()).toEqual({ kind: "tick" });
  });

  it("sends to one connection only, leaving the others untouched", async () => {
    const connections = recorder<string>();
    const server = await startServer(freshAddress(), {
      onMessage: () => {},
      onConnect: connections.push,
    });
    const first = recorder<IpcMessage>();
    const second = recorder<IpcMessage>();
    await startClient(server.address, { onMessage: first.push });
    await startClient(server.address, { onMessage: second.push });
    const firstId = await connections.next();
    const secondId = await connections.next();
    expect(firstId).toBe("c1");
    expect(secondId).toBe("c2");

    server.send(firstId, { kind: "only-first" });
    server.send(secondId, { kind: "marker" });

    expect(await first.next()).toEqual({ kind: "only-first" });
    expect(await second.next()).toEqual({ kind: "marker" });
    // Anything aimed at the first connection would arrive before the marker does.
    expect(second.items).toEqual([]);
  });

  it("refuses to send to an unknown connection id", async () => {
    const server = await startServer(freshAddress(), { onMessage: () => {} });
    await startClient(server.address);

    expect(() => server.send("c99", { kind: "nope" })).toThrow(
      /unknown connection/,
    );
  });

  it("reports a disconnect once and forgets the connection", async () => {
    const connections = recorder<string>();
    const disconnects = recorder<string>();
    const server = await startServer(freshAddress(), {
      onMessage: () => {},
      onConnect: connections.push,
      onDisconnect: disconnects.push,
    });
    const client = await startClient(server.address);
    const connectionId = await connections.next();

    await client.disconnect();

    expect(await disconnects.next()).toBe(connectionId);
    expect(() => server.send(connectionId, { kind: "gone" })).toThrow(
      /unknown connection/,
    );
  });

  it("tolerates server frames on a send-only client", async () => {
    const received = recorder<IpcMessage>();
    const server = await startServer(freshAddress(), {
      onMessage: received.push,
    });
    const client = await startClient(server.address);

    server.broadcast({ kind: "ignored" });
    client.send({ kind: "still-works" });

    expect(await received.next()).toEqual({ kind: "still-works" });
  });

  it("binds over a leftover socket file and removes its own on close", async () => {
    const address = freshAddress();
    writeFileSync(address, "");
    const server = await startServer(address, { onMessage: () => {} });
    expect(existsSync(address)).toBe(true);

    await server.close();

    expect(existsSync(address)).toBe(false);
  });

  it("rebinds the same address after a close", async () => {
    const address = freshAddress();
    const first = await startServer(address, { onMessage: () => {} });
    await first.close();

    const second = await startServer(address, { onMessage: () => {} });

    expect(second.address).toBe(address);
  });

  it("closes idempotently and refuses sends afterwards", async () => {
    const server = await startServer(freshAddress(), { onMessage: () => {} });

    await server.close();
    await server.close();

    expect(() => server.broadcast({ kind: "late" })).toThrow(
      /server is closed/,
    );
    expect(() => server.send("c1", { kind: "late" })).toThrow(
      /server is closed/,
    );
  });

  it("refuses to send after a disconnect and disconnects idempotently", async () => {
    const server = await startServer(freshAddress(), { onMessage: () => {} });
    const client = await startClient(server.address);

    await client.disconnect();
    await client.disconnect();

    expect(() => client.send({ kind: "late" })).toThrow(/disconnected/);
  });

  it("rejects when nothing is listening at the address", async () => {
    const address = join(tmpdir(), `cowboy-ipc-missing-${process.pid}.sock`);

    await expect(createIpcClient(address)).rejects.toThrow(/ENOENT/);
  });
});

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type SubagentIPC,
  HerdrSubagentIPC,
  removeResultArtifacts,
  type SubagentIPCOptions,
} from "../src/subagent/ipc.js";
import type { SubagentIpcFrame } from "../src/subagent/ipc-protocol.js";
import { createIpcClient, getIpcAddress } from "../src/subagent/socket-ipc.js";

function makeTmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

let agentCounter = 0;

/** Options for one IPC instance; every call gets its own agent id, so no two endpoints collide. */
function makeOptions(overrides?: {
  onFrame?: (frame: SubagentIpcFrame) => void;
}): SubagentIPCOptions {
  const dir = makeTmpDir("subagent-ipc-");
  agentCounter += 1;
  return {
    agentId: `subagent-ipc-${process.pid}-${agentCounter}`,
    resultFile: join(dir, "result.md"),
    onFrame: overrides?.onFrame,
  };
}

/** Endpoints this file's readiness tests opened; removed after every test, pass or fail. */
const openedEndpoints: string[] = [];

afterEach(() => {
  for (const address of openedEndpoints.splice(0))
    rmSync(address, { force: true });
});

describe("HerdrSubagentIPC", () => {
  it.each(["readDeliverable", "start", "close"] as const)(
    "exposes %s from the SubagentIPC contract",
    (method) => {
      // Compile-time conformance: assignability to the port type.
      const ipc: SubagentIPC = new HerdrSubagentIPC(makeOptions());
      expect(typeof ipc[method]).toBe("function");
    },
  );

  describe("readDeliverable", () => {
    it("returns the report content with its write stamp when the result file is present", async () => {
      const options = makeOptions();
      const ipc = new HerdrSubagentIPC(options);
      mkdirSync(dirname(options.resultFile), { recursive: true });
      writeFileSync(options.resultFile, "# Final answer\n\nall done\n");

      expect(await ipc.readDeliverable()).toEqual({
        content: "# Final answer\n\nall done",
        mtime: expect.any(Number),
      });
    });

    it("stamps a rewrite of the same words newer than the report it replaced", async () => {
      const options = makeOptions();
      const ipc = new HerdrSubagentIPC(options);
      mkdirSync(dirname(options.resultFile), { recursive: true });
      writeFileSync(options.resultFile, "same words");
      const first = await ipc.readDeliverable();

      const later = new Date(first!.mtime + 1_000);
      utimesSync(options.resultFile, later, later);
      const second = await ipc.readDeliverable();

      expect(second!.content).toBe(first!.content);
      expect(second!.mtime).toBeGreaterThan(first!.mtime);
    });

    it("returns null when the result file is absent", async () => {
      const ipc = new HerdrSubagentIPC(makeOptions());
      expect(await ipc.readDeliverable()).toBeNull();
    });

    it("returns null for a whitespace-only result file", async () => {
      const options = makeOptions();
      const ipc = new HerdrSubagentIPC(options);
      mkdirSync(dirname(options.resultFile), { recursive: true });
      writeFileSync(options.resultFile, "   \n\t ");

      expect(await ipc.readDeliverable()).toBeNull();
    });

    it("returns null when the result file is unreadable", async () => {
      // resultFile under a path whose parent is a regular file → ENOTDIR.
      const block = join(makeTmpDir("subagent-ipc-"), "not-a-dir");
      writeFileSync(block, "x");
      const ipc = new HerdrSubagentIPC({
        ...makeOptions(),
        resultFile: join(block, "result.md"),
      });
      expect(await ipc.readDeliverable()).toBeNull();
    });
  });

  describe("removeResultArtifacts", () => {
    it("removes the agent's result directory", () => {
      const options = makeOptions();
      mkdirSync(dirname(options.resultFile), { recursive: true });
      writeFileSync(join(dirname(options.resultFile), "prompt.md"), "task");
      expect(existsSync(dirname(options.resultFile))).toBe(true);

      removeResultArtifacts(options.resultFile);
      expect(existsSync(dirname(options.resultFile))).toBe(false);
    });

    it("is idempotent and never throws when already gone", () => {
      const { resultFile } = makeOptions();
      removeResultArtifacts(resultFile);
      removeResultArtifacts(resultFile);
    });
  });

  describe("readiness channel", () => {
    /** Bind a channel and remember its endpoint for teardown. */
    async function openIpc(
      options: SubagentIPCOptions,
    ): Promise<{ ipc: HerdrSubagentIPC; address: string }> {
      const ipc = new HerdrSubagentIPC(options);
      await ipc.start();
      const address = getIpcAddress(options.agentId);
      openedEndpoints.push(address);
      return { ipc, address };
    }

    it("forwards every frame for this agent, in arrival order", async () => {
      const frames: SubagentIpcFrame[] = [];
      const options = makeOptions({ onFrame: (frame) => frames.push(frame) });
      const { address } = await openIpc(options);
      const child = await createIpcClient(address);

      child.send({ kind: "ready", agentId: options.agentId, pid: 4242 });
      // A child reload announces again; the channel forwards both, in order.
      child.send({ kind: "ready", agentId: options.agentId, pid: 999 });

      await expect.poll(() => frames.length).toBe(2);
      expect(frames).toEqual([
        { kind: "ready", agentId: options.agentId, pid: 4242 },
        { kind: "ready", agentId: options.agentId, pid: 999 },
      ]);
      await child.disconnect();
    });

    it("ignores a frame naming another agent, then forwards its own", async () => {
      const frames: SubagentIpcFrame[] = [];
      const options = makeOptions({ onFrame: (frame) => frames.push(frame) });
      const { address } = await openIpc(options);
      const child = await createIpcClient(address);

      child.send({ kind: "ready", agentId: "some-other-agent", pid: 5 });
      child.send({ kind: "ready", agentId: options.agentId, pid: 7 });

      // Same connection, so the foreign frame was handled first — and ignored.
      await expect.poll(() => frames.length).toBe(1);
      expect(frames).toEqual([
        { kind: "ready", agentId: options.agentId, pid: 7 },
      ]);
      await child.disconnect();
    });

    it("ignores unrecognized frames without dropping the channel", async () => {
      const frames: SubagentIpcFrame[] = [];
      const options = makeOptions({ onFrame: (frame) => frames.push(frame) });
      const { address } = await openIpc(options);
      const child = await createIpcClient(address);

      child.send({ kind: "tick" });
      child.send({ hello: "world" });
      child.send({ kind: "ready", agentId: options.agentId, pid: 7.5 });
      child.send({ kind: "ready", agentId: options.agentId, pid: 7 });

      await expect.poll(() => frames.length).toBe(1);
      expect(frames).toEqual([
        { kind: "ready", agentId: options.agentId, pid: 7 },
      ]);
      await child.disconnect();
    });

    it("binds once and releases the endpoint on close", async () => {
      const options = makeOptions();
      const { ipc, address } = await openIpc(options);

      // One bind per run: a second call is a no-op, not an EADDRINUSE.
      await ipc.start();
      await ipc.close();
      await ipc.close();

      await expect(createIpcClient(address)).rejects.toThrow(/ENOENT/);
    });

    it("closes without having opened, and unlinks a bound endpoint", async () => {
      const neverOpened = new HerdrSubagentIPC(makeOptions());
      await neverOpened.close();

      const { ipc, address } = await openIpc(makeOptions());
      await ipc.close();

      await expect(createIpcClient(address)).rejects.toThrow(/ENOENT/);
    });
  });
});

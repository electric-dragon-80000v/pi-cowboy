/**
 * pane-supervisor.test.ts — The wiring one supervisor is built from: the
 * result file and the frame hook. The supervisor it returns is unstarted, so
 * start/adopt and the watch stay the caller's; polling semantics live in
 * test/process-supervisor.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentHost, AgentHostRef } from "../src/agents/agent-host.js";
import type {
  DeliverableReport,
  SubagentIPC,
  SubagentIPCOptions,
} from "../src/subagent/ipc.js";
import {
  createPaneSupervisor,
  type PaneSupervisorInput,
  type SupervisorTransport,
} from "../src/subagent/pane-supervisor.js";
import type { SubagentIpcFrame } from "../src/subagent/ipc-protocol.js";

const REF: AgentHostRef = {
  engine: "herdr",
  name: "cow-fix-login-abcd1234",
  paneId: "w1:p1",
  tabId: "w1:t1",
  workspaceId: "w1",
  paneCreated: false,
};

/** Scriptable IPC: reports what the test sets. */
class FakeIpc implements SubagentIPC {
  deliverable: string | null = null;
  async readDeliverable(): Promise<DeliverableReport | null> {
    return this.deliverable === null
      ? null
      : { content: this.deliverable, mtime: 1 };
  }
  async steer(): Promise<void> {}
}

function makeInput() {
  const startCalls: Array<{ ref: AgentHostRef; options: unknown }> = [];
  const host = {
    start: async (ref: AgentHostRef, options: unknown) => {
      startCalls.push({ ref, options });
    },
    observe: async () => undefined,
    stop: async () => true,
    release: async () => true,
    deliver: async () => ({ kind: "submitted" as const }),
  } as unknown as AgentHost;
  const ipc = new FakeIpc();
  let capturedOptions: SubagentIPCOptions | undefined;
  const transport: SupervisorTransport = {
    createHost: (_pi: ExtensionAPI) => host,
    createIpc: (options: SubagentIPCOptions) => {
      capturedOptions = options;
      return ipc;
    },
  };
  const input: PaneSupervisorInput = {
    host,
    resultFile: "/tmp/cowboy-pane-supervisor/result.md",
    supervisorOptions: { pollMs: 1_000 },
    transport,
    agentId: "abcd1234",
  };
  return {
    input,
    ipc,
    startCalls,
    options: () => {
      if (!capturedOptions) throw new Error("createIpc was not called");
      return capturedOptions;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createPaneSupervisor", () => {
  it("builds an unstarted supervisor that adopts and watches on demand", async () => {
    const fixture = makeInput();
    fixture.ipc.deliverable = "the answer";

    const supervisor = createPaneSupervisor(fixture.input).supervisor;

    // Building is not launching: nothing reached the pane.
    expect(fixture.startCalls).toEqual([]);
    // Nor watching: an unstarted supervisor refuses a watch.
    await expect(supervisor.watch()).rejects.toThrow(
      /requires start\(\) or adopt\(\)/,
    );

    supervisor.adopt(REF);
    const outcomes: unknown[] = [];
    void supervisor.watch().then((outcome) => outcomes.push(outcome));
    await vi.advanceTimersByTimeAsync(1_000); // first sighting: held
    await vi.advanceTimersByTimeAsync(1_000); // confirm: final
    expect(outcomes).toEqual([
      { kind: "completed", deliverable: "the answer" },
    ]);
  });

  it("carries the agent id and the frame hook into the IPC", () => {
    const fixture = makeInput();
    const frames: SubagentIpcFrame[] = [];
    fixture.input.onFrame = (frame) => frames.push(frame);

    const { ipc } = createPaneSupervisor(fixture.input);

    expect(fixture.options().agentId).toBe("abcd1234");
    // The caller gets the channel back so it can bind and release it itself.
    expect(ipc).toBe(fixture.ipc);
    fixture
      .options()
      .onFrame?.({ kind: "ready", agentId: "abcd1234", pid: 4242 });
    expect(frames).toEqual([{ kind: "ready", agentId: "abcd1234", pid: 4242 }]);
  });
});

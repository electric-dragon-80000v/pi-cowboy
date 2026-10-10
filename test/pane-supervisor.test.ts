/**
 * pane-supervisor.test.ts — The wiring one supervisor is built from: the
 * deliverable it polls. The supervisor it returns is unstarted, so start/adopt
 * and the watch stay the caller's; polling semantics live in
 * test/process-supervisor.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentHost, AgentHostRef } from "../src/agents/agent-host.js";
import type {
  DeliverableReport,
  DeliverableSource,
} from "../src/subagent/deliverable.js";
import {
  createPaneSupervisor,
  type PaneSupervisorInput,
  type SupervisorTransport,
} from "../src/subagent/pane-supervisor.js";

const REF: AgentHostRef = {
  engine: "herdr",
  name: "cow-fix-login-abcd1234",
  paneId: "w1:p1",
  tabId: "w1:t1",
  workspaceId: "w1",
  paneCreated: false,
};

/** Scriptable deliverable: reports what the test sets. */
class FakeDeliverable implements DeliverableSource {
  deliverable: string | null = null;
  async readDeliverable(): Promise<DeliverableReport | null> {
    return this.deliverable === null
      ? null
      : { content: this.deliverable, mtime: 1 };
  }
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
  const deliverable = new FakeDeliverable();
  let capturedResultFile: string | undefined;
  const transport: SupervisorTransport = {
    createHost: (_pi: ExtensionAPI) => host,
    createDeliverable: (resultFile: string) => {
      capturedResultFile = resultFile;
      return deliverable;
    },
  };
  const input: PaneSupervisorInput = {
    host,
    resultFile: "/tmp/cowboy-pane-supervisor/result.md",
    supervisorOptions: { pollMs: 1_000 },
    transport,
  };
  return {
    input,
    deliverable,
    startCalls,
    resultFile: () => {
      if (capturedResultFile === undefined)
        throw new Error("createDeliverable was not called");
      return capturedResultFile;
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
    fixture.deliverable.deliverable = "the answer";

    const supervisor = createPaneSupervisor(fixture.input);

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

  it("gives the deliverable the result file the supervisor polls", () => {
    const fixture = makeInput();
    createPaneSupervisor(fixture.input);
    expect(fixture.resultFile()).toBe(fixture.input.resultFile);
  });
});

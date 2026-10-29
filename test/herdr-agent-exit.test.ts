/**
 * herdr-agent-exit.test.ts — Layer 3: confirm agent absence.
 *
 * Success means registry-confirmed absence; the harness owns the stop keys, so
 * this layer must never write any. Order and count of the CLI calls are the
 * contract.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { HerdrAgents } from "../src/infrastructure/herdr/agents.js";
import { HerdrAgentExit } from "../src/infrastructure/herdr/agent-exit.js";
import { HerdrTransport } from "../src/infrastructure/herdr/herdr-transport.js";
import { fail, ok, recordingPi } from "./helpers/herdr-pi.js";

afterEach(() => {
  vi.useRealTimers();
});

function exitFor(pi: ExtensionAPI): HerdrAgentExit {
  const transport = new HerdrTransport(pi);
  return new HerdrAgentExit(new HerdrAgents(transport));
}

/** Registry response while the agent is still hosted. */
function present(): ReturnType<typeof ok> {
  return ok({ agent: { agent_status: "working", pane_id: "w1:p1" } });
}

describe("HerdrAgentExit.waitForAgentGone", () => {
  it("confirms a gone agent without sending a key", async () => {
    const { pi, calls } = recordingPi([fail("agent_not_found", "gone")]);

    await expect(
      exitFor(pi).waitForAgentGone("w1:p1", { timeoutMs: 0 }),
    ).resolves.toBe(true);
    expect(calls.map((c) => c.args.slice(0, 3))).toEqual([
      ["agent", "get", "w1:p1"],
    ]);
  });

  it("does not treat a failed registry probe as confirmation", async () => {
    const { pi, calls } = recordingPi([
      fail("server_busy", "temporary failure"),
    ]);

    await expect(
      exitFor(pi).waitForAgentGone("w1:p1", { timeoutMs: 0 }),
    ).resolves.toBe(false);
    expect(calls.map((c) => c.args.slice(0, 2))).toEqual([["agent", "get"]]);
  });

  it("waits out the documented 15s confirmation", async () => {
    // One probe per second plus the closing probe: a silent window change fails here.
    const probes = 16;
    const { pi, calls } = recordingPi(
      Array.from({ length: probes }, () => present()),
    );

    vi.useFakeTimers();
    const promise = exitFor(pi).waitForAgentGone("w1:p1");
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(promise).resolves.toBe(false);

    expect(calls.map((c) => c.args.slice(0, 2))).toEqual(
      Array.from({ length: probes }, () => ["agent", "get"]),
    );
  });
});

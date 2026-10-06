/**
 * herdr-agent-stopper.test.ts — Layer 3: interrupt, then confirm.
 *
 * Success means registry-confirmed absence; order and count of the CLI calls are
 * the contract.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { HerdrAgents } from "../src/infrastructure/herdr/agents.js";
import { HerdrAgentStopper } from "../src/infrastructure/herdr/agent-stopper.js";
import { HerdrTransport } from "../src/infrastructure/herdr/herdr-transport.js";
import { fail, ok, recordingPi } from "./helpers/herdr-pi.js";

afterEach(() => {
  vi.useRealTimers();
});

function stopperFor(pi: ExtensionAPI): HerdrAgentStopper {
  const transport = new HerdrTransport(pi);
  return new HerdrAgentStopper(new HerdrAgents(transport));
}

/** Registry response while the agent is still hosted. */
function present(): ReturnType<typeof ok> {
  return ok({ agent: { agent_status: "working", pane_id: "w1:p1" } });
}

describe("HerdrAgentStopper.stopAgentAndWait", () => {
  it("confirms a gone agent after the interrupt", async () => {
    const { pi, calls } = recordingPi([
      ok({}),
      fail("agent_not_found", "gone"),
    ]);

    await expect(
      stopperFor(pi).stopAgentAndWait("w1:p1", {
        interruptGraceMs: 0,
        confirmMs: 0,
      }),
    ).resolves.toBe(true);
    expect(calls.map((c) => c.args.slice(0, 3))).toEqual([
      ["agent", "send-keys", "w1:p1"],
      ["agent", "get", "w1:p1"],
    ]);
  });

  it("does not treat a failed registry probe as confirmation", async () => {
    const { pi, calls } = recordingPi([
      ok({}),
      fail("server_busy", "temporary failure"),
      fail("server_busy", "temporary failure"),
    ]);

    await expect(
      stopperFor(pi).stopAgentAndWait("w1:p1", {
        interruptGraceMs: 0,
        confirmMs: 0,
      }),
    ).resolves.toBe(false);
    expect(calls.map((c) => c.args.slice(0, 2))).toEqual([
      ["agent", "send-keys"],
      ["agent", "get"],
      ["agent", "get"],
    ]);
  });

  it("waits out the documented 8s interrupt grace and 15s confirmation", async () => {
    // One probe per second: 8 inside the grace window plus the closing probe, then
    // the same shape for the confirmation — a silent window change fails here.
    const graceProbes = 9;
    const confirmProbes = 16;
    const { pi, calls } = recordingPi([
      ok({}),
      ...Array.from({ length: graceProbes }, () => present()),
      ...Array.from({ length: confirmProbes }, () => present()),
    ]);

    vi.useFakeTimers();
    const promise = stopperFor(pi).stopAgentAndWait("w1:p1");
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(8_000);
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(promise).resolves.toBe(false);

    expect(calls.map((c) => c.args.slice(0, 2))).toEqual([
      ["agent", "send-keys"],
      ...Array.from({ length: graceProbes }, () => ["agent", "get"]),
      ...Array.from({ length: confirmProbes }, () => ["agent", "get"]),
    ]);
  });

  it("treats a failed interrupt as best effort and still confirms the absence", async () => {
    const { pi, calls } = recordingPi([
      fail("agent_not_found", "already gone"),
      fail("agent_not_found", "gone"),
    ]);

    await expect(stopperFor(pi).stopAgentAndWait("w1:p1")).resolves.toBe(true);
    expect(calls.map((c) => c.args.slice(0, 2))).toEqual([
      ["agent", "send-keys"],
      ["agent", "get"],
    ]);
  });
});

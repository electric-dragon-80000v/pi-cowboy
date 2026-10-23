/**
 * delegation-severity.test.ts — how a cowboy_agent result reads: the spawn
 * acknowledgements and a completed foreground run are successes, and a
 * foreground run that ended stopped is the one refusal.
 */

import { describe, expect, it } from "vitest";

import { delegationSeverity } from "../src/agents/tool-execution.js";

describe("delegationSeverity", () => {
  it("reads a background spawn as the success it reports", () => {
    expect(delegationSeverity({ agents: [{ status: "spawned" }] })).toBe(
      "success",
    );
  });

  it("reads a queued slot as a success — the run has not started yet", () => {
    expect(delegationSeverity({ agents: [{ status: "queued" }] })).toBe(
      "success",
    );
  });

  it("reads a completed foreground run as a success", () => {
    expect(delegationSeverity({ agents: [{ status: "completed" }] })).toBe(
      "success",
    );
  });

  it("reads a foreground run that ended stopped as a refusal", () => {
    expect(delegationSeverity({ agents: [{ status: "stopped" }] })).toBe(
      "warning",
    );
  });

  it("keeps a batch a success only when none of its items was stopped", () => {
    expect(
      delegationSeverity({
        agents: [{ status: "completed" }, { status: "stopped" }],
      }),
    ).toBe("warning");
  });
});

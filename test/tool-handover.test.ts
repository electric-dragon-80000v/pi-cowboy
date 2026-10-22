/**
 * tool-handover.test.ts — the handover_cowboy_agent tool boundary: the request
 * it validates and the outcome it reports in the result. The handover itself
 * is the session's (subagent-session.test.ts).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolResult } from "../src/agents/tool-result.js";
import type { HandoverFault, HandoverOutcome } from "../src/agents/handover.js";
import type { HandoverAgentParams } from "../src/agents/schemas/handover.schema.js";

const { getManagerMock, handoverMock, registryMock } = vi.hoisted(() => ({
  getManagerMock: vi.fn(),
  handoverMock: vi.fn(),
  // Two registered harnesses; the probe has not answered, so both are launchable.
  registryMock: {
    ids: () => ["pi", "claude"],
    get: (id: string) => (["pi", "claude"].includes(id) ? { id } : undefined),
  },
}));

vi.mock("../src/shell.js", () => ({
  getManager: getManagerMock,
  getHarnessRegistry: () => registryMock,
  getHarnessAvailability: () => ({ status: "unknown" }),
  // Only a harness that names a model reads this; these cases name none.
  getPiInstance: () => ({}),
  piModelCatalog: () => ({}),
}));

const { executeHandoverAgentTool, renderHandoverOutcome } =
  await import("../src/agents/tool-handover.js");

const ID = "a1b2c3d4";

type HandoverDetails = { agentId: string; outcome: HandoverOutcome };

function fakeContext() {
  return {
    modelRegistry: {},
    model: undefined,
    // No case here names a model, so nothing reaches the UI channel.
    hasUI: false,
    ui: {},
  } as never;
}

async function invoke(
  params: HandoverAgentParams,
): Promise<ToolResult<HandoverDetails>> {
  return executeHandoverAgentTool(
    "call-1",
    params,
    undefined,
    undefined,
    fakeContext(),
  );
}

function text(result: ToolResult<HandoverDetails>): string {
  return result.content.map((block) => block.text).join("\n");
}

beforeEach(() => {
  getManagerMock.mockReset().mockReturnValue({ handover: handoverMock });
  handoverMock.mockReset();
});

describe("executeHandoverAgentTool", () => {
  it("hands the agent to the target harness and reports where it continues", async () => {
    handoverMock.mockResolvedValue({
      kind: "handed-over",
      from: "pi",
      to: "claude",
    });

    const result = await invoke({
      agent_id: ID,
      harness_type: "claude",
    });

    expect(handoverMock).toHaveBeenCalledWith(ID, {
      harness: "claude",
      modelChoice: undefined,
    });
    expect(text(result)).toContain(`Agent ${ID} handed over from "pi" to`);
    expect(text(result)).toContain('"claude"');
    expect(result.details.outcome).toEqual({
      kind: "handed-over",
      from: "pi",
      to: "claude",
    });
    expect(result.details.severity).toBe("success");
  });

  it("reports a harness that cannot export its session, naming it", async () => {
    handoverMock.mockResolvedValue({
      kind: "faulted",
      fault: { kind: "harness-cannot-export-session", harness: "pi" },
    });

    const result = await invoke({
      agent_id: ID,
      harness_type: "claude",
    });

    expect(text(result)).toContain(`Agent ${ID} was not handed over`);
    expect(text(result)).toContain(
      'harness "pi" cannot export its own session',
    );
    expect(text(result)).toContain("Nothing was stopped or changed");
    // A capability gap is a refusal to report, not a failure: it reads as a warning.
    expect(result.details.severity).toBe("warning");
  });

  it("reports an unknown agent without raising a warning", async () => {
    handoverMock.mockResolvedValue({
      kind: "faulted",
      fault: { kind: "agent-unknown" },
    });

    const result = await invoke({
      agent_id: ID,
      harness_type: "pi",
    });

    expect(text(result)).toContain(`Agent ${ID} not found`);
    expect(result.details.severity).toBe("warning");
  });

  it("refuses a target harness the session does not know, naming what it has", async () => {
    const result = await invoke({
      agent_id: ID,
      harness_type: "nope",
    });

    // A handover has no template or configured default to fall back to, so the
    // refusal lists what this session registered instead of suggesting one.
    expect(text(result)).toContain('Unknown harness_type "nope"');
    expect(text(result)).toContain("pi, claude");
    expect(text(result)).toContain("Nothing was changed");
    expect(result.details.severity).toBe("warning");
    expect(handoverMock).not.toHaveBeenCalled();
  });

  it("refuses an empty target harness", async () => {
    const result = await invoke({ agent_id: ID, harness_type: "" });

    expect(text(result)).toContain("`harness_type` is required");
    expect(handoverMock).not.toHaveBeenCalled();
  });
});

describe("renderHandoverOutcome", () => {
  it("says what to do about a live agent", () => {
    expect(
      renderHandoverOutcome(ID, {
        kind: "faulted",
        fault: { kind: "agent-not-settled", status: "spawned" },
      }),
    ).toContain(
      `Agent ${ID} is still spawned — stop it with stop_cowboy_agent`,
    );
  });

  it("does not tell a queued agent to settle, which it cannot do", () => {
    const text = renderHandoverOutcome(ID, {
      kind: "faulted",
      fault: { kind: "agent-not-settled", status: "queued" },
    });

    expect(text).toContain(`Agent ${ID} is still queued`);
    expect(text).toContain("concurrency slot");
    expect(text).not.toContain("once it has settled");
  });

  it("says the ended run is archived when the next launch fails", () => {
    expect(
      renderHandoverOutcome(ID, {
        kind: "faulted",
        fault: { kind: "launch-failed", detail: "boom" },
      }),
    ).toContain("It stays tracked and can be cleaned up.");
  });

  // The id is prefixed once, so every fault names its agent exactly once — no
  // fault detail has to remember to carry it, and none repeats it.
  it("names the agent in every fault, exactly once", () => {
    const faults: Record<HandoverFault["kind"], HandoverFault> = {
      "agent-unknown": { kind: "agent-unknown" },
      "agent-not-settled": { kind: "agent-not-settled", status: "spawned" },
      "harness-cannot-export-session": {
        kind: "harness-cannot-export-session",
        harness: "pi",
      },
      "never-started": { kind: "never-started" },
      "stop-failed": { kind: "stop-failed", detail: "boom" },
      "session-empty": { kind: "session-empty", harness: "pi" },
      "session-export-failed": {
        kind: "session-export-failed",
        harness: "pi",
        detail: "boom",
      },
      "request-refused": { kind: "request-refused", detail: "boom" },
      "launch-failed": { kind: "launch-failed", detail: "boom" },
    };

    const lines = [
      ...Object.values(faults).map((fault) =>
        renderHandoverOutcome(ID, { kind: "faulted", fault }),
      ),
      renderHandoverOutcome(ID, {
        kind: "handed-over",
        from: "pi",
        to: "claude",
      }),
    ];

    expect(lines.filter((line) => !line.startsWith(`Agent ${ID} `))).toEqual(
      [],
    );
    expect(lines.filter((line) => line.split(ID).length !== 2)).toEqual([]);
  });
});

/**
 * herdr-agents.test.ts — Layer 2: the herdr agent registry.
 *
 * Load-bearing beyond argv: start retry classification (readiness timeout is
 * success, only "not an available shell" is retried) and gone-vs-unknown reads
 * (agent_not_found → undefined, other failures throw).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  AGENT_START_MAX_ATTEMPTS,
  AGENT_START_RETRY_BASE_DELAY_MS,
  AGENT_START_TIMEOUT_MS,
  HerdrAgents,
} from "../src/infrastructure/herdr/agents.js";
import {
  HerdrError,
  HerdrTransport,
} from "../src/infrastructure/herdr/herdr-transport.js";
import { fail, mockPi, ok, recordingPi } from "./helpers/herdr-pi.js";

afterEach(() => {
  vi.useRealTimers();
});

function agentsFor(pi: ExtensionAPI): HerdrAgents {
  return new HerdrAgents(new HerdrTransport(pi));
}

const START_OPTIONS = {
  name: "cow-abc",
  paneId: "w1:p2",
  piArgs: ["-p", "briefing"],
};

const START_ARGS = [
  "agent",
  "start",
  "cow-abc",
  "--kind",
  "pi",
  "--pane",
  "w1:p2",
  "--timeout",
  String(AGENT_START_TIMEOUT_MS),
  "--",
  "-p",
  "briefing",
];

describe("agent start constants", () => {
  it("keeps herdr's documented values", () => {
    expect(AGENT_START_TIMEOUT_MS).toBe(5_000);
    expect(AGENT_START_MAX_ATTEMPTS).toBe(5);
    expect(AGENT_START_RETRY_BASE_DELAY_MS).toBe(500);
  });
});

describe("HerdrAgents.startPiAgent", () => {
  it("starts pi in the pane with the briefing after `--`", async () => {
    const { pi, calls } = recordingPi([ok({})]);
    await expect(
      agentsFor(pi).startPiAgent(START_OPTIONS),
    ).resolves.toBeUndefined();
    expect(calls).toEqual([
      {
        cmd: "herdr",
        args: START_ARGS,
        opts: { timeout: AGENT_START_TIMEOUT_MS + 30_000 },
      },
    ]);
  });

  it("retries a transient unavailable-shell error until the shell is ready", async () => {
    let calls = 0;
    const pi = mockPi((_cmd, args) => {
      if (args[0] !== "agent")
        throw new Error(`unexpected command: ${args[0]}`);
      calls++;
      if (calls < 3) {
        return fail(
          "agent_pane_unavailable",
          "agent target pane w1:p2 is not an available shell",
        );
      }
      return ok({});
    });

    vi.useFakeTimers();
    const promise = agentsFor(pi).startPiAgent(START_OPTIONS);
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(promise).resolves.toBeUndefined();
    expect(calls).toBe(3);
  });

  it("does not retry a non-fatal readiness error", async () => {
    let calls = 0;
    const pi = mockPi(() => {
      calls++;
      return fail("agent_not_ready", "startup timed out");
    });

    await expect(
      agentsFor(pi).startPiAgent(START_OPTIONS),
    ).resolves.toBeUndefined();
    expect(calls).toBe(1);
  });

  it("does not retry a permanent error", async () => {
    let starts = 0;
    const pi = mockPi((_cmd, args) => {
      if (args[1] === "get") return fail("server_error", "boom");
      starts++;
      return fail("server_error", "boom");
    });

    await expect(agentsFor(pi).startPiAgent(START_OPTIONS)).rejects.toThrow(
      HerdrError,
    );
    expect(starts).toBe(1);
  });

  it("reads a rejected start as a launch when the pane already hosts the agent", async () => {
    let probes = 0;
    const pi = mockPi((_cmd, args) => {
      if (args[1] === "get") {
        probes++;
        return ok({
          agent: {
            pane_id: "w1:p2",
            agent_status: "working",
            interactive_ready: true,
          },
        });
      }
      return fail(
        "agent_name_not_found",
        "named agent cow-abc no longer owns the target terminal",
      );
    });

    await expect(
      agentsFor(pi).startPiAgent(START_OPTIONS),
    ).resolves.toBeUndefined();
    expect(probes).toBe(1);
  });

  it("keeps a rejected start a failure when the pane hosts no agent", async () => {
    const pi = mockPi((_cmd, args) => {
      if (args[1] === "get") return fail("agent_not_found", "no such agent");
      return fail(
        "agent_name_not_found",
        "named agent cow-abc no longer owns the target terminal",
      );
    });

    await expect(agentsFor(pi).startPiAgent(START_OPTIONS)).rejects.toThrow(
      /no longer owns the target terminal/,
    );
  });

  it("reports the attempt count when the shell never becomes available", async () => {
    let starts = 0;
    let probes = 0;
    const pi = mockPi((_cmd, args) => {
      if (args[1] === "get") {
        probes++;
        return fail("agent_not_found", "no such agent");
      }
      starts++;
      return fail(
        "agent_pane_unavailable",
        "agent target pane w1:p2 is not an available shell",
      );
    });

    vi.useFakeTimers();
    const promise = agentsFor(pi).startPiAgent(START_OPTIONS);
    const assertion = expect(promise).rejects.toThrow(
      /failed after 5 attempts/,
    );
    await vi.advanceTimersByTimeAsync(120_000);
    await assertion;
    expect(starts).toBe(AGENT_START_MAX_ATTEMPTS);
    expect(probes).toBe(1);
  });
});

describe("HerdrAgents registry reads", () => {
  it("listAgentRecords keeps nameless records (herdr 0.8.x drops the custom name)", async () => {
    // Nothing is keyed by name, so nameless records stay useful via cwd/workspace.
    const pi = mockPi(() =>
      ok({
        agents: [
          {
            name: "cow-fix-a-01234567",
            agent_status: "working",
            pane_id: "p1",
            cwd: "/repo/.herdr/cow-fix-a-01234567",
            workspace_id: "w1",
            tab_id: "w1:t1",
            interactive_ready: true,
          },
          {
            agent_status: "done",
            pane_id: "p2",
            cwd: "/repo/.herdr/cow-fix-b-01234567",
            workspace_id: "w2",
          },
          { agent_status: "idle" },
        ],
      }),
    );

    const records = await agentsFor(pi).listAgentRecords();

    expect(records).toEqual([
      {
        name: "cow-fix-a-01234567",
        state: "working",
        workspaceId: "w1",
        tabId: "w1:t1",
        cwd: "/repo/.herdr/cow-fix-a-01234567",
        paneId: "p1",
        interactiveReady: true,
      },
      {
        name: undefined,
        state: "done",
        workspaceId: "w2",
        tabId: undefined,
        cwd: "/repo/.herdr/cow-fix-b-01234567",
        paneId: "p2",
        interactiveReady: false,
      },
    ]);
  });

  it("listAgentRecords also accepts a bare array response", async () => {
    const pi = mockPi(() =>
      ok([
        { name: "solo", agent_status: "done", pane_id: "p7" },
        { name: "quiet", pane_id: "p8" },
      ]),
    );
    const records = await agentsFor(pi).listAgentRecords();
    expect(records).toMatchObject([
      { name: "solo", state: "done", paneId: "p7" },
      // Herdr reported no status for this record; it still reads, as unknown.
      { name: "quiet", state: "unknown", paneId: "p8" },
    ]);
  });

  it("rejects an agent list that carries neither declared envelope", async () => {
    // Both shipped shapes are accepted; anything else is a contract violation,
    // never a silent "no agents".
    const pi = mockPi(() => ok({ something_else: [] }));
    await expect(agentsFor(pi).listAgentRecords()).rejects.toThrow(
      /no agents array/,
    );
  });

  it("getAgentInfo reads the record's state and fills the target name", async () => {
    const pi = mockPi(() =>
      ok({
        agent: {
          name: "cow-abc",
          agent_status: "done",
          pane_id: "w1:p2",
          interactive_ready: true,
        },
      }),
    );
    await expect(agentsFor(pi).getAgentInfo("cow-abc")).resolves.toMatchObject({
      name: "cow-abc",
      state: "done",
      paneId: "w1:p2",
      interactiveReady: true,
    });

    const unnamed = mockPi(() =>
      ok({ agent: { agent_status: "idle", pane_id: "w1:p1" } }),
    );
    await expect(
      agentsFor(unnamed).getAgentInfo("w1:p1"),
    ).resolves.toMatchObject({ name: "w1:p1", state: "idle" });
  });

  it("getAgentInfo maps agent_not_found to undefined, other errors propagate", async () => {
    const gone = mockPi(() => fail("agent_not_found", "gone"));
    await expect(agentsFor(gone).getAgentInfo("p1")).resolves.toBeUndefined();

    const renamed = mockPi(() => fail("agent_name_not_found", "gone"));
    await expect(
      agentsFor(renamed).getAgentInfo("p1"),
    ).resolves.toBeUndefined();

    const broken = mockPi(() => fail("server_error", "boom"));
    await expect(agentsFor(broken).getAgentInfo("p1")).rejects.toThrow(
      HerdrError,
    );
  });

  it("findTaskAttempts filters to the task slug and degrades to [] on probe failure", async () => {
    const matching = mockPi(() =>
      ok({
        agents: [
          {
            name: "cow-fix-login-01234567",
            agent_status: "working",
            pane_id: "p1",
          },
          {
            name: "cow-other-task-01234567",
            agent_status: "idle",
            pane_id: "p2",
          },
        ],
      }),
    );
    const attempts = await agentsFor(matching).findTaskAttempts("fix-login");
    expect(attempts).toHaveLength(1);
    // Only the conflicting identity rides along, so the probe cannot be used to kill.
    expect(attempts[0]).toEqual({
      name: "cow-fix-login-01234567",
    });

    const failing = mockPi(() => fail("server_error", "boom"));
    await expect(
      agentsFor(failing).findTaskAttempts("fix-login"),
    ).resolves.toEqual([]);
  });

  it("findTaskAttempts matches nameless records by worktree directory (herdr 0.8.x drops the custom name)", async () => {
    const pi = mockPi(() =>
      ok({
        agents: [
          {
            // Custom name dropped by herdr: the durable cwd still owns the task.
            agent_status: "working",
            pane_id: "p1",
            cwd: "/repo/.herdr/cow-fix-login-01234567",
          },
          {
            // Nameless but a different task's worktree: not a hit.
            agent_status: "idle",
            pane_id: "p2",
            cwd: "/repo/.herdr/cow-other-task-01234567",
          },
          {
            // Nameless with no cwd: no task identity can be established.
            agent_status: "idle",
            pane_id: "p3",
          },
          {
            // Nameless with a non-worktree cwd: not a hit.
            agent_status: "idle",
            pane_id: "p4",
            cwd: "/repo",
          },
        ],
      }),
    );
    const attempts = await agentsFor(pi).findTaskAttempts("fix-login");
    // The worktree basename becomes the conflicting identity.
    expect(attempts).toEqual([{ name: "cow-fix-login-01234567" }]);
  });

  it("findTaskAttempts does not match a shorter slug prefix in the cwd (fix vs fix-login-flow)", async () => {
    const pi = mockPi(() =>
      ok({
        agents: [
          {
            agent_status: "working",
            pane_id: "p1",
            cwd: "/repo/.herdr/cow-fix-login-flow-01234567",
          },
        ],
      }),
    );
    await expect(agentsFor(pi).findTaskAttempts("fix")).resolves.toEqual([]);
  });
});

describe("HerdrAgents.sendKeys / interruptAgent", () => {
  it("sends logical keys and surfaces a rejection", async () => {
    const { pi, calls } = recordingPi([ok({})]);
    await expect(
      agentsFor(pi).sendKeys("w1:p1", ["enter"]),
    ).resolves.toBeUndefined();
    expect(calls).toEqual([
      {
        cmd: "herdr",
        args: ["agent", "send-keys", "w1:p1", "enter"],
        opts: { timeout: 15_000 },
      },
    ]);

    const unsupported = mockPi(() => fail("unsupported_key", "nope"));
    await expect(
      agentsFor(unsupported).sendKeys("w1:p1", ["nope"]),
    ).rejects.toThrow(HerdrError);
  });

  it("interrupts with ctrl+c and swallows a failure", async () => {
    const { pi, calls } = recordingPi([ok({})]);
    await expect(
      agentsFor(pi).interruptAgent("cow-x-01234567"),
    ).resolves.toBeUndefined();
    expect(calls).toEqual([
      {
        cmd: "herdr",
        args: ["agent", "send-keys", "cow-x-01234567", "ctrl+c"],
        opts: { timeout: 15_000 },
      },
    ]);

    const gone = mockPi(() => fail("agent_not_found", "gone"));
    await expect(
      agentsFor(gone).interruptAgent("cow-x-01234567"),
    ).resolves.toBeUndefined();

    const broken = mockPi(() => fail("server_error", "boom"));
    await expect(
      agentsFor(broken).interruptAgent("cow-x-01234567"),
    ).resolves.toBeUndefined();

    const silent = mockPi(() => ({ code: 1, stdout: "", stderr: "" }));
    await expect(
      agentsFor(silent).interruptAgent("cow-x-01234567"),
    ).resolves.toBeUndefined();
  });
});

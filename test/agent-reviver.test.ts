/**
 * agent-reviver.test.ts — Revive pinned at the run level (artifacts,
 * adopt-not-launch, outcome mapping). Lifecycle projection, the unsettled
 * flag, and retention reset live in test/subagent-session.test.ts.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { reviveSettledRun } from "../src/agents/agent-reviver.js";
import type { AgentHost, AgentHostRef } from "../src/agents/agent-host.js";
import type { DeliverableReport, SubagentIPC } from "../src/subagent/ipc.js";
import type { AgentSpawn } from "../src/types.js";

const { getPiInstanceMock } = vi.hoisted(() => ({
  getPiInstanceMock: vi.fn(() => ({})),
}));

vi.mock("../src/shell.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/shell.js")>();
  return { ...actual, getPiInstance: getPiInstanceMock };
});

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

interface FixtureOptions {
  resultFile?: string;
}

function makeFixture(options: FixtureOptions = {}) {
  const startCalls: Array<{ ref: AgentHostRef }> = [];
  const host = {
    hostAt: async () => REF,
    start: async (ref: AgentHostRef) => {
      startCalls.push({ ref });
    },
    observe: async () => undefined,
    stop: async () => true,
    release: async () => true,
    deliver: async () => ({ kind: "submitted" as const }),
    isAttached: async () => false,
    findAttempts: async () => [],
  } as unknown as AgentHost;
  const ipc = new FakeIpc();
  const ipcOptions: Array<{ agentId: string; resultFile: string }> = [];

  const spawn = {
    id: "abcd1234",
    lifecycle: {
      phase: "settled",
      startedAt: 1_700_000_000_000,
      launch: {
        resultFile: options.resultFile,
      },
      worktreeRetentionReason: { kind: "dirty" as const },
      status: "completed",
      result: "the first answer",
      completedAt: 1_700_000_010_000,
    },
    display: {
      type: "general-purpose",
      description: "Fix the login flow",
    },
    execution: {
      host: REF,
    },
  } as unknown as AgentSpawn;

  const attached: unknown[] = [];
  const outcomes: Array<{ kind: string }> = [];
  let rebinds = 0;

  const request = {
    spawn,
    hostRef: REF,
    transport: {
      createHost: (_pi: ExtensionAPI) => host,
      createIpc: (ipcOpts: { agentId: string; resultFile: string }) => {
        ipcOptions.push(ipcOpts);
        return ipc;
      },
    },
    supervisorOptions: { pollMs: 1_000 },
    attachSupervisor: (supervisor: unknown) => {
      attached.push(supervisor);
    },
    rebindParentSignal: () => {
      rebinds += 1;
    },
    reportOutcome: (_supervisor: unknown, outcome: { kind: string }) => {
      outcomes.push(outcome);
    },
  };

  return {
    request,
    spawn,
    ipc,
    ipcOptions,
    startCalls,
    attached,
    outcomes,
    rebinds: () => rebinds,
  };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowboy-reviver-"));
  getPiInstanceMock.mockReset().mockReturnValue({});
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("reviveSettledRun", () => {
  it("adopts the host without launching and leaves the spawn's state to the session", () => {
    const resultFile = path.join(tmpDir, "result.md");
    const fixture = makeFixture({ resultFile });

    reviveSettledRun(fixture.request);

    // Adopted, never launched. Lifecycle projection, the unsettled flag, and
    // retention reset are the session's attach seam; see the revive block in
    // test/subagent-session.test.ts.
    expect(fixture.startCalls).toEqual([]);
    expect(fixture.attached).toHaveLength(1);
    expect(fixture.rebinds()).toBe(1);
    expect(fixture.ipcOptions).toEqual([{ agentId: "abcd1234", resultFile }]);
  });

  it("recreates the result directory with the stale report cleared", () => {
    const resultFile = path.join(tmpDir, "nested", "result.md");
    // The revive must not settle on a stale report a best-effort cleanup left.
    fs.mkdirSync(path.dirname(resultFile), { recursive: true });
    fs.writeFileSync(resultFile, "STALE REPORT");
    const fixture = makeFixture({ resultFile });

    reviveSettledRun(fixture.request);

    expect(fs.existsSync(path.dirname(resultFile))).toBe(true);
    expect(fs.existsSync(resultFile)).toBe(false);
    // Reused dir is owner-only.
    expect(fs.statSync(path.dirname(resultFile)).mode & 0o777).toBe(0o700);
  });

  it("hands the revived run's terminal outcome back through the injected mapping", async () => {
    vi.useFakeTimers();
    const resultFile = path.join(tmpDir, "result.md");
    const fixture = makeFixture({ resultFile });

    reviveSettledRun(fixture.request);
    expect(fixture.outcomes).toEqual([]);

    fixture.ipc.deliverable = "the second answer";
    await vi.advanceTimersByTimeAsync(1_000); // first sighting: held
    expect(fixture.outcomes).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000); // confirm: final

    expect(fixture.outcomes).toEqual([
      {
        kind: "completed",
        deliverable: "the second answer",
      },
    ]);
  });
});

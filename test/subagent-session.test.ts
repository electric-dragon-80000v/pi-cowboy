/**
 * subagent-session.test.ts — Session invariants, pinned without fleet admission.
 * Runs drive end-to-end via the launch→watch seam; error-settle host touch
 * and retention capture assert on the fake host, never herdr internals.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DISPOSE_QUEUED_MESSAGE,
  SubagentSession,
  buildAgentSpawn,
  type SubagentSessionDeps,
  type SpawnOptions,
} from "../src/agents/subagent-session.js";
import { formatResultContent } from "../src/orchestrators/protocol.js";
import type { AgentHost, AgentHostRef } from "../src/agents/agent-host.js";
import { AgentSandbox } from "../src/spawn/sandbox.js";
import type {
  DeliverableReport,
  SubagentIPC,
  SubagentIPCOptions,
} from "../src/subagent/ipc.js";
import { HerdrSubagentIPC } from "../src/subagent/ipc.js";
import type {
  AgentLaunchState,
  AgentLifecycleState,
  AgentSpawn,
  AgentWorktree,
  ModelSelection,
} from "../src/types.js";
import type { PoolReservation } from "../src/task-registry.js";
import { TEST_ORCHESTRATION } from "./helpers/orchestration.js";

/** A paired model selection for the given "provider/modelId" concurrency key. */
function selectionFor(key: string): ModelSelection {
  const [provider, id] = key.split("/");
  return { model: { provider, id } as never, key };
}

/** One pool, so a test can see the reservation a session hands its slots dep. */
function makeReservation(): PoolReservation {
  return [{ limit: 1, spawned: 0 }];
}

const { getPiInstanceMock, getStoreMock, buildLaunchPlanMock } = vi.hoisted(
  () => ({
    getPiInstanceMock: vi.fn(() => ({})),
    getStoreMock: vi.fn(() => ({ agent: {} })),
    buildLaunchPlanMock: vi.fn(),
  }),
);

/** The revive's result-dir reset, made to fail on demand. */
const { resultDirGate } = vi.hoisted(() => ({
  resultDirGate: { fail: false },
}));

vi.mock("../src/agents/result-file-permissions.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../src/agents/result-file-permissions.js")
    >();
  return {
    ...actual,
    ensureResultDir: (dir: string) => {
      if (resultDirGate.fail) throw new Error("EACCES");
      actual.ensureResultDir(dir);
    },
  };
});

vi.mock("../src/agents/agent-runner.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/agents/agent-runner.js")>();
  return { ...actual, buildLaunchPlan: buildLaunchPlanMock };
});

vi.mock("../src/shell.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/shell.js")>();
  return {
    ...actual,
    getPiInstance: getPiInstanceMock,
    getStore: getStoreMock,
    // Stub store: the session registers at creation; these suites assert none of it.
    getAgentSpawns: () => ({
      add: () => {},
      get: () => undefined,
      drop: () => {},
      list: () => [],
    }),
  };
});

/**
 * The launch a run's pane bind produced; a queued run has none.
 */
function launchOf(spawn: AgentSpawn): AgentLaunchState | undefined {
  const { lifecycle } = spawn;
  // Only a run that launched carries a launch: queued has none, and a run that
  // ended before launching never produced one.
  return lifecycle.phase === "spawned" || lifecycle.phase === "settled"
    ? lifecycle.launch
    : undefined;
}

/**
 * The settled lifecycle under test. Retention is unrepresentable before
 * settlement, so a read off anything else is a broken test, not a gap.
 */
function settledExecution(
  spawn: AgentSpawn,
): Extract<AgentLifecycleState, { phase: "settled" }> {
  const { lifecycle } = spawn;
  if (lifecycle.phase !== "settled") {
    throw new Error(`expected a settled run, got ${lifecycle.phase}`);
  }
  return lifecycle;
}

/** Scripted IPC: the report the parent's watcher reads. */
class ScriptedIpc implements SubagentIPC {
  private stamp = 0;
  constructor(private readonly script: { deliverable?: string } = {}) {}

  /** Write a later report, moving its stamp so the watch reads it as news. */
  write(content: string): void {
    this.script.deliverable = content;
    this.stamp += 1;
  }

  async readDeliverable(): Promise<DeliverableReport | null> {
    return { content: this.script.deliverable ?? "done", mtime: this.stamp };
  }
  async steer(): Promise<void> {}
}

type StopOptions = {
  interruptGraceMs?: number;
  confirmMs?: number;
  interrupt?: boolean;
};
type StopCall = { ref: AgentHostRef; options?: StopOptions };
type ReleaseScope = "placement" | "worktree-association";
type ReleaseCall = { ref: AgentHostRef; scope: ReleaseScope };

function makeRef(paneCreated = true): AgentHostRef {
  return {
    engine: "herdr",
    name: "cow-fix-login-flow-01234567",
    paneId: "w1:p1",
    tabId: "w1:t1",
    workspaceId: "w1",
    paneCreated,
  };
}

interface FakeHostOptions {
  paneCreated?: boolean;
  observeState?: "done" | "working";
  /** Registry answer override; undefined models "no herdr agent registered". */
  observeAgent?: () => { state: "done" | "working" } | undefined;
}

/** Recording host: asserts whether the extension touched process or pane. */
function makeFakeHost(options: FakeHostOptions = {}) {
  const ref = makeRef(options.paneCreated ?? true);
  const hostAtCalls: Array<Record<string, unknown>> = [];
  const startCalls: Array<{
    ref: AgentHostRef;
    options: { name: string; piArgs: string[] };
  }> = [];
  const stopCalls: StopCall[] = [];
  const releaseCalls: ReleaseCall[] = [];
  const deliverCalls: Array<{ ref: AgentHostRef; message: string }> = [];
  let observeState = options.observeState ?? "done";
  let observeCalls = 0;
  const host = {
    hostAt: async (hostOptions: Record<string, unknown>) => {
      hostAtCalls.push(hostOptions);
      return ref;
    },
    start: async (
      startedRef: AgentHostRef,
      startOptions: { name: string; piArgs: string[] },
    ) => {
      startCalls.push({ ref: startedRef, options: startOptions });
    },
    observe: async () => {
      observeCalls += 1;
      return options.observeAgent
        ? options.observeAgent()
        : { state: observeState };
    },
    stop: async (stoppedRef: AgentHostRef, stopOptions?: StopOptions) => {
      stopCalls.push({ ref: stoppedRef, options: stopOptions });
      return true;
    },
    release: async (releasedRef: AgentHostRef, scope: ReleaseScope) => {
      releaseCalls.push({ ref: releasedRef, scope });
      return true;
    },
    deliver: async (deliveredRef: AgentHostRef, message: string) => {
      deliverCalls.push({ ref: deliveredRef, message });
      return true;
    },
  } as unknown as AgentHost;
  return {
    host,
    ref,
    hostAtCalls,
    startCalls,
    stopCalls,
    releaseCalls,
    deliverCalls,
    observeCalls: () => observeCalls,
    setObserveState: (state: "done" | "working") => {
      observeState = state;
    },
  };
}

interface HarnessOptions {
  id?: string;
  host?: AgentHost;
  /** Overrides the host factory entirely (e.g. a transport that throws). */
  createHost?: (pi: unknown) => AgentHost;
  ipc?: SubagentIPC;
  hostRef?: AgentHostRef;
  worktree?: AgentWorktree;
  options?: Partial<SpawnOptions>;
  onRunEnded?: (spawn: AgentSpawn) => void;
  /** Reports from a run that already settled, as the manager would hear them. */
  onFollowUpResult?: (spawn: AgentSpawn, deliverable: string) => void;
  /** Sees the options the session hands its IPC, for wiring assertions. */
  onIpcOptions?: (options: SubagentIPCOptions) => void;
}

function makeSession(options: HarnessOptions = {}) {
  const releasedSlots: string[] = [];
  const cancelledQueued: string[] = [];
  const reacquired: Array<{ id: string; modelKey: string | undefined }> = [];
  const reserved: PoolReservation[] = [];
  const ends: AgentSpawn[] = [];
  const deps: SubagentSessionDeps = {
    transport: {
      createHost: options.createHost ?? (() => options.host!),
      createIpc: (ipcOptions: SubagentIPCOptions) => {
        options.onIpcOptions?.(ipcOptions);
        return options.ipc!;
      },
    },
    slots: {
      reserve: (_spawn, reservation) => {
        reserved.push(reservation);
      },
      reacquire: (spawn, modelKey) => {
        reacquired.push({ id: spawn.id, modelKey });
      },
      release: async (id) => {
        releasedSlots.push(id);
      },
      cancelQueued: (id) => {
        cancelledQueued.push(id);
      },
    },
    onRunEnded: (spawn) => {
      ends.push(spawn);
      options.onRunEnded?.(spawn);
    },
    onFollowUpResult: (spawn, deliverable) =>
      options.onFollowUpResult?.(spawn, deliverable),
  };
  const session = new SubagentSession({
    id: options.id ?? "session-1",
    args: {
      pi: {} as never,
      ctx: {} as never,
      type: "general-purpose",
      prompt: "test run",
      options: {
        description: "test run",
        spawnId: options.id ?? "session-1",
        orchestration: TEST_ORCHESTRATION,
        worktree: options.worktree,
        hostRef: options.hostRef,
        ...options.options,
      },
    },
    deps,
  });
  return {
    session,
    releasedSlots,
    cancelledQueued,
    reacquired,
    reserved,
    ends,
  };
}

/** Fake timers plus a per-test result dir: the revive path recreates it on disk. */
let resultDir: string;

beforeEach(() => {
  vi.useFakeTimers();
  resultDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowboy-session-"));
  getPiInstanceMock.mockReset().mockReturnValue({});
  getStoreMock.mockReset().mockReturnValue({ agent: {} });
  buildLaunchPlanMock.mockReset().mockResolvedValue({
    cwd: "/repo",
    initialMessage: "@/tmp/briefing.md",
    resultFile: path.join(resultDir, "result.md"),
    piArgs: [],
    harness: "pi",
  });
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(resultDir, { recursive: true, force: true });
});

async function driveRun(ticksMs: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
  await Promise.resolve();
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(ticksMs);
}

/** Completed settlement needs two polls (one confirm tick). */
const DRIVE_COMPLETED_MS = 4_000;

/** A completed run reporting "the final answer" on a recording host. */
function completedRun(
  options: { onRunEnded?: (spawn: AgentSpawn) => void } = {},
) {
  const fake = makeFakeHost({ observeState: "done" });
  const harness = makeSession({
    host: fake.host,
    ipc: new ScriptedIpc({
      deliverable: "the final answer",
    }),
    hostRef: fake.ref,
    onRunEnded: options.onRunEnded,
  });
  return { ...fake, ...harness };
}
/** A failed launch settles without waiting for a report. */
const DRIVE_FAILED_MS = 2_000;

describe("SubagentSession", () => {
  it("keeps one mutable AgentSpawn instance and resolves a queued abort", async () => {
    const { session } = makeSession({
      host: makeFakeHost().host,
      ipc: new ScriptedIpc(),
    });
    const spawn = session.spawn;

    expect(session.spawn).toBe(spawn);
    await expect(session.abort("user")).resolves.toBe(true);
    await expect(session.promise).resolves.toBe("");
    expect(session.spawn.lifecycle).toMatchObject({
      phase: "never-started",
      status: "stopped",
    });
    expect(session.spawn.lifecycle.phase).toBe("never-started");
  });

  it("takes no pool when it starts a spawn that is not queued", async () => {
    const fake = makeFakeHost({ observeState: "working" });
    const run = makeSession({
      host: fake.host,
      ipc: new ScriptedIpc(),
      hostRef: fake.ref,
    });
    const reservation = makeReservation();
    run.session.start(reservation);
    await driveRun(0);
    expect(run.reserved).toEqual([reservation]);

    // A second start finds a spawn that is no longer queued: it takes no pool,
    // or the charge would leak with no run to release it.
    run.session.start(makeReservation());
    expect(run.reserved).toHaveLength(1);
  });

  it("projects a queued disposal as the explicit never-started error", async () => {
    const { session } = makeSession({
      host: makeFakeHost().host,
      ipc: new ScriptedIpc(),
    });
    session.settleForDispose();

    await expect(session.promise).resolves.toBe("");
    expect(session.spawn.lifecycle).toMatchObject({
      phase: "never-started",
      status: "error",
      error: "Agent manager disposed before the queued agent could start.",
    });
  });

  it("builds queued spawns without a copied lifecycle projection", () => {
    const spawn = buildAgentSpawn(
      {
        pi: {} as never,
        ctx: {} as never,
        type: "general-purpose",
        prompt: "test run",
        options: {
          description: "test run",
          spawnId: "sess-test-1",
          orchestration: TEST_ORCHESTRATION,
        },
      },
      Promise.resolve(""),
    );
    expect(spawn.lifecycle).toMatchObject({ phase: "queued" });
  });
});

/** A launch that throws settles the spawn as failed; nothing else about the run is tracked. */
describe("SubagentSession launch failure", () => {
  it("a throwing transport at launch settles as failed without touching a host", async () => {
    // No host was ever obtained, so the settle touches nothing.
    const createHostCalls: unknown[] = [];
    const harness = makeSession({
      createHost: () => {
        createHostCalls.push(1);
        throw new Error("transport exploded");
      },
      ipc: new ScriptedIpc(),
    });
    harness.session.start();
    await driveRun(DRIVE_FAILED_MS);

    await expect(harness.session.promise).resolves.toBe("");
    expect(harness.session.spawn.lifecycle).toMatchObject({
      phase: "settled",
      status: "error",
      error: "transport exploded",
    });
    expect(harness.session.spawn.lifecycle.phase).toBe("settled");
    // One construction (the launch): no kill sequence ran.
    expect(createHostCalls).toHaveLength(1);
  });
});

/** Report-only: herdr liveness never settles a run; only its own report does. */
describe("SubagentSession report-only launch", () => {
  it("keeps a launch whose pane never registers in herdr spawned until its report lands", async () => {
    const fake = makeFakeHost();
    const report = { deliverable: null as string | null };
    const ipc: SubagentIPC = {
      readDeliverable: async () =>
        report.deliverable === null
          ? null
          : { content: report.deliverable, mtime: 1 },
    };
    const run = makeSession({ host: fake.host, ipc, hostRef: fake.ref });
    run.session.start();
    await driveRun(0);
    expect(run.session.isActive()).toBe(true);

    // Ten polls of an empty registry settle nothing.
    for (let poll = 0; poll < 10; poll += 1) {
      await vi.advanceTimersByTimeAsync(2_000);
    }
    expect(run.session.isActive()).toBe(true);
    expect(run.session.spawn.lifecycle).toMatchObject({ phase: "spawned" });
    expect(fake.stopCalls).toEqual([]);

    report.deliverable = "final report";
    await driveRun(DRIVE_COMPLETED_MS);
    await expect(run.session.promise).resolves.toBe("final report");
    expect(run.session.spawn.lifecycle).toMatchObject({
      phase: "settled",
      status: "completed",
      result: "final report",
    });
    expect(fake.stopCalls).toEqual([]);
  });
});

describe("SubagentSession process handshake", () => {
  /** An IPC the session can bind: start resolves (or fails), and the run's artifacts are scripted. */
  function makeChannelIpc(
    script: {
      failStart?: Error;
      deliverable?: string | null;
      onStart?: () => void;
    } = {},
  ): {
    ipc: SubagentIPC;
    closes: () => number;
  } {
    let deliverable = script.deliverable ?? null;
    let closes = 0;
    return {
      ipc: {
        start: async () => {
          script.onStart?.();
          if (script.failStart) throw script.failStart;
        },
        close: async () => {
          closes += 1;
        },
        readDeliverable: async () =>
          deliverable === null ? null : { content: deliverable, mtime: 1 },
      },
      closes: () => closes,
    };
  }

  /** Where the session's IPC options land, so a frame can be delivered as the child would. */
  function capturing(): { options: SubagentIPCOptions | null } {
    return { options: null };
  }

  /** A session on a recording host, with the options it handed its IPC captured. */
  function makeRun(
    script: {
      failStart?: Error;
      deliverable?: string | null;
      onStart?: () => void;
    } = {},
  ) {
    const fake = makeFakeHost({ observeState: "working" });
    const captured = capturing();
    const channel = makeChannelIpc(script);
    const run = makeSession({
      host: fake.host,
      ipc: channel.ipc,
      hostRef: fake.ref,
      onIpcOptions: (options) => {
        captured.options = options;
      },
    });
    return { ...fake, ...run, channel, capture: captured };
  }

  it("waits for an announcement once its channel is bound", async () => {
    const run = makeRun();

    run.session.start();
    await driveRun(0);

    // Nothing heard yet — which covers both a child still booting and one that
    // will never speak; silence is not evidence either way.
    expect(launchOf(run.session.spawn)?.handshake).toEqual({
      kind: "awaiting",
    });
  });

  it("names the run's process from the first frame and ignores a repeat", async () => {
    const run = makeRun();
    run.session.start();
    await driveRun(0);

    run.capture.options?.onFrame?.({
      kind: "ready",
      agentId: run.session.id,
      pid: 4242,
    });
    expect(launchOf(run.session.spawn)?.handshake).toEqual({
      kind: "announced",
      pid: 4242,
    });

    // A child reload announces again; the run's process is the first one named.
    run.capture.options?.onFrame?.({
      kind: "ready",
      agentId: run.session.id,
      pid: 9999,
    });
    expect(launchOf(run.session.spawn)?.handshake).toEqual({
      kind: "announced",
      pid: 4242,
    });
  });

  it("launches anyway when the endpoint cannot be bound", async () => {
    const run = makeRun({ failStart: new Error("EADDRINUSE") });

    run.session.start();
    await driveRun(0);

    expect(run.startCalls).toHaveLength(1);
    expect(launchOf(run.session.spawn)?.handshake).toEqual({
      kind: "unavailable",
      reason: "bind-failed",
    });
  });

  it("records no channel when the transport has none", async () => {
    const fake = makeFakeHost({ observeAgent: () => undefined });
    const ipc: SubagentIPC = {
      readDeliverable: async () => null,
    };
    const run = makeSession({ host: fake.host, ipc, hostRef: fake.ref });

    run.session.start();
    await driveRun(0);

    expect(launchOf(run.session.spawn)?.handshake).toEqual({
      kind: "unavailable",
      reason: "no-channel",
    });
  });

  it("binds the run's channel before the process is launched", async () => {
    const order: string[] = [];
    const run = makeRun({ onStart: () => order.push("channel.start") });
    const launch = run.host.start.bind(run.host);
    run.host.start = async (startedRef, startOptions) => {
      order.push("host.start");
      await launch(startedRef, startOptions);
    };

    run.session.start();
    await driveRun(0);

    // The child connects at boot, so the parent must already be listening.
    expect(order).toEqual(["channel.start", "host.start"]);
  });

  it("releases the bound channel when the run settles", async () => {
    const run = makeRun({ deliverable: "the final answer" });

    run.session.start();
    await driveRun(DRIVE_COMPLETED_MS);

    expect(run.session.spawn.lifecycle).toMatchObject({ phase: "settled" });
    expect(run.channel.closes()).toBe(1);
  });

  it("keeps the announced process across a revival", async () => {
    const run = makeRun({ deliverable: "the final answer" });
    run.session.start();
    await driveRun(0);
    run.capture.options?.onFrame?.({
      kind: "ready",
      agentId: run.session.id,
      pid: 4242,
    });
    await driveRun(DRIVE_COMPLETED_MS);
    expect(run.session.spawn.lifecycle).toMatchObject({ phase: "settled" });

    await expect(run.session.steer("one more thing")).resolves.toEqual({
      kind: "delivered",
    });

    // The pane still hosts the same pi, so the announced process is still the run's.
    expect(run.session.isActive()).toBe(true);
    expect(launchOf(run.session.spawn)?.handshake).toEqual({
      kind: "announced",
      pid: 4242,
    });
  });

  it("has no channel for a revived turn that never announced", async () => {
    const run = makeRun({ deliverable: "the final answer" });
    run.session.start();
    await driveRun(DRIVE_COMPLETED_MS);
    expect(launchOf(run.session.spawn)?.handshake).toEqual({
      kind: "awaiting",
    });

    await expect(run.session.steer("one more thing")).resolves.toEqual({
      kind: "delivered",
    });

    // The revived turn binds no channel, and the adopted child never reboots.
    expect(launchOf(run.session.spawn)?.handshake).toEqual({
      kind: "unavailable",
      reason: "revive",
    });
  });

  it("releases the bound channel on disposal, keeping the artifacts", async () => {
    const fake = makeFakeHost({ observeState: "working" });
    let closes = 0;
    const ipc: SubagentIPC = {
      start: async () => {},
      close: async () => {
        closes += 1;
      },
      readDeliverable: async () => null,
    };
    const run = makeSession({ host: fake.host, ipc, hostRef: fake.ref });
    run.session.start();
    await driveRun(0);
    fs.writeFileSync(path.join(resultDir, "prompt.md"), "task");

    run.session.settleForDispose();

    // The endpoint is the parent's; the abandoned run's files stay for a later revive.
    expect(closes).toBe(1);
    expect(fs.existsSync(path.join(resultDir, "prompt.md"))).toBe(true);
  });

  it("removes the run's result artifacts when the spawn is dropped", async () => {
    const fake = makeFakeHost({ observeState: "done" });
    const harness = makeSession({
      host: fake.host,
      ipc: new ScriptedIpc(),
      hostRef: fake.ref,
    });
    harness.session.start();
    await driveRun(DRIVE_COMPLETED_MS);
    expect(harness.session.spawn.lifecycle).toMatchObject({
      phase: "settled",
    });
    expect(fs.existsSync(resultDir)).toBe(true);

    harness.session.drop();

    // Dropping the spawn is what releases the run's artifacts.
    expect(fs.existsSync(resultDir)).toBe(false);
  });
});

describe("SubagentSession launch naming", () => {
  const BRANCH = "cow-fix-login-flow-session-1";

  function launchedRun(options: {
    taskSlug?: string;
    worktree?: AgentWorktree;
    hostRef?: AgentHostRef;
  }) {
    const fake = makeFakeHost({ observeState: "done" });
    const harness = makeSession({
      host: fake.host,
      ipc: new ScriptedIpc({ deliverable: "the final answer" }),
      hostRef: options.hostRef,
      worktree: options.worktree,
      options:
        options.taskSlug === undefined
          ? undefined
          : { taskSlug: options.taskSlug },
    });
    harness.session.start();
    return { ...fake, ...harness };
  }

  it("names a parent-cwd pane cow-<task>-<id> for a task-slugged spawn", async () => {
    const run = launchedRun({ taskSlug: "fix-login-flow" });
    await driveRun(DRIVE_COMPLETED_MS);

    expect(run.hostAtCalls).toEqual([
      expect.objectContaining({ name: BRANCH }),
    ]);
    expect(run.startCalls).toEqual([
      expect.objectContaining({
        options: expect.objectContaining({ name: BRANCH }),
      }),
    ]);
  });

  it("names a parent-cwd pane cow-<type>-<id> without a task slug", async () => {
    const run = launchedRun({});
    await driveRun(DRIVE_COMPLETED_MS);

    const name = "cow-general-purpose-session-1";
    expect(run.hostAtCalls).toEqual([expect.objectContaining({ name })]);
    expect(run.startCalls).toEqual([
      expect.objectContaining({
        options: expect.objectContaining({ name }),
      }),
    ]);
  });

  it("adopts the worktree run's pane without hosting a new one", async () => {
    const fake = makeFakeHost({ observeState: "done" });
    const run = launchedRun({
      taskSlug: "fix-login-flow",
      worktree: { kind: "owned", path: "/wt", branch: BRANCH },
      hostRef: fake.ref,
    });
    await driveRun(DRIVE_COMPLETED_MS);

    expect(run.hostAtCalls).toEqual([]);
    expect(run.startCalls).toEqual([
      expect.objectContaining({
        options: expect.objectContaining({ name: BRANCH }),
      }),
    ]);
  });
});

describe("SubagentSession deferred sandbox allocation", () => {
  const BRANCH = "cow-fix-login-flow-session-1";

  /** A provisioned sandbox as the launch sees it: checkout coordinates plus the adopted pane. */
  function fakeSandbox(ref: AgentHostRef): AgentSandbox {
    return {
      worktree: { path: "/wt", branch: BRANCH },
      hostRef: ref,
    } as unknown as AgentSandbox;
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reserves the checkout while queued and settles a queued abort without a host call", async () => {
    const allocate = vi.spyOn(AgentSandbox, "allocate");
    const fake = makeFakeHost();
    const harness = makeSession({
      host: fake.host,
      ipc: new ScriptedIpc(),
      worktree: { kind: "owned", path: "/wt", branch: BRANCH },
    });

    // Queued: nothing is provisioned, not even the sandbox.
    expect(allocate).not.toHaveBeenCalled();

    await expect(harness.session.abort("user")).resolves.toBe(true);

    expect(allocate).not.toHaveBeenCalled();
    expect(harness.session.spawn.lifecycle).toMatchObject({
      phase: "never-started",
      status: "stopped",
    });
    expect(fake.hostAtCalls).toEqual([]);
    expect(fake.startCalls).toEqual([]);
  });

  it("provisions the checkout on start and launches the child into its pane", async () => {
    const fake = makeFakeHost({ observeState: "done" });
    const allocate = vi
      .spyOn(AgentSandbox, "allocate")
      .mockResolvedValue(fakeSandbox(fake.ref));
    const harness = makeSession({
      host: fake.host,
      ipc: new ScriptedIpc({ deliverable: "the final answer" }),
      worktree: { kind: "owned", path: "/wt", branch: BRANCH },
    });

    harness.session.start();
    await driveRun(DRIVE_COMPLETED_MS);

    expect(allocate).toHaveBeenCalledTimes(1);
    expect(allocate.mock.calls[0]![1]).toMatchObject({
      naming: {
        kind: "generated",
        taskSlug: "general-purpose",
        id: "session-1",
      },
      host: fake.host,
    });
    // The sandbox adopted the pane, so the launch hosts no second one.
    expect(fake.hostAtCalls).toEqual([]);
    expect(fake.startCalls).toEqual([
      expect.objectContaining({
        options: expect.objectContaining({ name: BRANCH }),
      }),
    ]);
    expect(harness.session.spawn.lifecycle).toMatchObject({
      phase: "settled",
      status: "completed",
      result: "the final answer",
    });
  });
});

describe("SubagentSession worktree retention capture", () => {
  const WORKTREE_PATH =
    "/work/.herdr-subagents/repo/cow-fix-login-flow-01234567";
  const WORKTREE_BRANCH = "cow-fix-login-flow-01234567";

  function completedRun(statusStdout: string) {
    getPiInstanceMock.mockReturnValue({
      exec: async (_cmd: string, args: string[]) => {
        if (args[0] === "status") {
          return { code: 0, stdout: statusStdout, stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    } as never);
    const fake = makeFakeHost({ observeState: "done" });
    const harness = makeSession({
      host: fake.host,
      ipc: new ScriptedIpc({
        deliverable: "the final answer",
      }),
      hostRef: fake.ref,
      worktree: { kind: "owned", path: WORKTREE_PATH, branch: WORKTREE_BRANCH },
    });
    // The probe reads the worktree path directly; no captured spawn context is involved.
    return { ...fake, ...harness };
  }

  it("captures why a dirty owned worktree is kept, so the result note is truthful", async () => {
    const run = completedRun(" M desktop/package.json\n");
    run.session.start();
    await driveRun(DRIVE_COMPLETED_MS);

    expect(run.session.spawn.lifecycle).toMatchObject({
      phase: "settled",
      status: "completed",
      result: "the final answer",
    });
    expect(settledExecution(run.session.spawn).worktreeRetentionReason).toEqual(
      {
        kind: "dirty",
      },
    );
    const note = formatResultContent(run.session.spawn);
    expect(note).toContain("KEPT: has uncommitted changes");
    expect(note).toContain(`(branch ${WORKTREE_BRANCH})`);
    expect(note).toContain("cleanup_cowboy_agent");
    // Stay-alive: the note says the pane stays, never hints auto-removal.
    expect(note).toContain(
      "The agent process and its herdr pane stay until you call cleanup_cowboy_agent",
    );
    expect(note).not.toMatch(/\bauto/i);
    expect(note).not.toContain("removed by cleanup_cowboy_agent");
  });

  it("records a dirty reason for an owned worktree with no captured spawn context", async () => {
    const run = completedRun(" M desktop/package.json\n");
    // The probe takes the worktree path, so retention reaches the settled
    // execution without a captured spawn context.
    expect(run.session.spawn.execution.spawnCtx).toBeUndefined();
    run.session.start();
    await driveRun(DRIVE_COMPLETED_MS);

    expect(settledExecution(run.session.spawn).worktreeRetentionReason).toEqual(
      {
        kind: "dirty",
      },
    );
  });

  it("keeps the default removal note for a clean merged worktree", async () => {
    const run = completedRun("");
    run.session.start();
    await driveRun(DRIVE_COMPLETED_MS);

    expect(
      settledExecution(run.session.spawn).worktreeRetentionReason,
    ).toBeUndefined();
    const note = formatResultContent(run.session.spawn);
    expect(note).toContain(`(branch ${WORKTREE_BRANCH})`);
    expect(note).toContain("cleanup_cowboy_agent to remove it");
    // Stay-alive: the note says the pane stays, never hints auto-removal.
    expect(note).toContain(
      "The agent process and its herdr pane stay until you call cleanup_cowboy_agent",
    );
    expect(note).not.toMatch(/\bauto/i);
  });

  it("omits the stay-alive consequence for a stopped settle (process gone, pane kept)", () => {
    const spawn = buildAgentSpawn(
      {
        pi: {} as never,
        ctx: {} as never,
        type: "general-purpose",
        prompt: "test run",
        options: {
          description: "test run",
          spawnId: "sess-test-2",
          orchestration: TEST_ORCHESTRATION,
          worktree: {
            kind: "owned",
            path: WORKTREE_PATH,
            branch: WORKTREE_BRANCH,
          },
        },
      },
      Promise.resolve(""),
    );
    spawn.lifecycle = {
      phase: "settled",
      startedAt: 1_700_000_000_000,
      status: "stopped",
      completedAt: 1_700_000_010_000,
      stop: { initiator: "user" },
    };
    const note = formatResultContent(spawn);
    // Stopped is interrupt-only: process ends, pane survives.
    expect(note).toContain("cleanup_cowboy_agent to remove it");
    expect(note).not.toContain("agent process");
  });
});

/** Stop, steer, dispose, stats, and start-failure projection. */
describe("SubagentSession routing and projection", () => {
  it("cancels the queue entry on a queued stop and never releases the slot", async () => {
    const fake = makeFakeHost();
    const harness = makeSession({
      host: fake.host,
      ipc: new ScriptedIpc(),
    });

    await expect(harness.session.abort("agent")).resolves.toBe(true);
    await expect(harness.session.promise).resolves.toBe("");
    expect(harness.cancelledQueued).toEqual(["session-1"]);
    expect(harness.releasedSlots).toEqual([]);
    expect(fake.stopCalls).toEqual([]);
    expect(harness.session.spawn.lifecycle).toMatchObject({
      phase: "never-started",
      status: "stopped",
      stop: { initiator: "agent" },
    });
    expect(harness.session.spawn.lifecycle.phase).toBe("never-started");
  });

  it("stops a spawned session, settles it as stopped, and releases the slot", async () => {
    const fake = makeFakeHost({ observeState: "working" });
    const harness = makeSession({
      host: fake.host,
      ipc: new ScriptedIpc(),
      hostRef: fake.ref,
    });
    harness.session.start();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.session.isActive()).toBe(true);

    await expect(harness.session.abort("agent")).resolves.toBe(true);

    await expect(harness.session.promise).resolves.toBe("");
    expect(harness.session.spawn.lifecycle).toMatchObject({
      phase: "settled",
      status: "stopped",
      stop: { initiator: "agent" },
    });
    expect(harness.session.spawn.lifecycle.phase).toBe("settled");
    expect(fake.stopCalls).toEqual([
      { ref: fake.ref, options: { interruptGraceMs: 2_000, confirmMs: 0 } },
    ]);
    expect(harness.releasedSlots).toEqual(["session-1"]);
  });

  it("refuses steer while queued, and delivers to a spawned run as it is", async () => {
    const fake = makeFakeHost({ observeState: "working" });
    const harness = makeSession({
      host: fake.host,
      ipc: new ScriptedIpc({
        deliverable: "the final answer",
      }),
      hostRef: fake.ref,
    });

    await expect(harness.session.steer("queued message")).resolves.toEqual({
      kind: "refused",
      reason: expect.stringContaining("queued"),
    });
    expect(fake.deliverCalls).toEqual([]);

    harness.session.start();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();
    await expect(harness.session.steer("working message")).resolves.toEqual({
      kind: "delivered",
    });
    expect(fake.deliverCalls).toEqual([
      { ref: fake.ref, message: "working message" },
    ]);
    // Spawned steer is delivery only.
    expect(harness.session.isActive()).toBe(true);
    expect(fake.startCalls).toHaveLength(1);
  });

  it("refuses steer when the agent's pane is gone", async () => {
    const harness = makeSession({
      host: makeFakeHost().host,
      ipc: new ScriptedIpc(),
    });
    // Queued stop settles without ever obtaining a pane.
    await harness.session.abort("user");
    expect(harness.session.isSettled()).toBe(true);

    await expect(harness.session.steer("anyone there?")).resolves.toEqual({
      kind: "refused",
      reason: expect.stringContaining("never started"),
    });
  });

  it("refuses steer mid-launch without blaming cleanup", async () => {
    const fake = makeFakeHost();
    const harness = makeSession({ host: fake.host, ipc: new ScriptedIpc() });

    // Steering before the launch reaches hostAt: the run is on its way up and
    // its pane does not exist yet, so nothing was cleaned up.
    harness.session.start();
    expect(harness.session.spawn.lifecycle.phase).toBe("spawned");

    await expect(harness.session.steer("too early")).resolves.toEqual({
      kind: "refused",
      reason: expect.stringContaining("still starting up"),
    });
    expect(fake.deliverCalls).toEqual([]);
  });

  it("refuses steer when a settled agent's placement is gone", async () => {
    const run = completedRun();
    run.session.start();
    await driveRun(DRIVE_COMPLETED_MS);
    expect(run.session.isSettled()).toBe(true);
    // Cleanup dropped the placement; the spawn stays listed and cleanable.
    run.session.spawn.execution.host = undefined;

    await expect(run.session.steer("keep going")).resolves.toEqual({
      kind: "refused",
      reason: expect.stringContaining("has no pane"),
    });
    expect(run.session.isSettled()).toBe(true);
    expect(run.deliverCalls).toEqual([]);
  });

  it("refuses steer when the host refuses the delivery", async () => {
    const fake = makeFakeHost({ observeState: "working" });
    const harness = makeSession({
      host: {
        ...fake.host,
        deliver: async () => ({
          kind: "not-submitted",
          detail: "its pane did not accept the message",
        }),
      } as AgentHost,
      ipc: new ScriptedIpc(),
      hostRef: fake.ref,
    });
    harness.session.start();
    await driveRun(0);

    // The refusal carries the host's detail, so the caller can tell which half
    // failed and whether the text is sitting unsubmitted in the pane.
    await expect(harness.session.steer("hello")).resolves.toEqual({
      kind: "refused",
      reason: expect.stringContaining("its pane did not accept the message"),
    });
    expect(harness.session.isActive()).toBe(true);
  });

  it("drop() opens the gate without touching the pane", async () => {
    const fake = makeFakeHost();
    const harness = makeSession({
      host: fake.host,
      ipc: new ScriptedIpc(),
    });

    harness.session.drop();

    await expect(harness.session.promise).resolves.toBe("");
    expect(fake.stopCalls).toEqual([]);
  });

  it("settleForDispose projects a queued session as never-started and never stops a pane", async () => {
    const fake = makeFakeHost();
    const harness = makeSession({
      host: fake.host,
      ipc: new ScriptedIpc(),
    });

    harness.session.settleForDispose();

    await expect(harness.session.promise).resolves.toBe("");
    expect(harness.session.spawn.lifecycle).toMatchObject({
      phase: "never-started",
      status: "error",
      error: DISPOSE_QUEUED_MESSAGE,
    });
    expect(fake.stopCalls).toEqual([]);
  });

  it("settleForDispose opens the gate of a live session without stopping it", async () => {
    const fake = makeFakeHost({ observeState: "working" });
    const harness = makeSession({
      host: fake.host,
      ipc: new ScriptedIpc(),
      hostRef: fake.ref,
    });
    harness.session.start();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.session.isActive()).toBe(true);

    harness.session.settleForDispose();

    // Disposal is not the run's stop: the run stays spawned.
    await expect(harness.session.promise).resolves.toBe("");
    expect(harness.session.spawn.lifecycle).toMatchObject({
      phase: "spawned",
    });
    expect(fake.stopCalls).toEqual([]);
  });

  it("settleStartFailure from Queued projects a never-started error and retains the slot", async () => {
    const harness = makeSession({
      host: makeFakeHost().host,
      ipc: new ScriptedIpc(),
    });

    harness.session.settleStartFailure(new Error("launch exploded"));

    await expect(harness.session.promise).resolves.toBe("");
    expect(harness.session.spawn.lifecycle).toMatchObject({
      phase: "never-started",
      status: "error",
      error: "launch exploded",
    });
    expect(harness.session.spawn.lifecycle).toHaveProperty("queuedAt");
    expect(harness.session.spawn.lifecycle).not.toHaveProperty("startedAt");
    expect(harness.ends).toEqual([harness.session.spawn]);
    // Asymmetric: the manager's direct-spawn rollback owns the slot release.
    expect(harness.releasedSlots).toEqual([]);
  });

  it("settleStartFailure from Launching settles, not never-started, keeping its start time", async () => {
    const fake = makeFakeHost();
    const harness = makeSession({
      host: fake.host,
      ipc: new ScriptedIpc(),
      hostRef: fake.ref,
    });
    harness.session.start();
    expect(harness.session.isLaunching()).toBe(true);

    harness.session.settleStartFailure(new Error("start boom"));

    await expect(harness.session.promise).resolves.toBe("");
    expect(harness.session.spawn.lifecycle).toMatchObject({
      phase: "settled",
      status: "error",
      error: "start boom",
    });
    expect(harness.session.spawn.lifecycle).toHaveProperty("startedAt");
    expect(harness.session.spawn.lifecycle).not.toHaveProperty("queuedAt");
    expect(harness.ends).toEqual([harness.session.spawn]);
    expect(harness.releasedSlots).toEqual([]);
  });
});

/** Disposal ends the supervisor's poll loop too — abandon, not stop. */
describe("SubagentSession settleForDispose abandons the supervisor", () => {
  it("stops polling after disposal while leaving the pane and artifacts alone", async () => {
    const fake = makeFakeHost();
    const ipc = new ScriptedIpc();
    // Count the poll loop through its one external call, the artifact read.
    let reads = 0;
    const read = ipc.readDeliverable.bind(ipc);
    ipc.readDeliverable = async () => {
      reads += 1;
      return read();
    };
    const harness = makeSession({
      host: fake.host,
      ipc,
      hostRef: fake.ref,
    });
    harness.session.start();
    await driveRun(2_000); // one poll: the report is held for confirmation
    const pollsBefore = reads;
    expect(pollsBefore).toBeGreaterThan(0);

    harness.session.settleForDispose();
    await driveRun(20_000); // would settle + keep leaking the interval if not abandoned

    expect(reads).toBe(pollsBefore);
    // No settlement, no stop: the run and its pane survive.
    expect(fake.stopCalls).toEqual([]);
    await expect(harness.session.promise).resolves.toBe("");
    expect(harness.session.spawn.lifecycle).toMatchObject({
      phase: "spawned",
    });
  });
});

/**
 * A settled run keeps its pane, so the same watch keeps reading its report: a
 * later turn is news for the manager rather than a second settlement.
 */
describe("SubagentSession reports after settlement", () => {
  it("hands a settled run's later report to the follow-up seam", async () => {
    const followUps: Array<{ id: string; deliverable: string }> = [];
    const fake = makeFakeHost({ observeState: "done" });
    const ipc = new ScriptedIpc();
    const harness = makeSession({
      host: fake.host,
      ipc,
      hostRef: fake.ref,
      onFollowUpResult: (spawn, deliverable) =>
        followUps.push({ id: spawn.id, deliverable }),
    });
    harness.session.start();
    await driveRun(DRIVE_COMPLETED_MS);
    await expect(harness.session.promise).resolves.toBe("done");
    expect(followUps).toEqual([]);

    // The run's pane lives on: the report it writes next is a follow-up.
    ipc.write("a second turn");
    await driveRun(DRIVE_COMPLETED_MS);

    expect(followUps).toEqual([
      { id: "session-1", deliverable: "a second turn" },
    ]);
    // The follow-up never disturbs the run's own settlement.
    expect(harness.session.spawn.lifecycle).toMatchObject({
      phase: "settled",
      status: "completed",
      result: "done",
    });
  });

  it("stops reporting once the spawn is dropped", async () => {
    const followUps: string[] = [];
    const fake = makeFakeHost({ observeState: "done" });
    const ipc = new ScriptedIpc();
    const harness = makeSession({
      host: fake.host,
      ipc,
      hostRef: fake.ref,
      onFollowUpResult: (_spawn, deliverable) => followUps.push(deliverable),
    });
    harness.session.start();
    await driveRun(DRIVE_COMPLETED_MS);
    harness.session.drop();

    ipc.write("too late");
    await driveRun(20_000);

    expect(followUps).toEqual([]);
  });
});

/** Steer on settled revives: adopt the pane, settle again through the same path. */
describe("SubagentSession revive on steer", () => {
  it("revives a settled run into an active one and settles again", async () => {
    const settledRuns: AgentSpawn[] = [];
    const run = completedRun({
      onRunEnded: (spawn) => settledRuns.push(spawn),
    });
    run.session.start();
    await driveRun(DRIVE_COMPLETED_MS);

    expect(settledRuns).toHaveLength(1);
    expect(run.session.spawn.lifecycle).toMatchObject({
      phase: "settled",
      status: "completed",
      result: "the final answer",
    });
    expect(run.session.spawn.lifecycle.phase).toBe("settled");

    await expect(run.session.steer("one more thing")).resolves.toEqual({
      kind: "delivered",
    });

    // Delivered, then revived off the state snapshotted before the delivery.
    expect(run.deliverCalls.at(-1)).toEqual({
      ref: run.ref,
      message: "one more thing",
    });
    // Revived: active again, outcome dropped.
    expect(run.session.isActive()).toBe(true);
    expect(run.session.spawn.lifecycle).toMatchObject({
      phase: "spawned",
      startedAt: expect.any(Number),
      // The revive resumes the settled turn's own launch.
      launch: expect.objectContaining({ resultFile: expect.any(String) }),
    });
    expect(run.session.isSettled()).toBe(false);
    // No second launch, no interrupt: the pane was adopted.
    expect(run.startCalls).toHaveLength(1);
    expect(run.stopCalls).toEqual([]);

    // Second settlement repeats release + completion nudge.
    await driveRun(DRIVE_COMPLETED_MS);
    expect(run.session.isSettled()).toBe(true);
    expect(run.session.spawn.lifecycle).toMatchObject({
      phase: "settled",
      status: "completed",
      result: "the final answer",
    });
    expect(settledRuns).toHaveLength(2);
    expect(settledRuns[1]).toBe(run.session.spawn);
    expect(run.releasedSlots).toEqual(["session-1", "session-1"]);
  });

  it("charges the run's pools again when a settled turn revives", async () => {
    const fake = makeFakeHost({ observeState: "done" });
    const run = makeSession({
      host: fake.host,
      ipc: new ScriptedIpc({ deliverable: "the final answer" }),
      hostRef: fake.ref,
      options: { modelSelection: selectionFor("acme/fast") },
    });
    run.session.start(makeReservation());
    await driveRun(DRIVE_COMPLETED_MS);

    // Settlement gave the pools back, so the revived turn has to take them again.
    expect(run.releasedSlots).toEqual(["session-1"]);
    expect(run.reacquired).toEqual([]);

    await expect(run.session.steer("one more thing")).resolves.toEqual({
      kind: "delivered",
    });
    expect(run.session.isActive()).toBe(true);
    expect(run.reacquired).toEqual([
      { id: "session-1", modelKey: "acme/fast" },
    ]);

    // The second settlement gives the same pools back again.
    await driveRun(DRIVE_COMPLETED_MS);
    expect(run.releasedSlots).toEqual(["session-1", "session-1"]);
  });

  it("reports a revive that throws instead of throwing", async () => {
    const run = completedRun();
    run.session.start();
    await driveRun(DRIVE_COMPLETED_MS);
    expect(run.session.isSettled()).toBe(true);

    // The revive's filesystem work fails: the message is already in the pane.
    resultDirGate.fail = true;
    try {
      await expect(run.session.steer("one more thing")).resolves.toEqual({
        kind: "delivered-not-revived",
        reason: expect.stringContaining("EACCES"),
      });
    } finally {
      resultDirGate.fail = false;
    }
    // The message landed, so the run stays settled and nothing is left watching.
    expect(run.deliverCalls.at(-1)?.message).toBe("one more thing");
    expect(run.session.isSettled()).toBe(true);
    // A revive that never happened charges nothing: the run is not live.
    expect(run.reacquired).toEqual([]);
  });

  it("clears a retention reason captured by the settled run", async () => {
    const run = completedRun();
    run.session.spawn.display.worktree = {
      kind: "owned",
      path: "/work/repo/cow-fix-login-01234567",
      branch: "cow-fix-login-01234567",
    };
    getPiInstanceMock.mockReturnValue({
      exec: async (_cmd: string, args: string[]) =>
        args[0] === "status"
          ? { code: 0, stdout: " M desktop/package.json\n", stderr: "" }
          : { code: 0, stdout: "", stderr: "" },
    } as never);
    run.session.start();
    await driveRun(DRIVE_COMPLETED_MS);
    expect(settledExecution(run.session.spawn).worktreeRetentionReason).toEqual(
      {
        kind: "dirty",
      },
    );

    await expect(run.session.steer("keep going")).resolves.toEqual({
      kind: "delivered",
    });

    // Stale reason must not survive: the revived run is live again, where no
    // retention reason exists to be stale.
    expect(run.session.spawn.lifecycle.phase).toBe("spawned");
  });

  it("recreates the result directory so the revived run settles on its NEW report", async () => {
    const fake = makeFakeHost({ observeState: "working" });
    // Real file-plane IPC: the deliverable must come from disk, not a script.
    const resultFile = path.join(resultDir, "result.md");
    const ipc = new HerdrSubagentIPC({
      agentId: "session-readiness",
      resultFile,
    });
    const harness = makeSession({ host: fake.host, ipc, hostRef: fake.ref });
    harness.session.start();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();

    fs.writeFileSync(resultFile, "FIRST REPORT");
    await driveRun(DRIVE_COMPLETED_MS);
    expect(harness.session.spawn.lifecycle).toMatchObject({
      phase: "settled",
      status: "completed",
      result: "FIRST REPORT",
    });

    // The previous run's stale report must not settle the revived run.
    fs.mkdirSync(path.dirname(resultFile), { recursive: true });
    fs.writeFileSync(resultFile, "FIRST REPORT");

    await expect(harness.session.steer("continue")).resolves.toEqual({
      kind: "delivered",
    });

    expect(fs.existsSync(path.dirname(resultFile))).toBe(true);
    expect(fs.existsSync(resultFile)).toBe(false);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(harness.session.isActive()).toBe(true);

    fs.writeFileSync(resultFile, "SECOND REPORT");
    await driveRun(DRIVE_COMPLETED_MS);
    expect(harness.session.spawn.lifecycle).toMatchObject({
      phase: "settled",
      status: "completed",
      result: "SECOND REPORT",
    });
  });

  it("re-binds the parent abort signal so a revived run is stoppable", async () => {
    const controller = new AbortController();
    const fake = makeFakeHost({ observeState: "working" });
    const harness = makeSession({
      host: fake.host,
      ipc: new ScriptedIpc({
        deliverable: "the final answer",
      }),
      hostRef: fake.ref,
      options: { signal: controller.signal },
    });
    harness.session.start();
    await driveRun(DRIVE_COMPLETED_MS);
    expect(harness.session.isSettled()).toBe(true);

    await expect(harness.session.steer("keep going")).resolves.toEqual({
      kind: "delivered",
    });
    expect(harness.session.isActive()).toBe(true);

    controller.abort();
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);

    expect(harness.session.spawn.lifecycle).toMatchObject({
      phase: "settled",
      status: "stopped",
      stop: { initiator: "user" },
    });
    expect(fake.stopCalls).toHaveLength(1);
  });

  it("skips re-binding a parent signal that already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const fake = makeFakeHost({ observeState: "working" });
    const harness = makeSession({
      host: fake.host,
      ipc: new ScriptedIpc({
        deliverable: "the final answer",
      }),
      hostRef: fake.ref,
      options: { signal: controller.signal },
    });
    harness.session.start();
    await driveRun(DRIVE_COMPLETED_MS);

    await expect(harness.session.steer("keep going")).resolves.toEqual({
      kind: "delivered",
    });

    // An already-fired parent abort is not re-armed on revive.
    expect(harness.session.isActive()).toBe(true);
    expect(fake.stopCalls).toEqual([]);
  });
});

/** Steer inside the settle pass: the terminal is decided, so the run reads settled. */
describe("SubagentSession steer inside the settle pass", () => {
  const WORKTREE_PATH =
    "/work/.herdr-subagents/repo/cow-fix-login-flow-01234567";
  const WORKTREE_BRANCH = "cow-fix-login-flow-01234567";

  interface HeldProbe {
    release: () => void;
    probeCount: () => number;
  }

  /** The first retention probe hangs until released; later probes answer dirty. */
  function holdFirstProbe(): HeldProbe {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let count = 0;
    getPiInstanceMock.mockReturnValue({
      exec: async (_cmd: string, args: string[]) => {
        if (args[0] === "status") {
          count += 1;
          if (count === 1) await held;
          return {
            code: 0,
            stdout: " M desktop/package.json\n",
            stderr: "",
          };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    } as never);
    return {
      release,
      probeCount: () => count,
    };
  }

  function settlingRun(
    options: {
      signal?: AbortSignal;
      onRunEnded?: (spawn: AgentSpawn) => void;
    } = {},
  ) {
    const fake = makeFakeHost({ observeState: "done" });
    const harness = makeSession({
      host: fake.host,
      ipc: new ScriptedIpc({
        deliverable: "the final answer",
      }),
      hostRef: fake.ref,
      worktree: { kind: "owned", path: WORKTREE_PATH, branch: WORKTREE_BRANCH },
      options: options.signal ? { signal: options.signal } : undefined,
      onRunEnded: options.onRunEnded,
    });
    // The held probe reads the worktree path directly; no captured spawn context is involved.
    return { ...fake, ...harness };
  }

  /** Drive until the first settle pass hangs inside its retention probe. */
  async function driveIntoPass(
    run: Pick<ReturnType<typeof settlingRun>, "session">,
    probe: HeldProbe,
  ): Promise<void> {
    run.session.start();
    await driveRun(DRIVE_COMPLETED_MS);
    expect(probe.probeCount()).toBe(1);
    // The terminal is decided, so the run reads settled while the pass runs.
    expect(run.session.isSettled()).toBe(true);
  }

  it("a steer landing mid-pass delivers settled and revives the next turn", async () => {
    const controller = new AbortController();
    const settledRuns: AgentSpawn[] = [];
    const run = settlingRun({
      signal: controller.signal,
      onRunEnded: (spawn) => {
        settledRuns.push(spawn);
      },
    });
    const probe = holdFirstProbe();
    await driveIntoPass(run, probe);

    await expect(run.session.steer("one more thing")).resolves.toEqual({
      kind: "delivered",
    });

    // Delivered during the settle pass, then revived with a clean slate.
    expect(run.deliverCalls.at(-1)).toEqual({
      ref: run.ref,
      message: "one more thing",
    });
    expect(run.session.isActive()).toBe(true);
    expect(run.session.spawn.lifecycle).toMatchObject({
      phase: "spawned",
      startedAt: expect.any(Number),
      // The revive resumes the settled turn's own launch.
      launch: expect.objectContaining({ resultFile: expect.any(String) }),
    });
    expect(run.session.isSettled()).toBe(false);
    // The revived run's first turn settled nothing, so it holds no retention reason.
    expect(run.session.spawn.lifecycle.phase).toBe("spawned");

    // Hold the revived run open so the first pass tail lands alone.
    run.setObserveState("working");
    probe.release();
    await driveRun(2_000);

    // The first pass published nothing onto the revived run...
    expect(run.session.isActive()).toBe(true);
    expect(run.session.spawn.lifecycle.phase).toBe("spawned");
    expect(run.session.spawn.lifecycle.phase).toBe("spawned");
    // ...while its once-only effects still happened exactly once.
    expect(run.releasedSlots).toEqual(["session-1"]);
    expect(settledRuns).toEqual([run.session.spawn]);
    await expect(run.session.promise).resolves.toBe("the final answer");

    // The revived run's parent binding survived the first pass tail.
    controller.abort();
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(run.session.spawn.lifecycle).toMatchObject({
      phase: "settled",
      status: "stopped",
      stop: { initiator: "user" },
    });
    expect(run.stopCalls).toHaveLength(1);
  });

  it("the first settlement's once-only effects happen exactly once across the revive", async () => {
    const settledRuns: AgentSpawn[] = [];
    const run = settlingRun({
      onRunEnded: (spawn) => {
        settledRuns.push(spawn);
      },
    });
    const probe = holdFirstProbe();
    await driveIntoPass(run, probe);

    await expect(run.session.steer("one more thing")).resolves.toEqual({
      kind: "delivered",
    });
    run.setObserveState("working");
    probe.release();
    await driveRun(2_000);

    expect(run.releasedSlots).toEqual(["session-1"]);
    expect(settledRuns).toEqual([run.session.spawn]);

    // The revived run settles on its own report: release and nudge repeat once.
    run.setObserveState("done");
    await driveRun(DRIVE_COMPLETED_MS);

    expect(run.session.isSettled()).toBe(true);
    expect(run.session.spawn.lifecycle).toMatchObject({
      phase: "settled",
      status: "completed",
      result: "the final answer",
    });
    expect(run.releasedSlots).toEqual(["session-1", "session-1"]);
    expect(settledRuns).toEqual([run.session.spawn, run.session.spawn]);
    // The gate keeps the first run's result.
    await expect(run.session.promise).resolves.toBe("the final answer");
    expect(run.session.spawn.lifecycle.phase).toBe("settled");
  });

  it("a second settlement waits for the in-flight pass instead of running concurrently", async () => {
    const settledRuns: AgentSpawn[] = [];
    const run = settlingRun({
      onRunEnded: (spawn) => {
        settledRuns.push(spawn);
      },
    });
    const probe = holdFirstProbe();
    await driveIntoPass(run, probe);

    await expect(run.session.steer("one more thing")).resolves.toEqual({
      kind: "delivered",
    });

    // The revived run reports while the first pass is still held: the second
    // settlement must not start its own probe, release, or nudge yet.
    await driveRun(DRIVE_COMPLETED_MS);
    expect(probe.probeCount()).toBe(1);
    expect(run.releasedSlots).toEqual([]);
    expect(settledRuns).toEqual([]);

    probe.release();
    await driveRun(DRIVE_COMPLETED_MS);

    expect(probe.probeCount()).toBe(2);
    expect(run.releasedSlots).toEqual(["session-1", "session-1"]);
    expect(settledRuns).toEqual([run.session.spawn, run.session.spawn]);
    expect(run.session.isSettled()).toBe(true);
    await expect(run.session.promise).resolves.toBe("the final answer");
  });
});

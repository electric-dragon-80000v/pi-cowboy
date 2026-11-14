/**
 * spawn-attach.test.ts — turning an adopted record into a session this process
 * can drive.
 *
 * The subject is the seam, not a launch: an attached run is adopted in place, so
 * every case here asserts `start` was never called. The manager cases then show
 * that stop reaches the record's pane and that an id the verifier did not vouch
 * for is refused.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agents/agent-manager.js";
import { AgentSpawnStore } from "../src/agents/agent-spawn-store.js";
import {
  createSpawnJournal,
  SPAWN_JOURNAL_CUSTOM_TYPE,
} from "../src/agents/spawn-journal.js";
import { SubagentSession } from "../src/agents/subagent-session.js";
import { ConcurrencyPools } from "../src/concurrency-pools.js";
import type { AgentHost, AgentHostRef } from "../src/agents/agent-host.js";
import type { DeliverableSource } from "../src/subagent/deliverable.js";
import type { SupervisorTransport } from "../src/subagent/pane-supervisor.js";
import type { AgentSpawn, AgentLifecycleState } from "../src/types.js";
import { TEST_ORCHESTRATION } from "./helpers/orchestration.js";
import { TEST_PANE, TEST_PLACEMENTS } from "./helpers/pane-control.js";

const { getPiInstanceMock, getStoreMock, getAgentSpawnsMock } = vi.hoisted(
  () => ({
    getPiInstanceMock: vi.fn(() => ({}) as never),
    getStoreMock: vi.fn(() => ({ agent: {} })),
    getAgentSpawnsMock: vi.fn(),
  }),
);

// The store is created per test so each case starts from its own fleet.
const store = new AgentSpawnStore();
getAgentSpawnsMock.mockImplementation(() => store);

vi.mock("../src/shell.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/shell.js")>()),
  getPiInstance: getPiInstanceMock,
  getStore: getStoreMock,
  getAgentSpawns: getAgentSpawnsMock,
  getSessionCtx: () => ({ cwd: "/repo", hasUI: false }) as never,
  getHarnessRegistry: () =>
    ({
      get: () => ({ steer: async () => ({ kind: "submitted" }) }),
      require: () => ({ stop: async () => {} }),
    }) as never,
}));

vi.mock("../src/agents/agent-runner.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/agents/agent-runner.js")>()),
  buildLaunchPlan: vi.fn(async () => {
    throw new Error("an attached run must never build a launch plan");
  }),
}));

const REF: AgentHostRef = {
  multiplexer: "herdr",
  name: "cow-task-aaaaaaaa",
  paneId: "w1:p1",
  workspaceId: "w1",
  paneCreated: true,
};

/** A recording host: the assertions read whether it was asked to launch or stop. */
function fakeHost() {
  const startCalls: AgentHostRef[] = [];
  const stopCalls: AgentHostRef[] = [];
  const host = {
    hostAt: async () => REF,
    start: async (ref: AgentHostRef, _options: unknown) => {
      startCalls.push(ref);
    },
    observe: async () => ({ state: "working" as const }),
    waitUntilGone: async (ref: AgentHostRef) => {
      stopCalls.push(ref);
      return true;
    },
    release: async () => true,
  } as unknown as AgentHost;
  return { host, startCalls, stopCalls };
}

/** The store's view of one in-flight run, as a reloaded session would find it. */
function adoptedSpawn(
  over: Partial<AgentSpawn> = {},
  lifecycle: AgentLifecycleState = {
    phase: "spawned",
    startedAt: 1_700_000_000_000,
    launch: { resultFile: "/tmp/pi-cowboy/aaaaaaaa/result.md" },
  },
): AgentSpawn {
  return {
    id: "aaaaaaaa",
    lifecycle,
    display: {
      type: "general-purpose",
      description: "the adopted task",
      taskSlug: "the-adopted-task",
      orchestration: TEST_ORCHESTRATION,
    },
    execution: {
      promise: Promise.resolve(""),
      abortController: new AbortController(),
      history: [],
      host: REF,
      harness: "pi",
    },
    ...over,
  };
}

/** A deliverable that never reports, so an attached watch stays pending. */
const SILENT: DeliverableSource = {
  readDeliverable: async () => null,
};

function transport(host: AgentHost): SupervisorTransport {
  return {
    createHost: () => host,
    createPane: () => TEST_PANE,
    createPlacements: () => TEST_PLACEMENTS,
    createDeliverable: () => SILENT,
  };
}

function attachDeps(host: AgentHost, pools = new ConcurrencyPools()) {
  return {
    transport: transport(host),
    pools,
    onRunEnded: () => {},
    onFollowUpResult: () => {},
  };
}

beforeEach(() => {
  getPiInstanceMock.mockReset().mockReturnValue({} as never);
  getStoreMock.mockReset().mockReturnValue({ agent: {} });
  for (const spawn of store.list()) store.drop(spawn.id);
});

describe("SubagentSession.attach", () => {
  it("adopts the run in place: never launches, binds the record's pane", () => {
    const { host, startCalls } = fakeHost();
    const spawn = adoptedSpawn();
    store.add(spawn);

    const session = SubagentSession.attach({
      spawn,
      harness: "pi",
      deps: attachDeps(host),
    });

    // The process already exists; nothing was launched into the pane.
    expect(startCalls).toEqual([]);
    expect(session.isActive()).toBe(true);
    expect(session.spawn).toBe(spawn);
  });

  it("takes the pools a launched run would hold, including its model pool", () => {
    const { host } = fakeHost();
    const pools = new ConcurrencyPools();
    const reacquired: Array<{
      id: string;
      identity: { harness: string; modelKey: string | undefined };
    }> = [];
    vi.spyOn(pools, "reacquire").mockImplementation((id, identity) => {
      reacquired.push({ id, identity });
    });
    const base = adoptedSpawn();
    store.add({
      ...base,
      execution: { ...base.execution, modelKey: "acme/fast" },
    });

    SubagentSession.attach({
      spawn: store.get("aaaaaaaa")!,
      harness: "pi",
      deps: attachDeps(host, pools),
    });

    expect(reacquired).toEqual([
      { id: "aaaaaaaa", identity: { harness: "pi", modelKey: "acme/fast" } },
    ]);
  });

  it("charges only harness and global pools when the record named no model", () => {
    const { host } = fakeHost();
    const pools = new ConcurrencyPools();
    const reacquired: Array<{ modelKey: string | undefined }> = [];
    vi.spyOn(pools, "reacquire").mockImplementation((_id, identity) => {
      reacquired.push({ modelKey: identity.modelKey });
    });
    const spawn = adoptedSpawn();
    store.add(spawn);

    SubagentSession.attach({
      spawn,
      harness: "pi",
      deps: attachDeps(host, pools),
    });

    expect(reacquired).toEqual([{ modelKey: undefined }]);
  });

  it("resumes the report file the original launch named", () => {
    const { host } = fakeHost();
    const spawn = adoptedSpawn();
    store.add(spawn);
    const deliverables: string[] = [];
    const deps = attachDeps(host);
    deps.transport.createDeliverable = (resultFile: string) => {
      deliverables.push(resultFile);
      return SILENT;
    };

    SubagentSession.attach({ spawn, harness: "pi", deps });

    expect(deliverables).toEqual(["/tmp/pi-cowboy/aaaaaaaa/result.md"]);
  });

  it("falls back to the run's canonical report path when the record has none", () => {
    const { host } = fakeHost();
    const spawn = adoptedSpawn({}, { phase: "spawned", startedAt: 1 });
    store.add(spawn);
    const deliverables: string[] = [];
    const deps = attachDeps(host);
    deps.transport.createDeliverable = (resultFile: string) => {
      deliverables.push(resultFile);
      return SILENT;
    };

    SubagentSession.attach({ spawn, harness: "pi", deps });

    expect(deliverables[0]).toMatch(/aaaaaaaa.*result\.md$/);
  });

  it("refuses a record that names no pane, rather than inventing one", () => {
    const { host } = fakeHost();
    const spawn = adoptedSpawn({
      execution: {
        promise: Promise.resolve(""),
        abortController: new AbortController(),
        history: [],
        harness: "pi",
      },
    });

    expect(() =>
      SubagentSession.attach({ spawn, harness: "pi", deps: attachDeps(host) }),
    ).toThrow(/cannot be attached/);
  });

  it("refuses a record that never started", () => {
    const { host } = fakeHost();
    const spawn = adoptedSpawn({}, { phase: "queued", queuedAt: 1 });

    expect(() =>
      SubagentSession.attach({ spawn, harness: "pi", deps: attachDeps(host) }),
    ).toThrow(/cannot be attached/);
  });
});

describe("AgentManager on a run in flight", () => {
  /** A manager over a recording host; nothing is gated, the spawn state decides. */
  function manager() {
    const { host, startCalls, stopCalls } = fakeHost();
    const built = new AgentManager(new ConcurrencyPools(), transport(host));
    return { manager: built, startCalls, stopCalls };
  }

  it("stops a run it inherited, reaching the recorded pane", async () => {
    store.add(adoptedSpawn());
    const { manager: fleet, startCalls, stopCalls } = manager();
    fleet.attachLiveSpawns();

    await expect(fleet.abort("aaaaaaaa", "user")).resolves.toBe(true);

    expect(startCalls).toEqual([]);
    expect(stopCalls.map((ref) => ref.paneId)).toEqual(["w1:p1"]);
    fleet.dispose();
  });

  it("refuses a run nothing attached, rather than attaching one on demand", async () => {
    store.add(adoptedSpawn());
    const { manager: fleet, startCalls, stopCalls } = manager();

    // No start-up pass ran, so nothing is watched: the manager does not build a
    // session behind the caller's back.
    await expect(fleet.abort("aaaaaaaa", "user")).resolves.toBe(false);
    await expect(fleet.steer("aaaaaaaa", "hello")).resolves.toMatchObject({
      kind: "refused",
    });

    expect(startCalls).toEqual([]);
    expect(stopCalls).toEqual([]);
    fleet.dispose();
  });

  it("attaches once: a second stop reuses the session it built", async () => {
    store.add(adoptedSpawn());
    const { manager: fleet, stopCalls } = manager();
    fleet.attachLiveSpawns();

    await fleet.abort("aaaaaaaa", "user");
    // The first stop settled the run, so a second one has nothing live to stop.
    await fleet.abort("aaaaaaaa", "user");

    expect(stopCalls).toHaveLength(1);
    fleet.dispose();
  });

  it("steers through the recorded pane once it has attached", async () => {
    store.add(adoptedSpawn());
    const { manager: fleet } = manager();
    fleet.attachLiveSpawns();

    await expect(fleet.steer("aaaaaaaa", "keep going")).resolves.toEqual({
      kind: "delivered",
    });

    fleet.dispose();
  });

  it("fills the spawn's notify context from the adopting session", async () => {
    const spawn = adoptedSpawn();
    store.add(spawn);
    expect(spawn.execution.spawnCtx).toBeUndefined();
    const { manager: fleet } = manager();
    fleet.attachLiveSpawns();

    await fleet.abort("aaaaaaaa", "user");

    // A settle nudge from this run reaches the session that adopted it.
    expect(spawn.execution.spawnCtx).toMatchObject({ cwd: "/repo" });
    fleet.dispose();
  });

  it("skips a run in flight it cannot address, leaving it listed", async () => {
    // A spawn with no pane recorded is in flight but unreachable.
    const spawn = adoptedSpawn({
      execution: {
        promise: Promise.resolve(""),
        abortController: new AbortController(),
        history: [],
        harness: "pi",
      },
    });
    store.add(spawn);
    const { manager: fleet, stopCalls } = manager();

    fleet.attachLiveSpawns();

    await expect(fleet.abort("aaaaaaaa", "user")).resolves.toBe(false);
    expect(stopCalls).toEqual([]);
    expect(fleet.getSpawn("aaaaaaaa")).toBeDefined();
    fleet.dispose();
  });

  it("skips a run that already ended", async () => {
    store.add(
      adoptedSpawn(
        {},
        {
          phase: "settled",
          startedAt: 1,
          status: "completed",
          result: "done",
          completedAt: 2,
        },
      ),
    );
    const { manager: fleet, stopCalls } = manager();

    fleet.attachLiveSpawns();

    await expect(fleet.abort("aaaaaaaa", "user")).resolves.toBe(false);
    expect(stopCalls).toEqual([]);
    fleet.dispose();
  });
});

describe("the spawn's own state is what makes a run attachable", () => {
  /** A manager over a recording host, built after whatever the store holds. */
  function fleet() {
    const { host, startCalls, stopCalls } = fakeHost();
    const built = new AgentManager(new ConcurrencyPools(), transport(host));
    return { built, startCalls, stopCalls };
  }

  it("lets a replacement session stop an inherited run it never adopted", async () => {
    // The regression this shape exists for: the agent was spawned in an earlier
    // session of this process, not restored from a journal, so nothing recorded it
    // as "adopted". The store still holds it in flight, which is the whole answer.
    store.add(adoptedSpawn());
    const first = fleet();
    first.built.dispose();

    const second = fleet();
    second.built.attachLiveSpawns();

    await expect(second.built.abort("aaaaaaaa", "user")).resolves.toBe(true);
    expect(second.stopCalls.map((ref) => ref.paneId)).toEqual(["w1:p1"]);
    second.built.dispose();
  });

  it("takes every run in flight under watch, without a stop or a steer", () => {
    store.add(adoptedSpawn());
    const { built, startCalls, stopCalls } = fleet();

    built.attachLiveSpawns();

    // Watching is not driving: nothing launched, nothing stopped.
    expect(startCalls).toEqual([]);
    expect(stopCalls).toEqual([]);
    built.dispose();
  });

  it("does not attach the same run twice", async () => {
    store.add(adoptedSpawn());
    const { built, stopCalls } = fleet();

    built.attachLiveSpawns();
    built.attachLiveSpawns();
    await built.abort("aaaaaaaa", "user");

    expect(stopCalls).toHaveLength(1);
    built.dispose();
  });

  it("attaches nothing to a run that is queued, settled, or ended unstarted", async () => {
    store.add(adoptedSpawn({}, { phase: "queued", queuedAt: 1 }));
    store.add(
      adoptedSpawn(
        { id: "bbbbbbbb" },
        {
          phase: "settled",
          startedAt: 1,
          status: "completed",
          result: "done",
          completedAt: 2,
        },
      ),
    );
    store.add(
      adoptedSpawn(
        { id: "cccccccc" },
        {
          phase: "never-started",
          queuedAt: 1,
          status: "error",
          error: "gone",
          completedAt: 2,
        },
      ),
    );
    const { built, stopCalls } = fleet();

    built.attachLiveSpawns();

    await expect(built.abort("aaaaaaaa", "user")).resolves.toBe(false);
    await expect(built.abort("bbbbbbbb", "user")).resolves.toBe(false);
    await expect(built.abort("cccccccc", "user")).resolves.toBe(false);
    expect(stopCalls).toEqual([]);
    built.dispose();
  });
});

describe("attaching does not grow the session file", () => {
  it("writes no journal entry for a re-attach that changes nothing", async () => {
    vi.useFakeTimers();
    const { host } = fakeHost();
    const recorded: string[] = [];
    store.add(adoptedSpawn());
    const built = new AgentManager(new ConcurrencyPools(), transport(host));

    // The real journal, over a branch that already holds this spawn's record: the
    // dedup that keeps a reload from growing the file is its, not the store's.
    const branch: unknown[] = [];
    const appended: unknown[] = [];
    const journal = createSpawnJournal({
      append: (entry) => {
        branch.push({
          type: "custom",
          customType: SPAWN_JOURNAL_CUSTOM_TYPE,
          data: entry,
        });
        appended.push(entry);
      },
      readBranch: () => branch,
      now: () => 1_000,
    });
    journal.record(store.get("aaaaaaaa")!);
    journal.replay();
    store.setObserver(journal);

    built.attachLiveSpawns();

    // Attaching an already-active run moves nothing, so nothing is published; and
    // the one entry written before the reload is the only one on the branch.
    expect(recorded).toEqual([]);
    expect(appended).toHaveLength(1);

    built.dispose();
    store.setObserver(null);
    vi.useRealTimers();
  });
});

describe("an eagerly attached run reports on its own", () => {
  it("settles from the report it writes after the session adopts it", async () => {
    vi.useFakeTimers();
    const { host } = fakeHost();
    // Nothing on disk when the session adopts; the run's next write is the news.
    let report: { content: string; mtime: number } | null = null;
    const ended: string[] = [];
    store.add(adoptedSpawn());
    const built = new AgentManager(new ConcurrencyPools(), {
      ...transport(host),
      createDeliverable: () => ({ readDeliverable: async () => report }),
    });
    built.setOnComplete((settled) => ended.push(settled.lifecycle.phase));

    built.attachLiveSpawns();
    // The run keeps working and writes its result once the watch is running.
    report = { content: "finished", mtime: 1 };
    // Two confirm polls, which is how a report becomes final.
    await vi.advanceTimersByTimeAsync(4_500);

    expect(ended).toEqual(["settled"]);
    expect(built.getSpawn("aaaaaaaa")?.lifecycle).toMatchObject({
      phase: "settled",
      status: "completed",
      result: "finished",
    });
    built.dispose();
    vi.useRealTimers();
  });

  it("settles on a report the previous session never delivered", async () => {
    vi.useFakeTimers();
    const { host } = fakeHost();
    // The child finished and wrote its report, and the session reloaded inside the
    // confirm window — before that report was ever handed to a parent. The record
    // is still `spawned`, which is the proof: settlement is what delivers. Swallowing
    // the file would leave a finished run stuck forever.
    const report = { content: "the answer nobody saw", mtime: 1 };
    const ended: string[] = [];
    store.add(adoptedSpawn());
    const built = new AgentManager(new ConcurrencyPools(), {
      ...transport(host),
      createDeliverable: () => ({ readDeliverable: async () => report }),
    });
    built.setOnComplete((settled) => ended.push(settled.lifecycle.phase));

    built.attachLiveSpawns();
    await vi.advanceTimersByTimeAsync(4_500);

    expect(ended).toEqual(["settled"]);
    expect(built.getSpawn("aaaaaaaa")?.lifecycle).toMatchObject({
      phase: "settled",
      status: "completed",
      result: "the answer nobody saw",
    });
    built.dispose();
    vi.useRealTimers();
  });
});

describe("an attached run has no parent turn to inherit an interrupt from", () => {
  it("keeps running when an interrupt reaches a signal it was never given", async () => {
    const { host, stopCalls } = fakeHost();
    store.add(adoptedSpawn());
    // A signal the adopting session would stop a foreground run through. An
    // attached run is not bound to it: the turn that spawned the run ended, which
    // is what made its session go away, so there is no in-flight parent whose
    // interrupt this run should follow.
    const adoptingTurn = new AbortController();
    const session = SubagentSession.attach({
      spawn: store.get("aaaaaaaa")!,
      harness: "pi",
      deps: attachDeps(host),
    });

    adoptingTurn.abort();

    expect(session.isActive()).toBe(true);
    expect(stopCalls).toEqual([]);
    // Its stops are the explicit ones.
    await expect(session.abort("user")).resolves.toBe(true);
    expect(stopCalls.map((ref) => ref.paneId)).toEqual(["w1:p1"]);
    session.settleForDispose();
  });
});

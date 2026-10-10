/**
 * process-supervisor.test.ts — ProcessSupervisor execution engine.
 *
 * Fakes depend only on local structural contracts and are exported for the
 * smoke script's reuse.
 *
 * - REPORT-ONLY SETTLEMENT: only the subagent's own report settles a run — a
 *   held result deliverable — or stop().
 * - INTERRUPT-ONLY STOP: stop() NEVER closes the pane (closing it breaks later
 *   worktree removal); asserted across interrupt-success, interrupt-ignored,
 *   and already-gone paths.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ProcessSupervisorEngine,
  type SubagentLaunchPlan,
} from "../src/subagent/supervisor.js";
import type {
  AgentHost,
  AgentHostRef,
  DeliverOutcome,
  LiveAttempt,
} from "../src/agents/agent-host.js";
import type {
  DeliverableReport,
  DeliverableSource,
} from "../src/subagent/deliverable.js";
import type { StopInitiator } from "../src/types.js";

type AgentState = "idle" | "working" | "blocked" | "done" | "unknown";

/** Fake host observation (shape-compatible with HostObservation). */
interface AgentSnapshot {
  state: AgentState;
}

/** Host double: records the only calls the supervisor may make. */
class FakeAgentHost implements AgentHost {
  startCalls: Array<{
    ref: AgentHostRef;
    options: { name: string; piArgs: string[] };
  }> = [];
  stopCalls: Array<{
    ref: AgentHostRef;
    opts?: { interruptGraceMs?: number; confirmMs?: number };
  }> = [];
  hostAtCalls = 0;

  private observation: AgentSnapshot | undefined;
  private stopResult: boolean;
  findAttempts = vi.fn(async () => [] as LiveAttempt[]);

  constructor(
    options: {
      agent?: AgentSnapshot | (() => AgentSnapshot | undefined);
      stopResult?: boolean;
    } = {},
  ) {
    this.observation =
      typeof options.agent === "function" ? options.agent() : options.agent;
    this.stopResult = options.stopResult ?? true;
  }

  setObservation(agent: AgentSnapshot | undefined): void {
    this.observation = agent;
  }

  setStopResult(result: boolean): void {
    this.stopResult = result;
  }

  async hostAt(): Promise<AgentHostRef> {
    this.hostAtCalls += 1;
    return { ...REF };
  }

  async observe(): Promise<AgentSnapshot | undefined> {
    return this.observation === undefined ? undefined : { ...this.observation };
  }

  async start(
    ref: AgentHostRef,
    options: { name: string; piArgs: string[] },
  ): Promise<void> {
    this.startCalls.push({ ref, options });
  }

  async stop(
    ref: AgentHostRef,
    opts?: { interruptGraceMs?: number; confirmMs?: number },
  ): Promise<boolean> {
    this.stopCalls.push({ ref, opts });
    return this.stopResult;
  }

  async release(): Promise<boolean> {
    throw new Error("release is unused by the supervisor");
  }

  async isAttached(): Promise<boolean> {
    throw new Error("isAttached is unused by the supervisor");
  }

  async deliver(): Promise<DeliverOutcome> {
    throw new Error("deliver is unused by the supervisor");
  }
}

/** DeliverableSource double: a scripted report file whose every write moves its stamp. */
class FakeDeliverable implements DeliverableSource {
  /** Reads served so far, so a test can show the watch is still polling. */
  reads = 0;

  private content: string | null = null;
  private stamp = 0;

  /**
   * Write the run's result file. Every write moves the stamp, so a rewrite that
   * repeats the same words is still a report the engine has not seen.
   */
  set report(value: string | null) {
    this.content = value;
    this.stamp += 1;
  }
  get report(): string | null {
    return this.content;
  }

  async readDeliverable(): Promise<DeliverableReport | null> {
    this.reads += 1;
    if (this.content === null) return null;
    return { content: this.content, mtime: this.stamp };
  }
}

const PLAN: SubagentLaunchPlan = {
  name: "cow-smoke-deadbeef",
  cwd: "/tmp/wt",
  piArgs: ["-p", "@briefing.md"],
  taskSlug: "smoke",
};
const PANE = "w1:p1";
const REF: AgentHostRef = {
  engine: "herdr",
  name: "cow-smoke-deadbeef",
  paneId: PANE,
  tabId: "w1:t1",
  workspaceId: "w1",
  paneCreated: true,
};

const workingAgent: AgentSnapshot = {
  state: "working",
};

const doneAgent: AgentSnapshot = {
  state: "done",
};

interface Fixture {
  host: FakeAgentHost;
  deliverable: FakeDeliverable;
  supervisor: ProcessSupervisorEngine;
}

/** Supervisor wired to fakes; small pollMs keeps fake-timer arithmetic simple. */
function makeFixture(
  options: {
    pollMs?: number;
    stopInitiator?: StopInitiator;
    agent?: AgentSnapshot | (() => AgentSnapshot | undefined);
    stopResult?: boolean;
    onFollowUp?: (deliverable: string) => void;
  } = {},
): Fixture {
  const host = new FakeAgentHost({
    agent: options.agent,
    stopResult: options.stopResult,
  });
  const deliverable = new FakeDeliverable();
  const supervisor = new ProcessSupervisorEngine(host, deliverable, {
    pollMs: options.pollMs ?? 1_000,
    stopInitiator: options.stopInitiator,
    onFollowUp: options.onFollowUp,
  });
  return { host, deliverable, supervisor };
}

/** Advance `ticks` poll intervals; exact for these synchronously-resolving fakes. */
async function advancePolls(
  watchPromise: Promise<unknown>,
  ticks: number,
  pollMs = 1_000,
): Promise<"pending" | "settled"> {
  // A holder, not a `let`: the callback's write happens outside this scope, so
  // the read below must not be narrowed by it.
  const watch = { settled: false };
  void watchPromise.then(() => {
    watch.settled = true;
  });
  for (let tick = 0; tick < ticks; tick += 1) {
    await vi.advanceTimersByTimeAsync(pollMs);
  }
  return watch.settled ? "settled" : "pending";
}

describe("ProcessSupervisorEngine.start", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("launches the subagent process into the given pane", async () => {
    const { host, supervisor } = makeFixture();
    await supervisor.start(PLAN, REF);
    expect(host.startCalls).toEqual([
      { ref: REF, options: { name: PLAN.name, piArgs: PLAN.piArgs } },
    ]);
    // The host is the caller's: no creation, and the briefing already rides in piArgs.
    expect(host.hostAtCalls).toBe(0);
  });

  it("rejects a second start after a successful launch", async () => {
    const { supervisor } = makeFixture();
    await supervisor.start(PLAN, REF);
    await expect(supervisor.start(PLAN, REF)).rejects.toThrow(
      /once per supervisor/,
    );
  });

  it("reverts to idle after a failed launch so the caller may retry", async () => {
    const { host, supervisor } = makeFixture();
    host.setStopResult(true);
    const original = host.start.bind(host);
    host.start = async () => {
      throw new Error("host start failed");
    };
    await expect(supervisor.start(PLAN, REF)).rejects.toThrow(/start failed/);
    host.start = original;
    await supervisor.start(PLAN, REF);
    expect(host.startCalls).toHaveLength(1);
  });

  it("rejects watch() before start()", async () => {
    const { supervisor } = makeFixture();
    await expect(supervisor.watch()).rejects.toThrow(/start\(\) or adopt\(\)/);
  });
});

/** Adoption supervises an already-live run without launching (the revive seam); downstream behaves as after start(). */
describe("ProcessSupervisorEngine.adopt", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("supervises an already-spawned run without launching anything", async () => {
    const { host, deliverable, supervisor } = makeFixture({
      agent: workingAgent,
    });

    supervisor.adopt(REF);

    // The caller already owns the placement: no launch, no host lookup.
    expect(host.startCalls).toEqual([]);
    expect(host.hostAtCalls).toBe(0);
    const watchPromise = supervisor.watch();
    deliverable.report = "revived answer";
    expect(await advancePolls(watchPromise, 2)).toBe("settled");
    await expect(watchPromise).resolves.toMatchObject({
      kind: "completed",
      deliverable: "revived answer",
    });
    expect(host.startCalls).toEqual([]);
  });

  it("refuses a second adopt on the same instance", async () => {
    const { supervisor } = makeFixture({ agent: workingAgent });
    supervisor.adopt(REF);
    expect(() => supervisor.adopt(REF)).toThrow(/one run per supervisor/);
  });

  it("refuses to adopt after a launch", async () => {
    const { supervisor } = makeFixture({ agent: workingAgent });
    await supervisor.start(PLAN, REF);
    expect(() => supervisor.adopt(REF)).toThrow(/one run per supervisor/);
  });

  it("stops an adopted run and ends the watch with a stopped outcome", async () => {
    const { host, supervisor } = makeFixture({
      agent: workingAgent,
      stopInitiator: "user",
    });
    supervisor.adopt(REF);
    const watchPromise = supervisor.watch();
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(supervisor.stop(2_000)).resolves.toBe(true);

    await expect(watchPromise).resolves.toEqual({
      kind: "stopped",
      initiator: "user",
    });
    expect(host.stopCalls).toEqual([
      { ref: REF, opts: { interruptGraceMs: 2_000, confirmMs: 0 } },
    ]);
    // Interrupt-only: the supervisor never releases the placement.
    expect(host.startCalls).toEqual([]);
  });
});

describe("ProcessSupervisorEngine.watch — completed (report artifact)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves completed one confirm poll after the report, with the deliverable", async () => {
    const { deliverable, supervisor } = makeFixture({ agent: workingAgent });
    await supervisor.start(PLAN, REF);
    const watchPromise = supervisor.watch();
    let outcome: unknown = "pending";
    void watchPromise.then((o) => {
      outcome = o;
    });

    deliverable.report = "final answer";
    await vi.advanceTimersByTimeAsync(1_000);
    expect(outcome).toBe("pending");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(outcome).toEqual({
      kind: "completed",
      deliverable: "final answer",
    });
  });

  it("resolves completed when the report is already present at the first poll", async () => {
    const { deliverable, supervisor } = makeFixture({ agent: doneAgent });
    deliverable.report = "early finish";
    await supervisor.start(PLAN, REF);
    const watchPromise = supervisor.watch();
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(watchPromise).resolves.toMatchObject({
      kind: "completed",
      deliverable: "early finish",
    });
  });

  it("keeps holding while the report is being rewritten, and settles the stable rewrite", async () => {
    const { deliverable, supervisor } = makeFixture({ agent: doneAgent });
    await supervisor.start(PLAN, REF);
    const watchPromise = supervisor.watch();

    deliverable.report = "first draft";
    await vi.advanceTimersByTimeAsync(1_000);
    // A rewritten report is still being written, not final.
    deliverable.report = "second draft";
    expect(await advancePolls(watchPromise, 1)).toBe("pending");

    expect(await advancePolls(watchPromise, 1)).toBe("settled");
    await expect(watchPromise).resolves.toEqual({
      kind: "completed",
      deliverable: "second draft",
    });
  });

  it("does not settle a report that vanished during the confirm poll", async () => {
    const { deliverable, supervisor } = makeFixture({ agent: doneAgent });
    await supervisor.start(PLAN, REF);
    const watchPromise = supervisor.watch();

    deliverable.report = "draft";
    expect(await advancePolls(watchPromise, 1)).toBe("pending");
    // A rewrite removes the file first — the hold resets.
    deliverable.report = null;
    expect(await advancePolls(watchPromise, 3)).toBe("pending");

    deliverable.report = "final report";
    expect(await advancePolls(watchPromise, 2)).toBe("settled");
    await expect(watchPromise).resolves.toMatchObject({
      kind: "completed",
      deliverable: "final report",
    });
  });

  it("treats a whitespace-only report as no report", async () => {
    const { deliverable, supervisor } = makeFixture({ agent: doneAgent });
    deliverable.report = "   \n ";
    await supervisor.start(PLAN, REF);
    const watchPromise = supervisor.watch();
    expect(await advancePolls(watchPromise, 4)).toBe("pending");
    deliverable.report = "real answer";
    expect(await advancePolls(watchPromise, 2)).toBe("settled");
    await expect(watchPromise).resolves.toMatchObject({
      kind: "completed",
      deliverable: "real answer",
    });
  });
});

describe("ProcessSupervisorEngine.watch — herdr state is never a settlement input", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("never probes herdr at all: only the report or stop() settles a run", async () => {
    const { host, supervisor } = makeFixture({ agent: workingAgent });
    const observe = vi.fn(async () => ({ state: "done" as AgentState }));
    host.observe = observe;
    await supervisor.start(PLAN, REF);
    const watchPromise = supervisor.watch();
    expect(await advancePolls(watchPromise, 5)).toBe("pending");
    expect(observe).not.toHaveBeenCalled();
    expect(host.stopCalls).toEqual([]);
  });

  it("never settles because the agent sat idle without producing its report", async () => {
    const { host, deliverable, supervisor } = makeFixture({ agent: doneAgent });
    await supervisor.start(PLAN, REF);
    const watchPromise = supervisor.watch();
    deliverable.report = null;
    expect(await advancePolls(watchPromise, 30)).toBe("pending");
    // No idle watchdog may read a quiet pane as a stuck agent.
    expect(host.stopCalls).toEqual([]);
  });
});

describe("ProcessSupervisorEngine.watch — poll cadence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs one poll at a time, so a slow artifact read cannot stack polls", async () => {
    // Without one-poll-at-a-time the loop stacks ticks and the settlement
    // read queues behind the storm.
    const { deliverable, supervisor } = makeFixture({
      agent: workingAgent,
      pollMs: 10,
    });
    let readCalls = 0;
    let inFlight = 0;
    let peakInFlight = 0;
    const release: Array<() => void> = [];
    deliverable.readDeliverable = async () => {
      readCalls += 1;
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await new Promise<void>((resolve) => {
        release.push(() => {
          inFlight -= 1;
          resolve();
        });
      });
      return null;
    };
    await supervisor.start(PLAN, REF);
    const watchPromise = supervisor.watch();

    // Ten intervals with the first read still in flight: no second poll.
    await vi.advanceTimersByTimeAsync(100);
    expect(readCalls).toBe(1);

    release.shift()?.();
    await vi.advanceTimersByTimeAsync(10);
    expect(readCalls).toBe(2);
    expect(peakInFlight).toBe(1);

    release.shift()?.();
    await supervisor.stop(0);
    await expect(watchPromise).resolves.toEqual({
      kind: "stopped",
      initiator: "user",
    });
  });
});

describe("ProcessSupervisorEngine.watch — lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves immediately with the stored outcome when watch() is called after settlement", async () => {
    const { host, deliverable, supervisor } = makeFixture({
      agent: workingAgent,
    });
    await supervisor.start(PLAN, REF);
    const firstWatch = supervisor.watch();
    deliverable.report = "done";
    host.setObservation(doneAgent);
    await vi.advanceTimersByTimeAsync(2_000); // report + confirm
    await expect(firstWatch).resolves.toMatchObject({ kind: "completed" });
    // A post-settlement watch replays the outcome, never a throw.
    const replay = supervisor.watch();
    await expect(replay).resolves.toMatchObject({ kind: "completed" });
  });

  it("rejects a second watch while one is pending", async () => {
    const { supervisor } = makeFixture({ agent: workingAgent });
    await supervisor.start(PLAN, REF);
    const firstWatch = supervisor.watch();
    await expect(supervisor.watch()).rejects.toThrow(/already active/);
    expect(firstWatch).toBeDefined();
  });
});

describe("ProcessSupervisorEngine.stop — interrupt-only, never closes the pane", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("never closes the surface across interrupt-success, interrupt-ignored, and already-gone paths", async () => {
    // Every stop path must leave the pane alive for the worktree removal after stop.
    const sharedHost = new FakeAgentHost({ agent: workingAgent });
    const sharedDeliverable = new FakeDeliverable();

    sharedHost.setObservation(workingAgent);
    sharedHost.setStopResult(true);
    const a = new ProcessSupervisorEngine(sharedHost, sharedDeliverable, {
      pollMs: 1_000,
    });
    await a.start(PLAN, REF);
    const watchA = a.watch();
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(a.stop(8_000)).resolves.toBe(true);
    await expect(watchA).resolves.toEqual({
      kind: "stopped",
      initiator: "user",
    });

    const b = new ProcessSupervisorEngine(sharedHost, sharedDeliverable, {
      pollMs: 1_000,
    });
    await b.start(PLAN, REF);
    const watchB = b.watch();
    sharedHost.setStopResult(false);
    await expect(b.stop(8_000)).resolves.toBe(false);
    await expect(watchB).resolves.toEqual({
      kind: "stopped",
      initiator: "user",
    });

    sharedHost.setObservation(undefined);
    sharedHost.setStopResult(true);
    const c = new ProcessSupervisorEngine(sharedHost, sharedDeliverable, {
      pollMs: 1_000,
    });
    await c.start(PLAN, REF);
    const watchC = c.watch();
    await expect(c.stop(8_000)).resolves.toBe(true);
    await expect(watchC).resolves.toEqual({
      kind: "stopped",
      initiator: "user",
    });

    // Interrupt-only with confirmMs 0 throughout: host.stop cannot close a surface.
    expect(sharedHost.stopCalls).toHaveLength(3);
    expect(sharedHost.stopCalls[0].opts).toEqual({
      confirmMs: 0,
      interruptGraceMs: 8_000,
    });
    expect(sharedHost.stopCalls[1].opts).toEqual({
      confirmMs: 0,
      interruptGraceMs: 8_000,
    });
    expect(sharedHost.stopCalls[2].opts).toEqual({
      confirmMs: 0,
      interruptGraceMs: 8_000,
    });
  });

  it("passes the grace window through as interruptGraceMs with confirmMs 0", async () => {
    const { host, supervisor } = makeFixture({ agent: workingAgent });
    await supervisor.start(PLAN, REF);
    await supervisor.stop(2_500);
    expect(host.stopCalls).toEqual([
      {
        ref: REF,
        opts: { interruptGraceMs: 2_500, confirmMs: 0 },
      },
    ]);
  });

  it("carries the configured stopInitiator on the stopped outcome", async () => {
    const { supervisor } = makeFixture({
      agent: workingAgent,
      stopInitiator: "agent",
    });
    await supervisor.start(PLAN, REF);
    const watchPromise = supervisor.watch();
    await supervisor.stop(8_000);
    await expect(watchPromise).resolves.toEqual({
      kind: "stopped",
      initiator: "agent",
    });
  });

  it("returns false on a never-started supervisor", async () => {
    const { supervisor } = makeFixture();
    await expect(supervisor.stop(8_000)).resolves.toBe(false);
  });

  it("returns false after a completed settlement and leaves the completed outcome", async () => {
    const { host, deliverable, supervisor } = makeFixture({
      agent: workingAgent,
    });
    await supervisor.start(PLAN, REF);
    const watchPromise = supervisor.watch();
    deliverable.report = "finished";
    host.setObservation(doneAgent);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(watchPromise).resolves.toMatchObject({ kind: "completed" });
    await expect(supervisor.stop(8_000)).resolves.toBe(false);
  });
});

/**
 * Disposal-only exit for a discarded parent session (`/new`, `/reload`, `/fork`):
 * clear the timer (else a `herdr agent get` loop runs in the old process
 * forever), deliver NO outcome to watch(), stop nothing, keep the artifacts.
 * Idempotent; a no-op after finalize().
 */
describe("ProcessSupervisorEngine.abandon — disposal only, never a settlement", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function countReads(deliverable: FakeDeliverable): () => number {
    let calls = 0;
    const read = deliverable.readDeliverable.bind(deliverable);
    deliverable.readDeliverable = async () => {
      calls += 1;
      return read();
    };
    return () => calls;
  }

  it("clears the poll interval: no further artifact read happens after abandon", async () => {
    const { deliverable, supervisor } = makeFixture({ agent: workingAgent });
    const reads = countReads(deliverable);
    await supervisor.start(PLAN, REF);
    void supervisor.watch();

    await vi.advanceTimersByTimeAsync(2_000);
    expect(reads()).toBe(2);
    expect(vi.getTimerCount()).toBe(1); // the poll interval

    supervisor.abandon();
    // Gone, not merely neutered: nothing is left to fire.
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(reads()).toBe(2);
  });

  it("never delivers a settlement to watch(): the promise stays pending with no cleanup", async () => {
    const { deliverable, supervisor } = makeFixture({ agent: doneAgent });
    deliverable.report = "# final answer";
    await supervisor.start(PLAN, REF);
    const watchPromise = supervisor.watch();

    expect(await advancePolls(watchPromise, 1)).toBe("pending");
    supervisor.abandon();
    expect(await advancePolls(watchPromise, 10)).toBe("pending");
  });

  it("does not stop the process: the pane keeps running", async () => {
    const { host, supervisor } = makeFixture({ agent: workingAgent });
    await supervisor.start(PLAN, REF);
    void supervisor.watch();
    await vi.advanceTimersByTimeAsync(1_000);

    supervisor.abandon();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(host.stopCalls).toEqual([]);
  });

  it("is idempotent, and ends a settled run's still-live watch", async () => {
    const { host, deliverable, supervisor } = makeFixture({ agent: doneAgent });
    deliverable.report = "done";
    await supervisor.start(PLAN, REF);
    const watchPromise = supervisor.watch();
    expect(await advancePolls(watchPromise, 2)).toBe("settled");
    await expect(watchPromise).resolves.toMatchObject({ kind: "completed" });
    // Settlement does not end the watch: the loop is still polling for reports.
    expect(vi.getTimerCount()).toBe(1);

    expect(() => supervisor.abandon()).not.toThrow();
    expect(() => supervisor.abandon()).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
    await expect(watchPromise).resolves.toMatchObject({ kind: "completed" });
    expect(host.stopCalls).toEqual([]);
  });

  it("is idempotent and safe when called twice mid-run", async () => {
    const { host, deliverable, supervisor } = makeFixture({
      agent: workingAgent,
    });
    const reads = countReads(deliverable);
    await supervisor.start(PLAN, REF);
    void supervisor.watch();

    supervisor.abandon();
    supervisor.abandon();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(reads()).toBe(0);
    expect(host.stopCalls).toEqual([]);
  });

  it("settles nothing even when an in-flight poll completes after abandon", async () => {
    const { host, deliverable, supervisor } = makeFixture({
      agent: workingAgent,
    });
    deliverable.report = "done";
    // Park the first poll inside the artifact read, as a slow filesystem would.
    let releasePoll: (() => void) | undefined;
    deliverable.readDeliverable = async () =>
      new Promise<DeliverableReport | null>((resolve) => {
        releasePoll = () => resolve({ content: "done", mtime: 1 });
      });
    await supervisor.start(PLAN, REF);
    const watchPromise = supervisor.watch();

    vi.advanceTimersByTime(1_000); // the tick now awaits the read
    supervisor.abandon();
    releasePoll?.();

    expect(await advancePolls(watchPromise, 5)).toBe("pending");
    expect(host.stopCalls).toEqual([]);
  });
});

/**
 * A settled run keeps its pane, so the same watch keeps polling it: a later
 * report is news for the caller rather than a second settlement.
 */
describe("ProcessSupervisorEngine.watch — reports after settlement", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A fixture whose follow-ups land in the returned list. */
  function followUpFixture(): Fixture & { followUps: string[] } {
    const followUps: string[] = [];
    return {
      ...makeFixture({
        onFollowUp: (deliverable) => followUps.push(deliverable),
      }),
      followUps,
    };
  }

  it("delivers a later turn's report as a follow-up, leaving the outcome untouched", async () => {
    const { deliverable, supervisor, followUps } = followUpFixture();
    await supervisor.start(PLAN, REF);
    const watchPromise = supervisor.watch();

    deliverable.report = "first answer";
    expect(await advancePolls(watchPromise, 2)).toBe("settled");
    await expect(watchPromise).resolves.toEqual({
      kind: "completed",
      deliverable: "first answer",
    });
    expect(followUps).toEqual([]);

    // The run kept working in its pane: the same watch finds the new report.
    deliverable.report = "and one more thing";
    await vi.advanceTimersByTimeAsync(2_000);
    expect(followUps).toEqual(["and one more thing"]);
    // The run stays settled: a follow-up never rewrites the outcome.
    await expect(watchPromise).resolves.toEqual({
      kind: "completed",
      deliverable: "first answer",
    });
  });

  it("treats a rewritten report of the same words as a follow-up", async () => {
    const { deliverable, supervisor, followUps } = followUpFixture();
    await supervisor.start(PLAN, REF);
    void supervisor.watch();
    deliverable.report = "same words";
    await vi.advanceTimersByTimeAsync(2_000);

    deliverable.report = "same words";
    await vi.advanceTimersByTimeAsync(2_000);
    expect(followUps).toEqual(["same words"]);
  });

  it("never repeats a report it already delivered", async () => {
    const { deliverable, supervisor, followUps } = followUpFixture();
    await supervisor.start(PLAN, REF);
    void supervisor.watch();
    deliverable.report = "the only answer";
    // Well past settlement: the unchanged file is read over and over.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(followUps).toEqual([]);
  });

  it("reports nothing more once detach() ends the watch", async () => {
    const { deliverable, supervisor, followUps } = followUpFixture();
    await supervisor.start(PLAN, REF);
    void supervisor.watch();
    deliverable.report = "first answer";
    await vi.advanceTimersByTimeAsync(2_000);

    supervisor.detach();
    expect(vi.getTimerCount()).toBe(0);
    deliverable.report = "too late";
    await vi.advanceTimersByTimeAsync(10_000);
    expect(followUps).toEqual([]);
  });
});
